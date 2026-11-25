/**
 * Wiring of @rayan/cortex into the API.
 *
 *  - LLM: the injected AiProvider (Workers AI in production, a mock in tests). Every model call reserves one unit
 *    from the EXISTING cost controller (usage_counters / AI_DAILY_LIMIT) and honours the ai_enabled kill switch.
 *  - Agents: the existing D1 `agents` registry (enabled flag + manifest permissions). Capabilities/tools are a
 *    static, reviewed profile per slug; permission tags are never widened beyond the manifest.
 *  - Memory: D1MemoryAdapter (cortex_memory), always scoped to the authenticated user id.
 *  - Approvals: guarded/restricted tool calls become rows in cortex_approvals. Approved grants are claimed
 *    atomically (single use) at the start of the next run of the same goal.
 */
import {
  AgentRegistry,
  AuditLogger,
  CortexError,
  CostController,
  D1AuditStore,
  D1MemoryAdapter,
  IntentEngine,
  MemoryManager,
  ModelRouter,
  PermissionManager,
  ToolRegistry,
  createCortex,
  s,
  type ActionDescriptor,
  type AgentManifest,
  type ApprovalRequest,
  type CortexReport,
  type D1DatabaseLike,
  type Intent,
  type IntentResult,
  type LLMFunction,
  type PermissionDecision,
  type UserContext,
} from "@rayan/cortex";
import { ERRORS_FA, type Role } from "@rayan/shared";
import type { AppDeps } from "../deps";
import type { Env } from "../env";
import { DEFAULT_AI_MODEL, PERSIAN_SYSTEM_PROMPT } from "./ai";
import { AI_SERVICE, envAiLimit, getUsage, reserveUsage } from "./cost";
import { ApiError } from "./errors";
import { isFlagEnabled } from "./flags";
import { writeAudit } from "./audit";

export const asD1 = (db: D1Database) => db as unknown as D1DatabaseLike;

/** Max characters sent to the model per cortex step (system + prompt) — bounds neurons per call. */
const MAX_PROMPT_CHARS = 6000;

/** Cortex role names for our RBAC roles. 'owner' may approve restricted actions (super_admin only). */
export function cortexRoles(roles: readonly Role[]): string[] {
  const out = new Set<string>(["user"]);
  if (roles.includes("admin") || roles.includes("super_admin")) out.add("admin");
  if (roles.includes("super_admin")) out.add("owner");
  return [...out];
}

interface AgentProfile {
  capabilities: string[];
  allowedTools?: string[];
  priority?: number;
}

/**
 * Reviewed capability/tool profile per registry slug. A tool is only listed when the agent's manifest already
 * holds every permission tag the tool requires (checked again at execution time by ToolRegistry).
 */
export const AGENT_PROFILES: Record<string, AgentProfile> = {
  "ai-ceo": { capabilities: ["chat.*", "analysis.*", "automation.*", "admin.*"], allowedTools: ["admin.read", "admin.write", "scheduler.create"], priority: -10 },
  content: { capabilities: ["content.*", "chat.respond"] },
  marketing: { capabilities: ["content.*", "automation.design"] },
  research: { capabilities: ["research.*"], allowedTools: ["web.search", "web.fetch"] },
  seo: { capabilities: ["research.*", "content.edit"], allowedTools: ["web.search", "web.fetch"] },
  "customer-support": { capabilities: ["chat.*"] },
  "software-engineer": { capabilities: ["code.*"] },
  "backend-engineer": { capabilities: ["code.*"] },
  "frontend-engineer": { capabilities: ["code.*"] },
  "qa-engineer": { capabilities: ["code.test", "code.review"] },
  cto: { capabilities: ["code.analyze", "code.review"] },
  "security-engineer": { capabilities: ["code.review"] },
  "database-engineer": { capabilities: ["code.*", "analysis.collect"] },
  "devops-engineer": { capabilities: ["automation.design", "automation.verify"] },
  "data-analyst": { capabilities: ["analysis.*"] },
  finance: { capabilities: ["analysis.*"] },
  "product-manager": { capabilities: ["analysis.report", "automation.design"] },
  "graphic-design": { capabilities: ["image.prompt"] },
  hr: { capabilities: ["chat.respond"] },
  sales: { capabilities: ["chat.respond"] },
};

