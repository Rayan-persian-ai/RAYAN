import { AgentRegistry, AgentRouter, type AgentManifest } from './agents.js';
import { CostController } from './cost.js';
import { AuditLogger, EventBus } from './events.js';
import { EvaluationEngine, type EvaluationResult } from './evaluation.js';
import { ExecutionEngine, type ExecutionOptions, type ExecutionResult, type StepExecutor, type StepOutcome } from './execution.js';
import { PromptGuard, type GuardFlag } from './guard.js';
import { IntentEngine, type IntentResult } from './intent.js';
import { MemoryManager } from './memory.js';
import { ModelRouter, type ModelTask } from './models.js';
import { PermissionManager, type ApprovalRequest } from './permissions.js';
import { TaskPlanner, type Plan, type PlanStep } from './planner.js';
import { ToolRegistry, type ToolResult } from './tools.js';
import { CortexError, type Intent, type LLMFunction, type UserContext } from './types.js';
import { newId } from './util.js';
import { detectLanguage } from './text.js';

export interface CortexRequest {
  text: string;
  /** Per-tool inputs keyed by tool name, merged into every step that uses that tool. */
  toolInputs?: Record<string, unknown>;
  expectedLanguage?: 'fa' | 'en';
}

export type CortexStatus = 'completed' | 'partial' | 'awaiting_approval' | 'failed' | 'cancelled' | 'rejected';

export interface CortexReport {
  requestId: string;
  status: CortexStatus;
  intent: IntentResult;
  plan?: Plan;
  execution?: ExecutionResult;
  evaluation?: EvaluationResult;
  output: string;
  approvals: ApprovalRequest[];
  guardFlags: GuardFlag[];
  errors: string[];
  durationMs: number;
}

export interface CortexDeps {
  bus: EventBus;
  audit: AuditLogger;
  guard: PromptGuard;
  intent: IntentEngine;
  planner: TaskPlanner;
  agents: AgentRegistry;
  router: AgentRouter;
  permissions: PermissionManager;
  cost: CostController;
  tools: ToolRegistry;
  models: ModelRouter;
  memory: MemoryManager;
  execution: ExecutionEngine;
  evaluation: EvaluationEngine;
  /** LLM used for step generation via ModelRouter. Without it, steps return tool outputs only. */
  llm?: LLMFunction;
  executionOptions?: ExecutionOptions;
  /** Override how a single step runs. */
  stepExecutor?: StepExecutor;
}

/** Model needs per intent. */
const INTENT_MODEL_NEEDS: Record<Intent, ModelTask['needs']> = {
  chat: { persian: 1, speed: 1 },
  code: { coding: 1, reasoning: 0.5 },
  research: { reasoning: 1, persian: 0.7, longContext: 0.5 },
  content: { persian: 1, reasoning: 0.3 },
  image: { persian: 0.5, speed: 0.5 },
  automation: { reasoning: 1, coding: 0.5 },
  admin: { reasoning: 1 },
  analysis: { reasoning: 1, coding: 0.5 },
};

/**
 * Facade: handle(request, user) → guard → intent → plan → route agents → execute → evaluate → report.
 * User-supplied text is user intent; tool/web outputs are untrusted data and are wrapped before any
 * model sees them. Permissions come only from manifests + policy, never from content.
 */
export class Cortex {
  constructor(readonly deps: CortexDeps) {}

