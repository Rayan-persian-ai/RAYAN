/**
 * Admin dashboard & user management (real numbers from D1 only):
 *   GET  /api/admin/dashboard          users, messages/day (14d), provider/model mix (7d), errors, quotas, queues
 *   GET  /api/admin/users/search?q=    search users by email / name (users:read)
 *   POST /api/admin/users/:id/status   {status: active|disabled} — ban / unban; ends the user's sessions (users:manage)
 *   POST /api/admin/usage/:service/reset   reset today's counter of a quota (usage:manage)
 *   GET  /api/admin/answers            recent answers: which provider/model served each (no message text)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { utcDay } from "../lib/cost";
import { ApiError } from "../lib/errors";
import { geminiKey } from "../lib/gemini";
import { parseJson } from "../lib/request";
import { requirePermission } from "../middleware/auth";

export const adminDashRoutes = new Hono<AppEnv>();
const DAY = 86_400_000;

adminDashRoutes.get("/dashboard", requirePermission("usage:read"), async (c) => {
  const db = c.env.DB;
  const now = c.var.deps.now();
  const since14 = now - 14 * DAY;
  const since7 = now - 7 * DAY;
  const [users, perDay, providers, errors, emailFails, counters, pending, tickets, convs] = (await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(created_at > ?1) AS new_7d, SUM(COALESCE(last_login_at,0) > ?2) AS active_24h, SUM(status = 'disabled') AS disabled FROM users`,
    ).bind(since7, now - DAY),
    db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, SUM(role = 'user') AS user_msgs, SUM(role = 'assistant') AS answers
         FROM messages WHERE created_at > ?1 GROUP BY day ORDER BY day`,
    ).bind(since14),
    db.prepare(
      `SELECT COALESCE(json_extract(meta, '$.provider'), json_extract(meta, '$.engine'), 'unknown') AS provider,
              COALESCE(json_extract(meta, '$.model'), '') AS model, COUNT(*) AS n
         FROM messages WHERE role = 'assistant' AND created_at > ?1 GROUP BY provider, model ORDER BY n DESC LIMIT 20`,
    ).bind(since7),
    db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND created_at > ?1 AND json_extract(meta, '$.error') = 1`).bind(since7),
    db.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE status = 'failed' AND created_at > ?1`).bind(since7),
    db.prepare(`SELECT service, count, "limit" AS l FROM usage_counters WHERE day = ?1 ORDER BY service`).bind(utcDay(now)),
    db.prepare(`SELECT COUNT(*) AS n FROM agent_actions WHERE status = 'pending'`),
    db.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'`),
    db.prepare(`SELECT COUNT(*) AS n FROM conversations`),
  ])) as D1Result[];
  const one = (r: D1Result | undefined) => (r?.results[0] ?? {}) as Record<string, number>;
  return c.json({
    users: one(users),
    conversations: one(convs).n ?? 0,
    messages_per_day: perDay!.results,
    providers_7d: providers!.results,
    errors_7d: { ai_answers: one(errors).n ?? 0, emails: one(emailFails).n ?? 0 },
    quotas_today: counters!.results,
    pending_approvals: one(pending).n ?? 0,
    open_tickets: one(tickets).n ?? 0,
    providers_configured: { gemini: !!(await geminiKey(c.env)), workers_ai: !!c.env.AI, pollinations: true },
    day: utcDay(now),
  });
});

adminDashRoutes.get("/users/search", requirePermission("users:read"), async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.status, u.created_at, u.last_login_at,
            COALESCE((SELECT json_group_array(role) FROM user_roles ur WHERE ur.user_id = u.id), '[]') AS roles,
            (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS messages
       FROM users u WHERE (?1 = '' OR u.email LIKE ?2 ESCAPE '\\' OR u.display_name LIKE ?2 ESCAPE '\\')
      ORDER BY u.created_at DESC LIMIT 100`,
  )
    .bind(q, like)
    .all<{ roles: string } & Record<string, unknown>>();
  return c.json({ users: results.map((u) => ({ ...u, roles: JSON.parse(u.roles) as string[] })) });
});

adminDashRoutes.post("/users/:id/status", requirePermission("users:manage"), async (c) => {
  const { status } = await parseJson(c, z.object({ status: z.enum(["active", "disabled"]) }));
  const id = c.req.param("id");
  const actor = c.var.auth!.user.id;
  if (id === actor) throw new ApiError(409, "conflict", { reason: "cannot change your own status" });
  const target = await c.env.DB.prepare(
    "SELECT u.email, EXISTS(SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'super_admin') AS sa FROM users u WHERE u.id = ?1",
  )
    .bind(id)
    .first<{ email: string; sa: number }>();
  if (!target) throw new ApiError(404, "not_found");
  if (target.sa) throw new ApiError(403, "forbidden", { reason: "the owner cannot be banned" });
  const stmts = [c.env.DB.prepare("UPDATE users SET status = ?1, updated_at = ?2 WHERE id = ?3").bind(status, c.var.deps.now(), id)];
  if (status === "disabled") stmts.push(c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id));
  await c.env.DB.batch(stmts);
  await audit(c, { actor, action: status === "disabled" ? "admin.user.ban" : "admin.user.unban", targetType: "user", targetId: id });
  return c.json({ id, status });
});

adminDashRoutes.post("/usage/:service/reset", requirePermission("usage:manage"), async (c) => {
  const service = c.req.param("service");
  if (!/^[a-z0-9_]{2,40}$/.test(service)) throw new ApiError(400, "invalid_input");
  const r = await c.env.DB.prepare("UPDATE usage_counters SET count = 0, updated_at = ?1 WHERE service = ?2 AND day = ?3").bind(c.var.deps.now(), service, utcDay(c.var.deps.now())).run();
  await audit(c, { actor: c.var.auth!.user.id, action: "admin.usage.reset", targetType: "usage", targetId: service });
  return c.json({ service, reset: (r.meta.changes ?? 0) > 0 });
});

adminDashRoutes.get("/answers", requirePermission("usage:read"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.created_at, u.email,
            COALESCE(json_extract(m.meta, '$.provider'), json_extract(m.meta, '$.engine')) AS provider,
            json_extract(m.meta, '$.model') AS model, json_extract(m.meta, '$.error') AS error, LENGTH(m.content) AS chars
       FROM messages m JOIN users u ON u.id = m.user_id WHERE m.role = 'assistant' ORDER BY m.created_at DESC LIMIT 100`,
  ).all();
  return c.json({ answers: results });
});