interface AgentDbRow {
  slug: string;
  name_fa: string;
  name_en: string;
  description: string;
  permissions: string;
  enabled: number;
  version: string;
}

export async function loadAgentRegistry(db: D1Database): Promise<AgentRegistry> {
  const { results } = await db
    .prepare("SELECT slug, name_fa, name_en, description, permissions, enabled, version FROM agents")
    .all<AgentDbRow>();
  const reg = new AgentRegistry();
  for (const r of results) {
    const profile = AGENT_PROFILES[r.slug];
    if (!profile) continue; // unknown agents have no reviewed capability profile → not routable
    let permissions: string[] = [];
    try {
      permissions = JSON.parse(r.permissions) as string[];
    } catch {
      continue;
    }
    reg.upsert({
      slug: r.slug,
      name_fa: r.name_fa,
      name_en: r.name_en,
      description: r.description.slice(0, 2000),
      capabilities: profile.capabilities,
      allowedTools: profile.allowedTools ?? [],
      permissions,
      enabled: r.enabled === 1,
      priority: profile.priority ?? 0,
      version: r.version,
    } satisfies AgentManifest);
  }
  return reg;
}

export interface CortexRuntimeDeps {
  /** fetch used by web tools (tests inject a stub; production uses global fetch). */
  fetch?: typeof fetch;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const buf = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.byteLength - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.byteLength) break;
  }
  return new TextDecoder().decode(buf);
}