  async handle(request: CortexRequest, user: UserContext, opts: { signal?: AbortSignal } = {}): Promise<CortexReport> {
    const t0 = Date.now();
    const requestId = newId('req');
    const { bus, audit, guard } = this.deps;
    const meta = { traceId: requestId, userId: user.userId };
    const errors: string[] = [];
    if (!user?.userId) throw new CortexError('no_user', 'userId is required');
    const text = String(request.text ?? '').slice(0, 20_000);
    bus.emit('request.received', { requestId, length: text.length }, meta);

    // User text is the user's own instruction, but injection-style content is still flagged/audited.
    const g = guard.inspect(text);
    if (g.flags.length) bus.emit('guard.flagged', { source: 'user_request', flags: g.flags.map((f) => f.rule) }, meta);

    const intent = await this.deps.intent.classify(text, { signal: opts.signal });
    bus.emit('intent.classified', { intent: intent.intent, confidence: intent.confidence, source: intent.source }, meta);

    const base = { requestId, intent, approvals: [] as ApprovalRequest[], guardFlags: g.flags, errors };
    const done = async (r: Omit<CortexReport, 'durationMs' | keyof typeof base> & Partial<typeof base>): Promise<CortexReport> => {
      const report: CortexReport = { ...base, ...r, durationMs: Date.now() - t0 };
      await audit.log({ userId: user.userId, actor: 'cortex', action: 'request.handled', target: requestId, decision: 'info', details: { status: report.status, intent: intent.intent, score: report.evaluation?.score } });
      bus.emit('request.completed', { requestId, status: report.status }, meta);
      return report;
    };

    let plan: Plan;
    try {
      plan = await this.deps.planner.plan(text, intent.intent, { signal: opts.signal, locale: user.locale ?? (detectLanguage(text) === 'en' ? 'en' : 'fa') });
    } catch (e) {
      errors.push(`planning failed: ${e instanceof Error ? e.message : String(e)}`);
      return done({ status: 'failed', output: '' });
    }

    // Route each step to an agent.
    for (const step of plan.steps) {
      const r = this.deps.router.pick({ capability: step.capability, toolNames: step.toolNames, preferredSlug: step.agentSlug });
      if (!r) {
        errors.push(`no enabled agent for step "${step.id}" (capability ${step.capability}${step.toolNames.length ? `, tools ${step.toolNames.join(',')}` : ''})`);
        step.agentSlug = null;
      } else step.agentSlug = r.agent.slug;
    }
    bus.emit('plan.created', { planId: plan.id, steps: plan.steps.map((s) => ({ id: s.id, agent: s.agentSlug, deps: s.dependsOn })) }, meta);
    if (plan.steps.some((s) => !s.agentSlug)) return done({ status: 'failed', plan, output: '' });

    const executor = this.deps.stepExecutor ?? this.defaultStepExecutor(request, text, intent.intent);
    const execution = await this.deps.execution.run(plan, executor, { user, signal: opts.signal, traceId: requestId }, this.deps.executionOptions);
    for (const st of Object.values(execution.steps)) {
      if (st.error && st.status !== 'succeeded') errors.push(`${st.id}: ${st.error}`);
      const slug = plan.steps.find((s) => s.id === st.id)?.agentSlug;
      if (slug && (st.status === 'succeeded' || st.status === 'failed')) this.deps.router.recordOutcome(slug, st.status === 'succeeded');
    }
    const approvals = Object.values(execution.steps).flatMap((s) => s.approvals ?? []);

    // Final output = outputs of sink steps (no dependents), in topological order.
    const depended = new Set(plan.steps.flatMap((s) => s.dependsOn));
    const output = execution.order
      .filter((id) => !depended.has(id))
      .map((id) => outputText(execution.steps[id]?.output))
      .filter(Boolean)
      .join('\n\n');

    const evaluation = output
      ? await this.deps.evaluation.evaluate({ output, task: text, expectedLanguage: request.expectedLanguage }, { signal: opts.signal })
      : undefined;

    // Short-term memory of the exchange (only when a session is present).
    if (user.sessionId) {
      try {
        await this.deps.memory.forUser(user).put('short-term', `turn:${requestId}`, { request: text.slice(0, 2000), intent: intent.intent, output: output.slice(0, 4000), status: execution.status });
      } catch (e) {
        errors.push(`memory write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const status: CortexStatus =
      execution.status === 'succeeded' ? 'completed' : execution.status === 'awaiting_approval' ? 'awaiting_approval' : execution.status;
    return done({ status, plan, execution, evaluation, output, approvals });
  }

  /** Approve a pending action; re-send the same request afterwards to execute it (grant is single-use). */
  approve(approvalId: string, approver: UserContext) {
    const a = this.deps.permissions.approve(approvalId, approver);
    void this.deps.audit.log({ userId: approver.userId, actor: approver.userId, action: 'approval.granted', target: a.action, decision: 'allowed', details: { approvalId, level: a.level } });
    return a;
  }

  reject(approvalId: string, approver: UserContext) {
    const a = this.deps.permissions.reject(approvalId, approver);
    void this.deps.audit.log({ userId: approver.userId, actor: approver.userId, action: 'approval.rejected', target: a.action, decision: 'denied', details: { approvalId } });
    return a;
  }

  private defaultStepExecutor(request: CortexRequest, text: string, intent: Intent): StepExecutor {
    return async (step, ctx): Promise<StepOutcome> => {
      const agent = this.deps.agents.get(step.agentSlug ?? '');
      if (!agent || !agent.enabled) throw new CortexError('agent_unavailable', `agent ${step.agentSlug} unavailable`, { retryable: false });
      const toolResults: Record<string, unknown> = {};
      const toolFlags: Record<string, GuardFlag[]> = {};
      const approvals: ApprovalRequest[] = [];
      for (const toolName of step.toolNames) {
        const input = request.toolInputs?.[toolName] ?? { query: (step.input?.goal as string | undefined) ?? text };
        const r: ToolResult = await this.deps.tools.execute(toolName, input, { user: ctx.user, agent, signal: ctx.signal, traceId: ctx.traceId });
        switch (r.status) {
          case 'ok':
            toolResults[toolName] = r.output;
            if (r.flags.length) toolFlags[toolName] = r.flags;
            break;
          case 'approval_required':
            approvals.push(r.approval);
            break;
          case 'denied':
            throw new CortexError('tool_denied', r.reason, { retryable: false });
          case 'invalid_input':
            throw new CortexError('tool_invalid_input', `${toolName}: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, { retryable: false });
          case 'error':
            throw new CortexError(r.code, `${toolName}: ${r.error}`, { retryable: r.retryable });
        }
      }
      if (approvals.length) return { status: 'approval_required', approvals, partialOutput: { toolResults } };
      if (!this.deps.llm) return { status: 'ok', output: { text: '', toolResults, agent: agent.slug } };
      const prompt = this.buildStepPrompt(step, agent, text, ctx.inputs, toolResults, toolFlags);
      const run = await this.deps.models.run(
        { needs: INTENT_MODEL_NEEDS[step.intent ?? intent] },
        (model) => this.deps.llm!({ system: prompt.system, prompt: prompt.user, model: model.id, signal: ctx.signal }),
        { signal: ctx.signal },
      );
      return { status: 'ok', output: { text: run.result, toolResults, agent: agent.slug, model: run.model } };
    };
  }

  private buildStepPrompt(step: PlanStep, agent: AgentManifest, goal: string, inputs: Record<string, unknown>, toolResults: Record<string, unknown>, toolFlags: Record<string, GuardFlag[]> = {}) {
    const g = this.deps.guard;
    const parts: string[] = [`<goal>\n${goal}\n</goal>`, `<subtask id="${step.id}">${step.title}</subtask>`];
    for (const [dep, out] of Object.entries(inputs)) parts.push(g.wrap(outputText(out) || JSON.stringify(out ?? null), `step:${dep}`));
    for (const [tool, out] of Object.entries(toolResults)) parts.push(g.wrap(g.untrusted(typeof out === 'string' ? out : JSON.stringify(out), `tool:${tool}`, toolFlags[tool])));
    return {
      system: `You are ${agent.name_en ?? agent.slug} (${agent.name_fa}), a RAYAN agent. Complete only the subtask. Answer in the user's language (default Persian). ${PromptGuard.SYSTEM_NOTICE}`,
      user: parts.join('\n\n'),
    };
  }
}

