/**
 * Admin-managed agents (batch 3). Each agent = name + role (its standing instructions) + allowed tools +
 * approval rule; every run is logged step by step in agent_runs. Built on the existing packages:
 *   - @rayan/cortex PromptGuard: untrusted input (texts to summarise, instructions) is wrapped as data;
 *   - @rayan/autopilot contentHash: an approval is bound to the exact email that was reviewed;
 *   - lib/email (pluggable provider, Gmail API by default) + its D1 daily cap and email_log.
 * Approval rule "external" (default): a send to anyone other than OWNER_EMAIL waits in the approval queue;
 * "all": every send waits. Only a super_admin may approve. Without a connected Gmail the send tools
 * report status needs_gmail ("needs owner to connect Gmail") — nothing is faked.
 */
import { PromptGuard } from "@rayan/cortex";
import { contentHash } from "@rayan/autopilot";
import type { AppDeps } from "../deps";
import type { Env } from "../env";
import { guardedChat } from "./ai-guard";
import { EmailCapReached, EmailUnavailable, selectProvider, sendEmail } from "./email";
import { newCode } from "./codes";
import { hmacHex } from "./secretbox";

export const AGENT_TOOLS = ["email.draft", "email.send", "code.send", "summarize", "content.write"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
export const TOOL_LABELS: Record<AgentTool, string> = {
  "email.draft": "پیش‌نویس ایمیل",
  "email.send": "ارسال ایمیل (با صف تأیید)",
  "code.send": "ارسال کد تأیید/اعلان",
  summarize: "خلاصه‌سازی",
  "content.write": "نوشتن محتوا",
};
export const AGENT_CODE_TTL_MS = 15 * 60_000;

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  tools: string;
  approval_rule: "external" | "all";
  enabled: number;
}
export interface Step {
  at: number;
  step: string;
  detail?: string;
}
export interface RunResult {
  status: "completed" | "failed" | "pending_approval" | "needs_gmail";
  output: Record<string, unknown> | null;
  steps: Step[];
  error?: string;
  action?: { id: string; content_hash: string; payload: Record<string, unknown> };
}

const guard = new PromptGuard({ maxLength: 12_000 });
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function gmailReady(env: Env, deps: AppDeps): Promise<boolean> {
  const p = deps.email ?? selectProvider(env, deps.fetch);
  try {
    return await p.configured(env);
  } catch {
    return false;
  }
}

function agentSystem(a: AgentRow): string {
  return [
    `تو ایجنت «${a.name}» در پلتفرم رایان هستی. نقش تو (تعیین‌شده توسط مدیر): ${a.role.slice(0, 1500)}`,
    "به فارسی معیار و دقیق بنویس مگر خلاف آن خواسته شود. اطلاعات ساختگی (قیمت، آمار، تاریخ، نام) نساز.",
    PromptGuard.SYSTEM_NOTICE,
  ].join("\n");
}

function parseEmailJson(text: string): { subject: string; body: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { subject?: unknown; body?: unknown };
      if (typeof j.subject === "string" && typeof j.body === "string" && j.subject.trim() && j.body.trim()) return { subject: j.subject.trim().slice(0, 200), body: j.body.trim().slice(0, 8000) };
    } catch {
      /* fall through */
    }
  }
  const sm = text.match(/(?:موضوع|subject)\s*[:：]\s*(.+)/i);
  if (sm) return { subject: sm[1]!.trim().slice(0, 200), body: text.replace(sm[0], "").trim().slice(0, 8000) };
  return null;
}

async function draftEmail(env: Env, deps: AppDeps, a: AgentRow, to: string, instruction: string) {
  const r = await guardedChat(
    env,
    deps,
    [
      {
        role: "user",
        content: `یک ایمیل برای ${to} بنویس. خواستهٔ مدیر:\n${guard.wrap(instruction, "admin-instruction")}\nفقط یک JSON با کلیدهای "subject" و "body" برگردان (متن ساده، بدون Markdown، با امضای «رایان»).`,
      },
    ],
    { system: agentSystem(a), maxTokens: 900 },
  );
  const d = parseEmailJson(r.reply);
  if (!d) throw new Error("draft_unparseable");
  return { ...d, provider: r.provider };
}

