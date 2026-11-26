import { Hono } from "hono";
import { announcementCreateSchema, announcementToggleSchema, supportCreateSchema, supportReplySchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/request";
import { rateLimit, requirePermission, userKey } from "../middleware/auth";

/** «پشتیبانی»: users write to the team and read replies (old site: support.js + admin inbox). */
export const supportRoutes = new Hono<AppEnv>();
const supportLimit = rateLimit({ name: "support-user", key: userKey, limit: () => 5, windowSec: 600 });

supportRoutes.get("/", requirePermission("chat:use"), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, body, reply, status, created_at, replied_at FROM support_tickets WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50",
  )
    .bind(c.var.auth!.user.id)
    .all();
  return c.json({ tickets: results });
});

supportRoutes.post("/", requirePermission("chat:use"), supportLimit, async (c) => {
  const { body } = await parseJson(c, supportCreateSchema);
  const id = crypto.randomUUID();
  const now = c.var.deps.now();
  await c.env.DB.prepare("INSERT INTO support_tickets (id, user_id, body, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, c.var.auth!.user.id, body, now)
    .run();
  return c.json({ ticket: { id, body, reply: null, status: "open", created_at: now, replied_at: null } }, 201);
});

/** Admin side of the inbox + announcements (mounted under /api/admin). */
export const adminSupportRoutes = new Hono<AppEnv>();

adminSupportRoutes.get("/support", requirePermission("users:read"), async (c) => {
  const status = c.req.query("status");
  const where = status === "open" || status === "answered" || status === "closed" ? "WHERE t.status = ?1" : "";
  const stmt = c.env.DB.prepare(
    `SELECT t.id, t.body, t.reply, t.status, t.created_at, t.replied_at, u.email
       FROM support_tickets t JOIN users u ON u.id = t.user_id ${where} ORDER BY t.created_at DESC LIMIT 200`,
  );
  const { results } = await (where ? stmt.bind(status) : stmt).all();
  return c.json({ tickets: results });
});

adminSupportRoutes.post("/support/:id/reply", requirePermission("users:manage"), async (c) => {
  const { reply, close } = await parseJson(c, supportReplySchema);
  const id = c.req.param("id");
  const actor = c.var.auth!.user.id;
  const r = await c.env.DB.prepare("UPDATE support_tickets SET reply = ?1, status = ?2, replied_by = ?3, replied_at = ?4 WHERE id = ?5")
    .bind(reply, close ? "closed" : "answered", actor, c.var.deps.now(), id)
    .run();
  if (!r.meta.changes) throw new ApiError(404, "not_found");
  await audit(c, { actor, action: "support.reply", targetType: "support_ticket", targetId: id });
  return c.json({ id, status: close ? "closed" : "answered" });
});

adminSupportRoutes.get("/announcements", requirePermission("flags:manage"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, body, active, created_at FROM announcements ORDER BY created_at DESC LIMIT 100").all();
  return c.json({ announcements: results });
});

adminSupportRoutes.post("/announcements", requirePermission("flags:manage"), async (c) => {
  const { body } = await parseJson(c, announcementCreateSchema);
  const id = crypto.randomUUID();
  const actor = c.var.auth!.user.id;
  await c.env.DB.prepare("INSERT INTO announcements (id, body, active, created_by, created_at) VALUES (?1, ?2, 1, ?3, ?4)")
    .bind(id, body, actor, c.var.deps.now())
    .run();
  await audit(c, { actor, action: "announcement.create", targetType: "announcement", targetId: id });
  return c.json({ id, body, active: 1 }, 201);
});

adminSupportRoutes.patch("/announcements/:id", requirePermission("flags:manage"), async (c) => {
  const { active } = await parseJson(c, announcementToggleSchema);
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("UPDATE announcements SET active = ?1 WHERE id = ?2").bind(active ? 1 : 0, id).run();
  if (!r.meta.changes) throw new ApiError(404, "not_found");
  await audit(c, { actor: c.var.auth!.user.id, action: "announcement.toggle", targetType: "announcement", targetId: id, metadata: { active } });
  return c.json({ id, active: active ? 1 : 0 });
});

/** Public: the active site announcements (banner on every page). */
export const announcementRoutes = new Hono<AppEnv>();
announcementRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, body, created_at FROM announcements WHERE active = 1 ORDER BY created_at DESC LIMIT 3").all();
  return c.json({ announcements: results });
});