function outputText(out: unknown): string {
  if (out === undefined || out === null) return '';
  if (typeof out === 'string') return out;
  if (typeof out === 'object' && typeof (out as { text?: unknown }).text === 'string') return (out as { text: string }).text;
  return '';
}

export interface CreateCortexOptions extends Partial<Omit<CortexDeps, 'llm'>> {
  llm?: LLMFunction;
  /** Use the LLM for intent classification / planning as well (default true when llm given). */
  llmForIntent?: boolean;
  llmForPlanning?: boolean;
  llmJudge?: boolean;
}

/** Wire a Cortex with sensible in-memory defaults; pass any dependency to override it. */
export function createCortex(o: CreateCortexOptions = {}): Cortex {
  const bus = o.bus ?? new EventBus();
  const audit = o.audit ?? new AuditLogger();
  const guard = o.guard ?? new PromptGuard();
  const permissions = o.permissions ?? new PermissionManager();
  const cost = o.cost ?? new CostController();
  const agents = o.agents ?? new AgentRegistry();
  const intent = o.intent ?? new IntentEngine({ llm: o.llm && o.llmForIntent !== false ? o.llm : undefined });
  return new Cortex({
    bus,
    audit,
    guard,
    permissions,
    cost,
    agents,
    intent,
    planner: o.planner ?? new TaskPlanner({ llm: o.llm && o.llmForPlanning ? o.llm : undefined, classifySegment: (seg) => intent.classifyByKeywords(seg).intent }),
    router: o.router ?? new AgentRouter(agents),
    tools: o.tools ?? new ToolRegistry({ permissions, cost, guard, bus, audit }),
    models: o.models ?? new ModelRouter({ cost, bus }),
    memory: o.memory ?? new MemoryManager(),
    execution: o.execution ?? new ExecutionEngine(bus),
    evaluation: o.evaluation ?? new EvaluationEngine({ judge: o.llm && o.llmJudge ? o.llm : undefined }),
    llm: o.llm,
    executionOptions: o.executionOptions,
    stepExecutor: o.stepExecutor,
  });
}
