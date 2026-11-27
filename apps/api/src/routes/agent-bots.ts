/**
 * Admin-managed agents (batch 3):
 *   GET/POST /api/admin/agent-bots            list / create   (agents:manage)
 *   PATCH/DELETE /api/admin/agent-bots/:id    edit / delete
 *   POST /api/admin/agent-bots/:id/run        {tool, input} → run log row (+ approval when a send is gated)
 *   GET  /api/admin/agent-runs?agent=          run log
 *   GET  /api/admin/agent-actions?status=pending   approval queue
 *   POST /api/admin/agent-actions/:id/approve {content_hash}   super_admin only; sends exactly what was reviewed
 *   POST /api/admin/agent-actions/:id/reject
 *   POST /api/admin/agent-codes/verify {email, purpose, code}
 *   GET  /api/admin/agent-bots/meta            tools + whether Gmail is connected
 */
import { Hono } from "hono";
import { z } from "zod";
import { contentHash } from "@rayan/autopilot";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { AGENT_TOOLS, checkAgentCode, deliver, gmailReady, runAgentTool, TOOL_LABELS, type AgentRow, type AgentTool } from "../lib/agent-bots";
import { EmailUnavailable } from "../lib/email";
import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/request";
import { chatUserLimit, requirePermission } from "../middleware/auth";

export const agentBotRoutes = new Hono<AppEnv>();

const botSchema = z.object({
  name: z.string().trim().min(2).max(60),
  role: z.string().trim().min(5).max(2000),
  tools: z.array(z.enum(AGENT_TOOLS)).min(1).max(AGENT_TOOLS.length),
  approval_rule: z.enum(["external", "all"]).default("external"),
  enabled: z.boolean().default(true),
});
const botPatchSchema = botSchema.partial();
const runSchema = z.object({
  tool: z.enum(AGENT_TOOLS),
  input: z
    .object({
      to: z.string().trim().max(200).optional(),
      instruction: z.string().trim().max(4000).optional(),
      subject: z.string().trim().max(200).optional(),
      body: z.string().trim().max(8000).optional(),
      text: z.string().trim().max(12000).optional(),
      topic: z.string().trim().max(1000).optional(),
      kind: z.enum(["article", "post", "ad"]).optional(),
      tone: z.enum(["formal", "friendly"]).optional(),
      purpose: z.string().trim().max(80).optional(),
      message: z.string().trim().max(500).optional(),
    })
    .default({}),
});

const pub = (r: AgentRow & Record<string, unknown>) => ({ ...r, tools: JSON.parse(r.tools) as string[], enabled: r.enabled === 1 });

agentBotRoutes.get("/agent-bots/meta", requirePermission("agents:manage"), async (c) => {
  return c.json({ tools: AGENT_TOOLS.map((id) => ({ id, label: TOOL_LABELS[id] })), gmail_connected: await gmailReady(c.env, c.var.deps) });
});