/** Sends an approved/allowed email action. Returns the provider message id. */
export async function deliver(env: Env, deps: AppDeps, agentId: string, tool: string, payload: Record<string, unknown>, userId: string | null, now: number) {
  const provider = deps.email ?? selectProvider(env, deps.fetch);
  const to = String(payload.to);
  if (tool === "code.send") {
    const code = newCode();
    const purpose = String(payload.purpose ?? "verify").slice(0, 80);
    await env.DB.prepare("INSERT INTO agent_codes (id, agent_id, email, purpose, code_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(crypto.randomUUID(), agentId, to, purpose, await hmacHex(env, `agent:${purpose}:${to.toLowerCase()}:${code}`), now, now + AGENT_CODE_TTL_MS)
      .run();
    const text = `${String(payload.message ?? "کد شما:")}\n\n${code}\n\nاین کد ۱۵ دقیقه اعتبار دارد. اگر شما درخواست نکرده‌اید، این پیام را نادیده بگیرید.\n— رایان`;
    return sendEmail(env, provider, { to, subject: String(payload.subject ?? "کد تأیید رایان"), text }, { kind: "agent_code", userId, now });
  }
  return sendEmail(env, provider, { to, subject: String(payload.subject), text: String(payload.body) }, { kind: "agent_email", userId, now });
}

export async function checkAgentCode(env: Env, email: string, purpose: string, code: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id, code_hash, attempts, expires_at FROM agent_codes WHERE email = ?1 AND purpose = ?2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(email, purpose)
    .first<{ id: string; code_hash: string; attempts: number; expires_at: number }>();
  if (!row || row.expires_at < now || row.attempts >= 5) return false;
  const ok = (await hmacHex(env, `agent:${purpose}:${email.toLowerCase()}:${code}`)) === row.code_hash;
  if (ok) await env.DB.prepare("UPDATE agent_codes SET consumed_at = ?2 WHERE id = ?1").bind(row.id, now).run();
  else await env.DB.prepare("UPDATE agent_codes SET attempts = attempts + 1 WHERE id = ?1").bind(row.id).run();
  return ok;
}

/** Runs one tool of an agent. Input validation happens in the route (zod). */
export async function runAgentTool(
  env: Env,
  deps: AppDeps,
  a: AgentRow,
  tool: AgentTool,
  input: Record<string, string>,
  ctx: { userId: string; runId: string },
): Promise<RunResult> {
  const steps: Step[] = [];
  const step = (s: string, detail?: string) => steps.push({ at: deps.now(), step: s, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
  const owner = env.OWNER_EMAIL?.trim().toLowerCase() ?? "";
  try {
    if (tool === "summarize") {
      step("guard", "متن ورودی به‌عنوان دادهٔ نامطمئن بسته‌بندی شد");
      const r = await guardedChat(env, deps, [{ role: "user", content: `این متن را به فارسی خلاصه کن (نکات کلیدی به‌صورت فهرست، سپس یک جمع‌بندی یک‌جمله‌ای):\n${guard.wrap(input.text ?? "", "input")}` }], {
        system: agentSystem(a),
        maxTokens: 700,
      });
      step("model", r.provider);
      return { status: "completed", output: { summary: r.reply }, steps };
    }
    if (tool === "content.write") {
      const r = await guardedChat(
        env,
        deps,
        [{ role: "user", content: `${input.kind === "post" ? "یک پست شبکهٔ اجتماعی" : input.kind === "ad" ? "یک متن تبلیغاتی کوتاه با CTA" : "یک مقالهٔ کامل با تیتر و زیرعنوان"} بنویس.\nموضوع: ${guard.wrap(input.topic ?? "", "topic")}\nلحن: ${input.tone === "friendly" ? "صمیمی" : "رسمی"}` }],
        { system: agentSystem(a), maxTokens: 1400 },
      );
      step("model", r.provider);
      return { status: "completed", output: { content: r.reply, published: false }, steps };
    }
    const to = (input.to ?? "").trim().toLowerCase();
    if (!emailRe.test(to)) return { status: "failed", output: null, steps, error: "invalid_recipient" };

    if (tool === "email.draft" || tool === "email.send") {
      const d = input.subject && input.body ? { subject: input.subject, body: input.body, provider: "admin" } : await draftEmail(env, deps, a, to, input.instruction ?? "");
      step("draft", `${d.provider}: ${d.subject}`);
      const draft = { to, subject: d.subject, body: d.body };
      if (tool === "email.draft") return { status: "completed", output: { draft }, steps };
      return await gate(env, deps, a, tool, draft, to === owner && !!owner, ctx, step, steps);
    }
    // code.send
    const payload = { to, purpose: (input.purpose ?? "verify").slice(0, 80), subject: input.subject?.slice(0, 200) || "کد تأیید رایان", message: input.message?.slice(0, 500) || "کد تأیید شما در رایان:" };
    step("prepare", `کد برای ${to} (${payload.purpose}) — کد در لحظهٔ ارسال ساخته می‌شود`);
    return await gate(env, deps, a, "code.send", payload, to === owner && !!owner, ctx, step, steps);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    step("error", msg);
    return { status: "failed", output: null, steps, error: msg.slice(0, 200) };
  }
}

async function gate(
  env: Env,
  deps: AppDeps,
  a: AgentRow,
  tool: string,
  payload: Record<string, unknown>,
  toOwner: boolean,
  ctx: { userId: string; runId: string },
  step: (s: string, d?: string) => void,
  steps: Step[],
): Promise<RunResult> {
  if (!(await gmailReady(env, deps))) {
    step("blocked", "needs owner to connect Gmail");
    return { status: "needs_gmail", output: { draft: payload, message: "needs owner to connect Gmail — مالک باید از مدیریت ← «ایمیل (Gmail)» Gmail را وصل کند" }, steps };
  }
  const needsApproval = a.approval_rule === "all" || !toOwner;
  if (needsApproval) {
    const hash = await contentHash({ tool, payload });
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO agent_actions (id, run_id, agent_id, tool, payload, content_hash, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)")
      .bind(id, ctx.runId, a.id, tool, JSON.stringify(payload), hash, deps.now())
      .run();
    step("approval", `در صف تأیید (${toOwner ? "قانون: همه" : "گیرندهٔ غیرمالک"})`);
    return { status: "pending_approval", output: { draft: payload, action_id: id }, steps, action: { id, content_hash: hash, payload } };
  }
  try {
    const r = await deliver(env, deps, a.id, tool, payload, ctx.userId, deps.now());
    step("sent", `${r.provider} ${r.id}`);
    return { status: "completed", output: { sent: true, to: payload.to, provider: r.provider }, steps };
  } catch (e) {
    if (e instanceof EmailUnavailable) {
      step("blocked", "needs owner to connect Gmail");
      return { status: "needs_gmail", output: { draft: payload }, steps };
    }
    if (e instanceof EmailCapReached) return { status: "failed", output: null, steps, error: "email_daily_cap" };
    throw e;
  }
}