/** Tools available to cortex agents. Side-effecting ones are guarded/restricted and only record requests. */
export function buildTools(env: Env, deps: AppDeps, permissions: PermissionManager, cost: CostController, audit: AuditLogger, rt: CortexRuntimeDeps) {
  const doFetch = rt.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const tools = new ToolRegistry({ permissions, cost, audit, defaultTimeoutMs: 10_000 });

  tools.register({
    name: "web.search",
    description: "جستجوی رایگان (DuckDuckGo Instant Answer، بدون کلید)",
    input: s.object({ query: s.string().min(1).max(300) }),
    permissions: ["web:research"],
    risk: "low",
    timeoutMs: 8000,
    handler: async ({ query }, ctx) => {
      const url = `https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(query.slice(0, 300))}`;
      const res = await doFetch(url, { signal: ctx.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new CortexError("search_failed", `search HTTP ${res.status}`, { retryable: false });
      const j = JSON.parse(await readCapped(res, 200_000)) as {
        AbstractText?: string; AbstractURL?: string; Heading?: string;
        RelatedTopics?: { Text?: string; FirstURL?: string }[];
      };
      return {
        heading: j.Heading ?? "",
        abstract: (j.AbstractText ?? "").slice(0, 1500),
        url: j.AbstractURL ?? "",
        related: (j.RelatedTopics ?? []).filter((t) => t.Text && t.FirstURL).slice(0, 5).map((t) => ({ text: t.Text!.slice(0, 300), url: t.FirstURL! })),
      };
    },
  });

  tools.register({
    name: "web.fetch",
    description: "خواندن متن یک صفحهٔ عمومی https (حداکثر ۲۰۰KB)",
    input: s.object({ query: s.string().max(2000).optional(), url: s.string().max(500).optional() }),
    permissions: ["web:research"],
    risk: "low",
    timeoutMs: 8000,
    handler: async ({ url }, ctx) => {
      if (!url) return { note: "no url supplied (pass tool_inputs['web.fetch'].url)", text: "" };
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new CortexError("bad_url", "invalid url", { retryable: false });
      }
      if (u.protocol !== "https:" || PRIVATE_HOST.test(u.hostname) || u.username || u.password) {
        throw new CortexError("bad_url", "only public https urls are allowed", { retryable: false });
      }
      const res = await doFetch(u.toString(), { signal: ctx.signal, redirect: "follow", headers: { accept: "text/html,text/plain" } });
      if (!res.ok) throw new CortexError("fetch_failed", `HTTP ${res.status}`, { retryable: false });
      const ct = res.headers.get("content-type") ?? "";
      if (!/^text\/|json|xml/.test(ct)) throw new CortexError("fetch_failed", `unsupported content-type ${ct}`, { retryable: false });
      return { url: u.toString(), text: stripHtml(await readCapped(res, 200_000)).slice(0, 8000) };
    },
  });

  tools.register({
    name: "admin.read",
    description: "خلاصهٔ وضعیت سامانه (مصرف AI امروز، عامل‌های فعال، صف وظایف) — بدون داده‌ٔ شخصی",
    input: s.object({ query: s.string().max(2000).optional() }),
    permissions: ["analytics:read"],
    risk: "low",
    untrustedOutput: false,
    handler: async () => {
      const usage = await getUsage(env.DB, AI_SERVICE, deps.now(), envAiLimit(env));
      const agents = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(enabled) AS e FROM agents").first<{ n: number; e: number }>();
      const tasks = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all<{ status: string; n: number }>();
      return { ai_usage_today: usage, agents: { total: agents?.n ?? 0, enabled: agents?.e ?? 0 }, tasks: Object.fromEntries(tasks.results.map((r) => [r.status, r.n])) };
    },
  });

  // Restricted (owner-only approval). It never mutates configuration: an approved call records a change request
  // in the audit log for a human admin to apply in the admin panel.
  tools.register({
    name: "admin.write",
    description: "ثبت درخواست تغییر پیکربندی برای اعمال دستی توسط مدیر",
    input: s.object({ query: s.string().min(1).max(2000) }),
    permissions: ["tasks:create"],
    risk: "high",
    level: "restricted",
    untrustedOutput: false,
    handler: async ({ query }, ctx) => {
      await writeAudit(env.DB, { actor: ctx.user.userId, action: "cortex.change_request", targetType: "agent", targetId: ctx.agent.slug, metadata: { request: query.slice(0, 1000) }, now: deps.now() });
      return { recorded: true, note: "درخواست تغییر ثبت شد؛ اعمال آن فقط به‌صورت دستی در پنل مدیریت انجام می‌شود." };
    },
  });

  tools.register({
    name: "scheduler.create",
    description: "ثبت درخواست زمان‌بندی برای بررسی مدیر در مرکز اتوماسیون",
    input: s.object({ query: s.string().min(1).max(2000) }),
    permissions: ["tasks:create"],
    risk: "medium",
    level: "guarded",
    untrustedOutput: false,
    handler: async ({ query }, ctx) => {
      await writeAudit(env.DB, { actor: ctx.user.userId, action: "cortex.schedule_request", targetType: "agent", targetId: ctx.agent.slug, metadata: { request: query.slice(0, 1000) }, now: deps.now() });
      return { recorded: true, note: "درخواست زمان‌بندی ثبت شد؛ مدیر آن را در مرکز اتوماسیون می‌سازد." };
    },
  });
  return tools;
}

interface ApprovalRow {
  id: string;
  user_id: string;
  agent_slug: string;
  action: string;
  level: "guarded" | "restricted";
  fingerprint: string;
  input_preview: string | null;
  reason: string | null;
  request_id: string | null;
  goal: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  approved_by: string | null;
  decided_at: number | null;
  created_at: number;
  expires_at: number;
}

export function serializeApproval(r: ApprovalRow) {
  return {
    id: r.id,
    agent_slug: r.agent_slug,
    action: r.action,
    level: r.level,
    input_preview: r.input_preview,
    reason: r.reason,
    request_id: r.request_id,
    goal: r.goal,
    status: r.status,
    approved_by: r.approved_by,
    decided_at: r.decided_at,
    created_at: r.created_at,
    expires_at: r.expires_at,
  };
}
export type { ApprovalRow };

function rowToRequest(r: ApprovalRow): ApprovalRequest {
  return {
    id: r.id,
    userId: r.user_id,
    agentSlug: r.agent_slug,
    action: r.action,
    level: r.level,
    fingerprint: r.fingerprint,
    inputPreview: r.input_preview ?? "",
    reason: r.reason ?? "",
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    status: r.status,
    approvedBy: r.approved_by ?? undefined,
  };
}

/**
 * PermissionManager whose approvals live in D1. Grants are claimed (status → consumed) before the run and
 * handed back if this run did not need them, so a grant is single-use even across isolates.
 */
class D1BackedPermissions extends PermissionManager {
  readonly created: ApprovalRequest[] = [];
  readonly used = new Set<string>();
  constructor(
    private readonly grants: Map<string, ApprovalRow>,
    private readonly pendingByFp: Map<string, ApprovalRequest>,
    clock: () => number,
  ) {
    super({ approverRoles: { guarded: ["owner", "admin", "user"], restricted: ["owner"] } }, clock);
  }
  override decide(user: UserContext, agent: Pick<AgentManifest, "slug" | "autonomy">, action: ActionDescriptor): PermissionDecision {
    const level = this.levelFor(action, agent);
    if (level === "automatic") return { outcome: "allow", level, via: "automatic" };
    const fp = this.fingerprint(user, agent.slug, action);
    const g = this.grants.get(fp);
    if (g && !this.used.has(g.id) && g.agent_slug === agent.slug && g.action === action.name) {
      this.used.add(g.id);
      return { outcome: "allow", level, via: "grant", approvalId: g.id };
    }
    const p = this.pendingByFp.get(fp);
    if (p) return { outcome: "approval_required", level, approval: p };
    const d = super.decide(user, agent, action);
    if (d.outcome === "approval_required") {
      this.created.push(d.approval);
      this.pendingByFp.set(fp, d.approval);
    }
    return d;
  }
}

/** Forces the intent (Content Studio) while keeping the keyword analysis for transparency. */
class FixedIntentEngine extends IntentEngine {
  constructor(private readonly fixed: Intent) {
    super();
  }
  override async classify(text: string): Promise<IntentResult> {
    const kw = this.classifyByKeywords(text);
    return { ...kw, intent: this.fixed, confidence: 1, source: "default" };
  }
}

export interface CortexUser {
  id: string;
  roles: readonly Role[];
  sessionId?: string;
}

export interface CortexRunOptions {
  toolInputs?: Record<string, unknown>;
  forceIntent?: Intent;
  taskRef?: string;
  signal?: AbortSignal;
  runtime?: CortexRuntimeDeps;
}

export interface CortexRunResult {
  report: CortexReport;
  approvals: ReturnType<typeof serializeApproval>[];
  capReached: boolean;
}

const QUEUE_STATUS: Record<CortexReport["status"], string> = {
  completed: "succeeded",
  partial: "partial",
  awaiting_approval: "awaiting_approval",
  failed: "failed",
  cancelled: "cancelled",
  rejected: "failed",
};

/** Throws ApiError when the kill switch is off, no provider is configured, or today's AI cap is used up. */
export async function assertAiAvailable(env: Env, deps: AppDeps) {
  if (!(await isFlagEnabled(env.DB, "ai_enabled", true)) || !deps.ai.isAvailable(env)) throw new ApiError(503, "ai_disabled");
  const u = await getUsage(env.DB, AI_SERVICE, deps.now(), envAiLimit(env));
  if (u.count >= u.limit) throw new ApiError(429, "daily_cap_reached", { used: u.count, limit: u.limit, day: u.day });
}

/** Cost-capped LLM function backed by the injected AiProvider. */
export function cappedLlm(env: Env, deps: AppDeps, onCap?: () => void): LLMFunction {
  return async (req) => {
    const r = await reserveUsage(env.DB, AI_SERVICE, envAiLimit(env), deps.now());
    if (!r.allowed) {
      onCap?.();
      throw new CortexError("daily_cap_reached", ERRORS_FA.daily_cap_reached, { retryable: false, details: { used: r.count, limit: r.limit } });
    }
    const system = `${PERSIAN_SYSTEM_PROMPT}\n${req.system ?? ""}`.slice(0, 2000);
    const prompt = req.prompt.slice(0, Math.max(500, MAX_PROMPT_CHARS - system.length));
    try {
      return await deps.ai.chat(env, [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ]);
    } catch (e) {
      console.error("cortex llm error", e);
      throw new CortexError("ai_error", ERRORS_FA.ai_error, { retryable: false });
    }
  };
}

export async function runCortex(env: Env, deps: AppDeps, user: CortexUser, goal: string, opts: CortexRunOptions = {}): Promise<CortexRunResult> {
  await assertAiAvailable(env, deps);
  const db = env.DB;
  const now = deps.now();

  // Claim this user's approved grants atomically (single use), and load still-pending requests to avoid duplicates.
  const claimed = await db
    .prepare(
      `UPDATE cortex_approvals SET status = 'consumed' WHERE user_id = ?1 AND status = 'approved' AND expires_at > ?2
       RETURNING *`,
    )
    .bind(user.id, now)
    .all<ApprovalRow>();
  const grants = new Map(claimed.results.map((r) => [r.fingerprint, r]));
  const pending = await db
    .prepare(`SELECT * FROM cortex_approvals WHERE user_id = ?1 AND status = 'pending' AND expires_at > ?2`)
    .bind(user.id, now)
    .all<ApprovalRow>();
  const pendingByFp = new Map(pending.results.map((r) => [r.fingerprint, rowToRequest(r)]));

  let capReached = false;
  const permissions = new D1BackedPermissions(grants, pendingByFp, () => deps.now());
  const cost = new CostController({}, { resetOffsetMinutes: 0 }); // tools are free; AI is capped in cappedLlm
  const audit = new AuditLogger(new D1AuditStore(asD1(db)));
  const agents = await loadAgentRegistry(db);
  const models = new ModelRouter({ cost }).register({
    id: env.AI_MODEL || DEFAULT_AI_MODEL,
    provider: deps.ai.name,
    free: true,
    capabilities: { persian: 0.6, reasoning: 0.6, coding: 0.5, speed: 0.8 },
  });
  const cortex = createCortex({
    agents,
    permissions,
    cost,
    audit,
    models,
    tools: buildTools(env, deps, permissions, cost, audit, opts.runtime ?? {}),
    memory: new MemoryManager(new D1MemoryAdapter(asD1(db))),
    llm: cappedLlm(env, deps, () => (capReached = true)),
    llmForIntent: false, // keyword intent: saves one model call per run
    llmForPlanning: false, // template DAGs: deterministic and free
    ...(opts.forceIntent ? { intent: new FixedIntentEngine(opts.forceIntent) } : {}),
    // Each retry is another paid-capable model call; keep it bounded.
    executionOptions: { maxRetries: 0, maxConcurrency: 2, planTimeoutMs: 25_000, stepTimeoutMs: 20_000 },
  });

  let report: CortexReport;
  try {
    report = await cortex.handle(
      { text: goal, toolInputs: opts.toolInputs, expectedLanguage: "fa" },
      { userId: user.id, sessionId: user.sessionId, roles: cortexRoles(user.roles), locale: "fa" },
      { signal: opts.signal },
    );
  } finally {
    // Hand back grants this run did not use.
    const unused = claimed.results.filter((g) => !permissions.used.has(g.id));
    if (unused.length) {
      await db.batch(unused.map((g) => db.prepare(`UPDATE cortex_approvals SET status = 'approved' WHERE id = ?1 AND status = 'consumed'`).bind(g.id)));
    }
  }

  const stmts: D1PreparedStatement[] = [];
  for (const a of permissions.created) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO cortex_approvals (id, user_id, agent_slug, action, level, fingerprint, input_preview, reason, request_id, goal, status, created_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12)`,
        )
        .bind(a.id, user.id, a.agentSlug, a.action, a.level, a.fingerprint, a.inputPreview, a.reason, report.requestId, goal.slice(0, 2000), a.createdAt, a.expiresAt),
    );
  }
  if (report.plan) {
    const plan = report.plan;
    stmts.push(
      db
        .prepare(
          `INSERT INTO cortex_tasks (id, request_id, user_id, goal, intent, status, plan_json, eval_score, task_ref, output, errors_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
        )
        .bind(
          plan.id, report.requestId, user.id, goal.slice(0, 2000), report.intent.intent, QUEUE_STATUS[report.status],
          JSON.stringify(plan), report.evaluation?.score ?? null, opts.taskRef ?? null, report.output.slice(0, 20_000),
          JSON.stringify(report.errors.slice(0, 20)), deps.now(),
        ),
    );
    for (const step of plan.steps) {
      const st = report.execution?.steps[step.id];
      stmts.push(
        db
          .prepare(
            `INSERT INTO cortex_task_steps (task_id, step_id, user_id, agent_slug, capability, depends_on, status, attempts, output_json, error, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .bind(
            plan.id, step.id, user.id, step.agentSlug, step.capability, JSON.stringify(step.dependsOn), st?.status ?? "skipped",
            st?.attempts ?? 0, st?.output === undefined ? null : JSON.stringify(st.output).slice(0, 20_000), st?.error?.slice(0, 1000) ?? null,
            st?.startedAt ?? null, st?.endedAt ?? null,
          ),
      );
    }
  }
  if (stmts.length) await db.batch(stmts);

  const ids = report.approvals.map((a) => a.id);
  let approvals: ReturnType<typeof serializeApproval>[] = [];
  if (ids.length) {
    const { results } = await db
      .prepare(`SELECT * FROM cortex_approvals WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`)
      .bind(user.id, JSON.stringify(ids))
      .all<ApprovalRow>();
    approvals = results.map(serializeApproval);
  }
  return { report, approvals, capReached };
}

/** Compact, UI-friendly view of a report (no raw tool payloads beyond step outputs). */
export function summarizeReport(r: CortexReport) {
  return {
    request_id: r.requestId,
    status: r.status,
    intent: { intent: r.intent.intent, confidence: r.intent.confidence, source: r.intent.source },
    plan: r.plan
      ? {
          id: r.plan.id,
          source: r.plan.source,
          steps: r.plan.steps.map((s) => {
            const st = r.execution?.steps[s.id];
            return {
              id: s.id,
              title: s.title,
              capability: s.capability,
              agent: s.agentSlug,
              tools: s.toolNames,
              depends_on: s.dependsOn,
              status: st?.status ?? "skipped",
              attempts: st?.attempts ?? 0,
              error: st?.error ?? null,
              output: typeof (st?.output as { text?: unknown } | undefined)?.text === "string" ? ((st!.output as { text: string }).text).slice(0, 4000) : null,
            };
          }),
        }
      : null,
    output: r.output,
    evaluation: r.evaluation ? { score: r.evaluation.score, passed: r.evaluation.passed } : null,
    guard_flags: r.guardFlags.map((f) => f.rule),
    errors: r.errors,
    duration_ms: r.durationMs,
  };
}
