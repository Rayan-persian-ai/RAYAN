import type { AgentManifest } from './agents.js';
import type { CostController } from './cost.js';
import type { AuditLogger, EventBus } from './events.js';
import { PromptGuard, sanitizeUntrustedValue, type GuardFlag } from './guard.js';
import type { ApprovalRequest, PermissionManager } from './permissions.js';
import { CortexError, type AutonomyLevel, type RiskLevel, type UserContext } from './types.js';
import { withTimeout } from './util.js';
import type { Issue, Schema } from './validator.js';

export interface ToolContext {
  user: UserContext;
  agent: AgentManifest;
  signal: AbortSignal;
  traceId?: string;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  input: Schema<I>;
  /** Permission tags the calling agent must ALL hold (e.g. 'net:read', 'fs:write', 'admin'). */
  permissions: string[];
  risk: RiskLevel;
  /** Explicit autonomy level, combined with risk (strictest wins). */
  level?: AutonomyLevel;
  /** Output comes from outside (web, files, third parties) → sanitised + flagged as untrusted. Default true. */
  untrustedOutput?: boolean;
  timeoutMs?: number;
  /** CostController service charged once per call. */
  costService?: string;
  costUnits?: number;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

export type ToolResult<O = unknown> =
  | { status: 'ok'; tool: string; output: O; untrusted: boolean; flags: GuardFlag[]; durationMs: number }
  | { status: 'denied'; tool: string; reason: string }
  | { status: 'invalid_input'; tool: string; issues: Issue[] }
  | { status: 'approval_required'; tool: string; approval: ApprovalRequest }
  | { status: 'error'; tool: string; error: string; code: string; retryable: boolean };

const NAME = /^[a-z][a-z0-9_.-]{0,79}$/;

export interface ToolRegistryDeps {
  permissions?: PermissionManager;
  cost?: CostController;
  guard?: PromptGuard;
  bus?: EventBus;
  audit?: AuditLogger;
  defaultTimeoutMs?: number;
}

/**
 * Tool catalogue + gatekeeper. execute() enforces, in order: tool exists → agent allow-list →
 * agent permission tags ⊇ tool tags → input schema → autonomy decision (may return an approval
 * request) → quota → run with timeout → sanitise untrusted output.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>();
  private readonly guard: PromptGuard;
  constructor(private readonly deps: ToolRegistryDeps = {}) {
    this.guard = deps.guard ?? new PromptGuard();
  }

  register<I, O>(def: ToolDefinition<I, O>): this {
    if (!NAME.test(def.name)) throw new Error(`invalid tool name "${def.name}"`);
    if (this.tools.has(def.name)) throw new Error(`tool "${def.name}" already registered`);
    if (!Array.isArray(def.permissions)) throw new Error('permissions must be an array');
    this.tools.set(def.name, Object.freeze({ ...def }));
    return this;
  }

  get(name: string) {
    return this.tools.get(name);
  }
  list(): { name: string; description: string; permissions: string[]; risk: RiskLevel }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, permissions: [...t.permissions], risk: t.risk }));
  }

  /** Static check without running: can this agent ever call this tool? */
  canUse(agent: AgentManifest, name: string): { ok: true } | { ok: false; reason: string } {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, reason: `unknown tool "${name}"` };
    if (!agent.enabled) return { ok: false, reason: `agent "${agent.slug}" is disabled` };
    if (!agent.allowedTools.includes(name)) return { ok: false, reason: `agent "${agent.slug}" is not allowed to use "${name}"` };
    const missing = tool.permissions.filter((p) => !agent.permissions.includes(p));
    if (missing.length) return { ok: false, reason: `agent "${agent.slug}" lacks permission(s): ${missing.join(', ')}` };
    return { ok: true };
  }

  async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { bus, audit } = this.deps;
    const meta = { traceId: ctx.traceId, userId: ctx.user.userId };
    const finish = async (r: ToolResult): Promise<ToolResult> => {
      bus?.emit(`tool.${r.status}`, { tool: name, agent: ctx.agent.slug }, meta);
      await audit?.log({
        userId: ctx.user.userId,
        actor: ctx.agent.slug,
        action: 'tool.execute',
        target: name,
        decision: r.status === 'ok' || r.status === 'error' ? 'allowed' : r.status === 'approval_required' ? 'approval_required' : 'denied',
        details: { status: r.status, ...(r.status === 'denied' ? { reason: r.reason } : {}), ...(r.status === 'error' ? { error: r.error } : {}) },
      });
      return r;
    };

    const can = this.canUse(ctx.agent, name);
    if (!can.ok) return finish({ status: 'denied', tool: name, reason: can.reason });
    const tool = this.tools.get(name)!;

    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) return finish({ status: 'invalid_input', tool: name, issues: parsed.issues });

    if (this.deps.permissions) {
      const d = this.deps.permissions.decide(ctx.user, ctx.agent, { name, risk: tool.risk, level: tool.level, input: parsed.data });
      if (d.outcome === 'approval_required') return finish({ status: 'approval_required', tool: name, approval: d.approval });
    } else if (tool.risk !== 'low' || (tool.level && tool.level !== 'automatic')) {
      // Fail closed: without a PermissionManager only low-risk automatic tools may run.
      return finish({ status: 'denied', tool: name, reason: 'no PermissionManager configured for non-automatic tool' });
    }

    if (tool.costService) {
      if (!this.deps.cost) return finish({ status: 'denied', tool: name, reason: 'tool has a cost service but no CostController is configured' });
      try {
        await this.deps.cost.consume(tool.costService, tool.costUnits ?? 1);
      } catch (e) {
        const err = e as CortexError;
        return finish({ status: 'error', tool: name, error: err.message, code: err.code ?? 'quota_exceeded', retryable: false });
      }
    }

    const started = Date.now();
    try {
      const out = await withTimeout((signal) => tool.handler(parsed.data, { ...ctx, signal }), tool.timeoutMs ?? this.deps.defaultTimeoutMs ?? 30_000, ctx.signal, `tool ${name}`);
      const untrusted = tool.untrustedOutput !== false;
      if (!untrusted) return finish({ status: 'ok', tool: name, output: out, untrusted, flags: [], durationMs: Date.now() - started });
      const { value, flags } = sanitizeUntrustedValue(this.guard, out, `tool:${name}`);
      if (flags.length) bus?.emit('guard.flagged', { tool: name, flags: flags.map((f) => f.rule) }, meta);
      return finish({ status: 'ok', tool: name, output: value, untrusted, flags, durationMs: Date.now() - started });
    } catch (e) {
      const err = e instanceof CortexError ? e : new CortexError('tool_error', e instanceof Error ? e.message : String(e), { retryable: true });
      return finish({ status: 'error', tool: name, error: err.message, code: err.code, retryable: err.retryable });
    }
  }
}
