import { Hono } from "hono";
import { featureFlagSchema, roleChangeSchema, usageLimitSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { AI_SERVICE, envAiLimit, getUsage, setDailyLimit } from "../lib/cost";
import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/request";
import { requirePermission } from "../middleware/auth";

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.get("/users", requirePermission("users:read"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.status, u.created_at, u.last_login_at,
            COALESCE((SELECT json_group_array(role) FROM user_roles ur WHERE ur.user_id = u.id), '[]') AS roles
       FROM users u ORDER BY u.created_at DESC LIMIT 200`,
  ).all<{ roles: string } & Record<string, unknown>>();
  return c.json({ users: results.map((u) => ({ ...u, roles: JSON.parse(u.roles) as string[] })) });
});

adminRoutes.post("/users/:id/roles", requirePermission("users:manage"), async (c) => {
  const targetId = c.req.param("id");
  const { role, action } = await parseJson(c, roleChangeSchema); // schema forbids 'super_admin'
  const actor = c.var.auth!.user.id;
  if (targetId === actor) throw new ApiError(409, "conflict", { reason: "cannot change your own roles" });
  const target = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(targetId).first();
  if (!target) throw new ApiError(404, "not_found");
  if (action === "grant") {
    await c.env.DB.prepare(
      `INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING`,
    )
      .bind(targetId, role, actor, c.var.deps.now())
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM user_roles WHERE user_id = ?1 AND role = ?2").bind(targetId, role).run();
  }
  await audit(c, { actor, action: `admin.role.${action}`, targetType: "user", targetId, metadata: { role } });
  const { results } = await c.env.DB.prepare("SELECT role FROM user_roles WHERE user_id = ?1 ORDER BY role")
    .bind(targetId)
    .all<{ role: string }>();
  return c.json({ user_id: targetId, roles: results.map((r) => r.role) });
});

adminRoutes.get("/audit", requirePermission("audit:read"), async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
  const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.actor_user_id, u.email AS actor_email, a.action, a.target_type, a.target_id, a.ip, a.metadata, a.created_at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.id < ?1 ORDER BY a.id DESC LIMIT ?2`,
  )
    .bind(before, limit)
    .all();
  return c.json({ logs: results });
});

adminRoutes.get("/usage", requirePermission("usage:read"), async (c) => {
  const now = c.var.deps.now();
  const today = await getUsage(c.env.DB, AI_SERVICE, now, envAiLimit(c.env));
  const { results } = await c.env.DB.prepare(
    `SELECT service, day, count, "limit" AS "limit", updated_at FROM usage_counters ORDER BY day DESC LIMIT 60`,
  ).all();
  return c.json({ today: { service: AI_SERVICE, ...today }, history: results });
});

adminRoutes.put("/usage/:service", requirePermission("usage:manage"), async (c) => {
  const service = c.req.param("service");
  if (service !== AI_SERVICE) throw new ApiError(404, "not_found");
  const { limit } = await parseJson(c, usageLimitSchema);
  await setDailyLimit(c.env.DB, service, limit, c.var.deps.now());
  await audit(c, { actor: c.var.auth!.user.id, action: "admin.usage.limit", targetType: "service", targetId: service, metadata: { limit } });
  return c.json({ today: { service, ...(await getUsage(c.env.DB, service, c.var.deps.now(), envAiLimit(c.env))) } });
});

adminRoutes.get("/flags", requirePermission("usage:read"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, enabled, description_fa, updated_at FROM feature_flags ORDER BY key").all<{
    enabled: number;
  }>();
  return c.json({ flags: results.map((f) => ({ ...f, enabled: f.enabled === 1 })) });
});

adminRoutes.put("/flags/:key", requirePermission("flags:manage"), async (c) => {
  const key = c.req.param("key");
  const { enabled } = await parseJson(c, featureFlagSchema);
  const row = await c.env.DB.prepare(
    "UPDATE feature_flags SET enabled = ?1, updated_by = ?2, updated_at = ?3 WHERE key = ?4 RETURNING key, enabled",
  )
    .bind(enabled ? 1 : 0, c.var.auth!.user.id, c.var.deps.now(), key)
    .first();
  if (!row) throw new ApiError(404, "not_found");
  await audit(c, { actor: c.var.auth!.user.id, action: "admin.flag.update", targetType: "flag", targetId: key, metadata: { enabled } });
  return c.json({ flag: { key, enabled } });
});

adminRoutes.get("/scheduler", requirePermission("usage:read"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM scheduled_jobs ORDER BY name").all();
  return c.json({ jobs: results });
});
