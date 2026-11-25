import { Hono, type Context } from "hono";
import { contentDraftSchema, cortexRunSchema, type ContentDraftInput } from "@rayan/shared";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { cortexRoles, runCortex, serializeApproval, summarizeReport, type ApprovalRow } from "../lib/cortex";
import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/request";
import { chatUserLimit, requirePermission } from "../middleware/auth";

export const cortexRoutes = new Hono<AppEnv>();

function cortexUser(c: Context<AppEnv>) {
  const a = c.var.auth!;
  return { id: a.user.id, roles: a.roles, sessionId: a.sessionId };
}

/** Synchronous run: guard → intent → plan → agents → execute → evaluate. Guarded/restricted tools return approvals. */
cortexRoutes.post("/run", requirePermission("cortex:run"), chatUserLimit, async (c) => {
  const input = await parseJson(c, cortexRunSchema);
  const out = await runCortex(c.env, c.var.deps, cortexUser(c), input.goal, {
    toolInputs: input.tool_inputs,
    signal: c.req.raw.signal,
    runtime: c.var.deps.cortexRuntime,
  });
  await audit(c, {
    actor: c.var.auth!.user.id,
    action: "cortex.run",
    targetType: "cortex_request",
    targetId: out.report.requestId,
    metadata: { status: out.report.status, intent: out.report.intent.intent, approvals: out.approvals.length },
  });
  if (out.capReached && out.report.status === "failed") throw new ApiError(429, "daily_cap_reached");
  return c.json({ ...summarizeReport(out.report), approvals: out.approvals });
});

const KIND_FA: Record<ContentDraftInput["kind"], string> = {
  article: "یک مقالهٔ وبلاگی کامل با تیتر، مقدمه، چند زیرعنوان و جمع‌بندی",
  post: "یک پست شبکهٔ اجتماعی کوتاه و جذاب با چند هشتگ مرتبط",
  ad: "یک متن تبلیغاتی کوتاه با تیتر، متن اصلی و دعوت به اقدام (CTA)",
};

/** Content Studio: a draft through the cortex 'content' intent (outline → draft → edit). Never published. */
cortexRoutes.post("/content", requirePermission("cortex:run"), chatUserLimit, async (c) => {
  const input = await parseJson(c, contentDraftSchema);
  const goal = [
    `${KIND_FA[input.kind]} به زبان فارسی بنویس.`,
    `موضوع: ${input.topic}`,
    input.audience ? `مخاطب: ${input.audience}` : "",
    `لحن: ${input.tone === "formal" ? "رسمی" : "صمیمی"}`,
    "ادعای نادرست، آمار ساختگی یا قیمت/تخفیفی که داده نشده ننویس.",
  ]
    .filter(Boolean)
    .join("\n");
  const out = await runCortex(c.env, c.var.deps, cortexUser(c), goal, { forceIntent: "content", signal: c.req.raw.signal, runtime: c.var.deps.cortexRuntime });
  await audit(c, { actor: c.var.auth!.user.id, action: "cortex.content", targetType: "cortex_request", targetId: out.report.requestId, metadata: { kind: input.kind, status: out.report.status } });
  if (out.capReached && out.report.status === "failed") throw new ApiError(429, "daily_cap_reached");
  return c.json({ kind: input.kind, draft: out.report.output, published: false, ...summarizeReport(out.report), approvals: out.approvals });
});

/** The caller's own cortex runs (most recent first). */
cortexRoutes.get("/runs", requirePermission("cortex:run"), async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  const { results } = await c.env.DB.prepare(
    `SELECT id, request_id, goal, intent, status, eval_score, task_ref, substr(output, 1, 500) AS output, created_at
     FROM cortex_tasks WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
  )
    .bind(c.var.auth!.user.id, limit)
    .all();
  return c.json({ runs: results });
});

cortexRoutes.get("/runs/:id", requirePermission("cortex:run"), async (c) => {
  const uid = c.var.auth!.user.id;
  const run = await c.env.DB.prepare(`SELECT * FROM cortex_tasks WHERE id = ?1 AND user_id = ?2`).bind(c.req.param("id"), uid).first<Record<string, unknown>>();
  if (!run) throw new ApiError(404, "not_found");
  const { results: steps } = await c.env.DB.prepare(
    `SELECT step_id, agent_slug, capability, depends_on, status, attempts, output_json, error FROM cortex_task_steps WHERE task_id = ?1 AND user_id = ?2`,
  )
    .bind(run.id, uid)
    .all();
  return c.json({ run: { ...run, plan_json: undefined, errors: JSON.parse(String(run.errors_json ?? "[]")) }, steps });
});

cortexRoutes.get("/approvals", requirePermission("cortex:run"), async (c) => {
  const status = c.req.query("status");
  if (status && !["pending", "approved", "rejected", "consumed", "expired"].includes(status)) throw new ApiError(400, "invalid_input");
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM cortex_approvals WHERE user_id = ?1 AND (?2 IS NULL OR status = ?2) ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(c.var.auth!.user.id, status ?? null)
    .all<ApprovalRow>();
  const now = c.var.deps.now();
  return c.json({ approvals: results.map((r) => serializeApproval(r.status === "pending" && r.expires_at <= now ? { ...r, status: "expired" } : r)) });
});

async function decide(c: Context<AppEnv>, decision: "approved" | "rejected") {
  const auth = c.var.auth!;
  const id = c.req.param("id") ?? "";
  const row = await c.env.DB.prepare(`SELECT * FROM cortex_approvals WHERE id = ?1`).bind(id).first<ApprovalRow>();
  // Approvals are per-user: you can only decide on your own requests (hide others' existence).
  if (!row || row.user_id !== auth.user.id) throw new ApiError(404, "not_found");
  const roles = cortexRoles(auth.roles);
  if (decision === "approved" && row.level === "restricted" && !roles.includes("owner")) {
    await audit(c, { actor: auth.user.id, action: "cortex.approval.denied", targetType: "cortex_approval", targetId: id, metadata: { level: row.level } });
    throw new ApiError(403, "approval_denied", { level: row.level, required_role: "owner" });
  }
  const now = c.var.deps.now();
  const updated = await c.env.DB.prepare(
    `UPDATE cortex_approvals SET status = ?1, approved_by = ?2, decided_at = ?3
     WHERE id = ?4 AND user_id = ?5 AND status = 'pending' AND expires_at > ?3 RETURNING *`,
  )
    .bind(decision, auth.user.id, now, id, auth.user.id)
    .first<ApprovalRow>();
  if (!updated) throw new ApiError(409, "conflict", { status: row.expires_at <= now && row.status === "pending" ? "expired" : row.status });
  await audit(c, {
    actor: auth.user.id,
    action: decision === "approved" ? "cortex.approval.granted" : "cortex.approval.rejected",
    targetType: "cortex_approval",
    targetId: id,
    metadata: { level: row.level, tool: row.action, agent: row.agent_slug },
  });
  return c.json({
    approval: serializeApproval(updated),
    next: decision === "approved" ? "re-run the same goal to execute it once (single-use grant)" : null,
  });
}

cortexRoutes.post("/approvals/:id/approve", requirePermission("cortex:run"), (c) => decide(c, "approved"));
cortexRoutes.post("/approvals/:id/reject", requirePermission("cortex:run"), (c) => decide(c, "rejected"));