agentBotRoutes.get("/agent-bots", requirePermission("agents:manage"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM agent_runs r WHERE r.agent_id = b.id) AS runs,
            (SELECT COUNT(*) FROM agent_actions x WHERE x.agent_id = b.id AND x.status = 'pending') AS pending
       FROM agent_bots b ORDER BY b.created_at DESC`,
  ).all<AgentRow & Record<string, unknown>>();
  return c.json({ agents: results.map(pub) });
});

agentBotRoutes.post("/agent-bots", requirePermission("agents:manage"), async (c) => {
  const b = await parseJson(c, botSchema);
  const now = c.var.deps.now();
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO agent_bots (id, name, role, tools, approval_rule, enabled, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)")
    .bind(id, b.name, b.role, JSON.stringify(b.tools), b.approval_rule, b.enabled ? 1 : 0, c.var.auth!.user.id, now)
    .run();
  await audit(c, { actor: c.var.auth!.user.id, action: "agent_bot.create", targetType: "agent_bot", targetId: id, metadata: { tools: b.tools, rule: b.approval_rule } });
  const row = await c.env.DB.prepare("SELECT * FROM agent_bots WHERE id = ?1").bind(id).first<AgentRow & Record<string, unknown>>();
  return c.json({ agent: pub(row!) }, 201);
});

agentBotRoutes.patch("/agent-bots/:id", requirePermission("agents:manage"), async (c) => {
  const b = await parseJson(c, botPatchSchema);
  const row = await c.env.DB.prepare(
    `UPDATE agent_bots SET name = COALESCE(?1, name), role = COALESCE(?2, role), tools = COALESCE(?3, tools),
       approval_rule = COALESCE(?4, approval_rule), enabled = COALESCE(?5, enabled), updated_at = ?6 WHERE id = ?7 RETURNING *`,
  )
    .bind(b.name ?? null, b.role ?? null, b.tools ? JSON.stringify(b.tools) : null, b.approval_rule ?? null, b.enabled === undefined ? null : b.enabled ? 1 : 0, c.var.deps.now(), c.req.param("id"))
    .first<AgentRow & Record<string, unknown>>();
  if (!row) throw new ApiError(404, "not_found");
  await audit(c, { actor: c.var.auth!.user.id, action: "agent_bot.update", targetType: "agent_bot", targetId: row.id });
  return c.json({ agent: pub(row) });
});

agentBotRoutes.delete("/agent-bots/:id", requirePermission("agents:manage"), async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM agent_bots WHERE id = ?1").bind(c.req.param("id")).run();
  if (!r.meta.changes) throw new ApiError(404, "not_found");
  await audit(c, { actor: c.var.auth!.user.id, action: "agent_bot.delete", targetType: "agent_bot", targetId: c.req.param("id") });
  return c.json({ deleted: 1 });
});

agentBotRoutes.post("/agent-bots/:id/run", requirePermission("agents:manage"), chatUserLimit, async (c) => {
  const { tool, input } = await parseJson(c, runSchema);
  const a = await c.env.DB.prepare("SELECT * FROM agent_bots WHERE id = ?1").bind(c.req.param("id")).first<AgentRow>();
  if (!a) throw new ApiError(404, "not_found");
  if (!a.enabled) throw new ApiError(409, "conflict", { reason: "agent disabled" });
  if (!(JSON.parse(a.tools) as string[]).includes(tool)) throw new ApiError(403, "forbidden", { reason: "tool not allowed for this agent" });
  const now = c.var.deps.now();
  const runId = crypto.randomUUID();
  const userId = c.var.auth!.user.id;
  await c.env.DB.prepare("INSERT INTO agent_runs (id, agent_id, tool, input, status, created_by, created_at) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6)")
    .bind(runId, a.id, tool, JSON.stringify(input).slice(0, 20000), userId, now)
    .run();
  const r = await runAgentTool(c.env, c.var.deps, a, tool as AgentTool, input as Record<string, string>, { userId, runId });
  await c.env.DB.prepare("UPDATE agent_runs SET status = ?1, output = ?2, steps = ?3, error = ?4, finished_at = ?5 WHERE id = ?6")
    .bind(r.status, r.output ? JSON.stringify(r.output) : null, JSON.stringify(r.steps), r.error ?? null, c.var.deps.now(), runId)
    .run();
  await audit(c, { actor: userId, action: "agent_bot.run", targetType: "agent_run", targetId: runId, metadata: { agent: a.id, tool, status: r.status } });
  return c.json({ run: { id: runId, agent_id: a.id, tool, status: r.status, output: r.output, steps: r.steps, error: r.error ?? null }, action: r.action ?? null });
});

agentBotRoutes.get("/agent-runs", requirePermission("agents:manage"), async (c) => {
  const agent = c.req.query("agent");
  const stmt = agent
    ? c.env.DB.prepare("SELECT r.*, b.name AS agent_name FROM agent_runs r JOIN agent_bots b ON b.id = r.agent_id WHERE r.agent_id = ?1 ORDER BY r.created_at DESC LIMIT 100").bind(agent)
    : c.env.DB.prepare("SELECT r.*, b.name AS agent_name FROM agent_runs r JOIN agent_bots b ON b.id = r.agent_id ORDER BY r.created_at DESC LIMIT 100");
  const { results } = await stmt.all<Record<string, string | null>>();
  return c.json({
    runs: results.map((r) => ({ ...r, input: JSON.parse(r.input ?? "{}"), output: r.output ? JSON.parse(r.output) : null, steps: JSON.parse(r.steps ?? "[]") })),
  });
});

agentBotRoutes.get("/agent-actions", requirePermission("agents:manage"), async (c) => {
  const status = c.req.query("status") ?? "pending";
  const { results } = await c.env.DB.prepare(
    "SELECT x.*, b.name AS agent_name FROM agent_actions x JOIN agent_bots b ON b.id = x.agent_id WHERE x.status = ?1 ORDER BY x.created_at DESC LIMIT 100",
  )
    .bind(status)
    .all<Record<string, string>>();
  return c.json({ actions: results.map((x) => ({ ...x, payload: JSON.parse(x.payload!) })) });
});

const decideSchema = z.object({ content_hash: z.string().min(16).max(128) });
function requireSuperAdmin(c: { var: { auth: import("../env").AuthContext | null } }) {
  if (!c.var.auth?.roles.includes("super_admin")) throw new ApiError(403, "forbidden", { reason: "only the owner (super_admin) approves sends" });
}

agentBotRoutes.post("/agent-actions/:id/approve", requirePermission("agents:manage"), async (c) => {
  requireSuperAdmin(c);
  const { content_hash } = await parseJson(c, decideSchema);
  const x = await c.env.DB.prepare("SELECT * FROM agent_actions WHERE id = ?1").bind(c.req.param("id")).first<Record<string, string>>();
  if (!x) throw new ApiError(404, "not_found");
  if (x.status !== "pending") throw new ApiError(409, "conflict", { reason: `already ${x.status}` });
  const payload = JSON.parse(x.payload!) as Record<string, unknown>;
  const hash = await contentHash({ tool: x.tool, payload });
  if (hash !== x.content_hash || hash !== content_hash) throw new ApiError(409, "conflict", { reason: "content changed since review" });
  if (!(await gmailReady(c.env, c.var.deps))) throw new ApiError(409, "conflict", { reason: "needs owner to connect Gmail", code: "needs_gmail" });
  // claim atomically so a double click can never send twice
  const claim = await c.env.DB.prepare("UPDATE agent_actions SET status = 'sent', decided_by = ?1, decided_at = ?2 WHERE id = ?3 AND status = 'pending'")
    .bind(c.var.auth!.user.id, c.var.deps.now(), x.id)
    .run();
  if (!claim.meta.changes) throw new ApiError(409, "conflict", { reason: "already decided" });
  try {
    const r = await deliver(c.env, c.var.deps, x.agent_id!, x.tool!, payload, c.var.auth!.user.id, c.var.deps.now());
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE agent_actions SET result = ?1 WHERE id = ?2").bind(JSON.stringify({ provider: r.provider, id: r.id }), x.id),
      c.env.DB.prepare("UPDATE agent_runs SET status = 'completed', finished_at = ?1 WHERE id = ?2").bind(c.var.deps.now(), x.run_id),
    ]);
    await audit(c, { actor: c.var.auth!.user.id, action: "agent_action.approve", targetType: "agent_action", targetId: x.id, metadata: { tool: x.tool } });
    return c.json({ status: "sent", provider: r.provider });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare("UPDATE agent_actions SET status = ?1, result = ?2 WHERE id = ?3").bind(e instanceof EmailUnavailable ? "pending" : "failed", JSON.stringify({ error: msg.slice(0, 200) }), x.id).run();
    throw new ApiError(502, "internal", { reason: "send failed" });
  }
});

agentBotRoutes.post("/agent-actions/:id/reject", requirePermission("agents:manage"), async (c) => {
  requireSuperAdmin(c);
  const x = await c.env.DB.prepare("UPDATE agent_actions SET status = 'rejected', decided_by = ?1, decided_at = ?2 WHERE id = ?3 AND status = 'pending' RETURNING run_id")
    .bind(c.var.auth!.user.id, c.var.deps.now(), c.req.param("id"))
    .first<{ run_id: string }>();
  if (!x) throw new ApiError(404, "not_found");
  await c.env.DB.prepare("UPDATE agent_runs SET status = 'failed', error = 'rejected by owner', finished_at = ?1 WHERE id = ?2").bind(c.var.deps.now(), x.run_id).run();
  await audit(c, { actor: c.var.auth!.user.id, action: "agent_action.reject", targetType: "agent_action", targetId: c.req.param("id") });
  return c.json({ status: "rejected" });
});

agentBotRoutes.post("/agent-codes/verify", requirePermission("agents:manage"), async (c) => {
  const b = await parseJson(c, z.object({ email: z.string().trim().email().max(200), purpose: z.string().trim().min(1).max(80).default("verify"), code: z.string().trim().regex(/^[0-9۰-۹]{6}$/) }));
  const code = b.code.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
  return c.json({ valid: await checkAgentCode(c.env, b.email.toLowerCase(), b.purpose, code, c.var.deps.now()) });
});
