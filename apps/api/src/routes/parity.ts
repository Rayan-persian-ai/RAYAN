/**
 * ChatGPT-parity resources (all scoped to the signed-in user):
 *   GET  /api/models                         model picker (only models that work on the free tiers)
 *   GET/POST /api/projects, PATCH/DELETE /api/projects/:id     projects (folders) with their own instructions
 *   GET/POST/DELETE /api/memories, PATCH/DELETE /api/memories/:id   user memory (view / edit / delete)
 *   POST /api/attachments, GET /api/attachments/:id[/raw], DELETE /api/attachments/:id
 *     text files: text extracted in the browser; images: downscaled in the browser, stored in D1 (no R2/billing).
 */
import { Hono } from "hono";
import { attachmentSchema, memorySchema, projectPatchSchema, projectSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { geminiKey } from "../lib/gemini";
import { MODELS } from "../lib/models";
import { parseJson } from "../lib/request";
import { requireAuth, requirePermission } from "../middleware/auth";

export const modelRoutes = new Hono<AppEnv>();
export const projectRoutes = new Hono<AppEnv>();
export const memoryRoutes = new Hono<AppEnv>();
export const attachmentRoutes = new Hono<AppEnv>();

export const MAX_MEMORIES = 100;
export const MAX_PROJECTS = 50;
/** Per-user attachment budget in D1 (bytes of stored text/base64). */
export const ATTACH_USER_BYTES = 8_000_000;

modelRoutes.get("/", requireAuth, async (c) => {
  const gemini = !!(await geminiKey(c.env));
  const wa = !!c.env.AI;
  const models = MODELS.filter((m) => m.provider === "auto" || (m.provider === "gemini" ? gemini : wa)).map(({ upstream: _u, units: _x, ...m }) => m);
  return c.json({ models, default: "auto" });
});

// ---------- projects ----------
projectRoutes.use("*", requirePermission("chat:use"));
projectRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.instructions, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS conversations
       FROM projects p WHERE p.user_id = ?1 ORDER BY p.updated_at DESC`,
  )
    .bind(c.var.auth!.user.id)
    .all();
  return c.json({ projects: results });
});
projectRoutes.post("/", async (c) => {
  const b = await parseJson(c, projectSchema);
  const me = c.var.auth!.user.id;
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?1").bind(me).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_PROJECTS) throw new ApiError(409, "conflict", { reason: "project limit" });
  const now = c.var.deps.now();
  const p = { id: crypto.randomUUID(), name: b.name, instructions: b.instructions, created_at: now, updated_at: now, conversations: 0 };
  await c.env.DB.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)")
    .bind(p.id, me, p.name, p.instructions, now)
    .run();
  return c.json({ project: p }, 201);
});
projectRoutes.patch("/:id", async (c) => {
  const b = await parseJson(c, projectPatchSchema);
  const row = await c.env.DB.prepare(
    `UPDATE projects SET name = COALESCE(?1, name), instructions = COALESCE(?2, instructions), updated_at = ?3
      WHERE id = ?4 AND user_id = ?5 RETURNING id, name, instructions, created_at, updated_at`,
  )
    .bind(b.name ?? null, b.instructions ?? null, c.var.deps.now(), c.req.param("id"), c.var.auth!.user.id)
    .first();
  if (!row) throw new ApiError(404, "not_found");
  return c.json({ project: row });
});
projectRoutes.delete("/:id", async (c) => {
  const me = c.var.auth!.user.id;
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("DELETE FROM projects WHERE id = ?1 AND user_id = ?2").bind(id, me).run();
  if (!r.meta.changes) throw new ApiError(404, "not_found");
  // chats stay; they just leave the project
  await c.env.DB.prepare("UPDATE conversations SET project_id = NULL WHERE project_id = ?1 AND user_id = ?2").bind(id, me).run();
  return c.json({ deleted: 1 });
});

// ---------- memories ----------
memoryRoutes.use("*", requirePermission("chat:use"));
memoryRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, content, created_at, updated_at FROM user_memories WHERE user_id = ?1 ORDER BY updated_at DESC")
    .bind(c.var.auth!.user.id)
    .all();
  return c.json({ memories: results });
});
memoryRoutes.post("/", async (c) => {
  const { content } = await parseJson(c, memorySchema);
  const me = c.var.auth!.user.id;
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM user_memories WHERE user_id = ?1").bind(me).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_MEMORIES) throw new ApiError(409, "conflict", { reason: "memory full" });
  const now = c.var.deps.now();
  const m = { id: crypto.randomUUID(), content, created_at: now, updated_at: now };
  await c.env.DB.prepare("INSERT INTO user_memories (id, user_id, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)").bind(m.id, me, content, now).run();
  return c.json({ memory: m }, 201);
});
memoryRoutes.patch("/:id", async (c) => {
  const { content } = await parseJson(c, memorySchema);
  const row = await c.env.DB.prepare("UPDATE user_memories SET content = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4 RETURNING id, content, created_at, updated_at")
    .bind(content, c.var.deps.now(), c.req.param("id"), c.var.auth!.user.id)
    .first();
  if (!row) throw new ApiError(404, "not_found");
  return c.json({ memory: row });
});
memoryRoutes.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM user_memories WHERE id = ?1 AND user_id = ?2").bind(c.req.param("id"), c.var.auth!.user.id).run();
  if (!r.meta.changes) throw new ApiError(404, "not_found");
  return c.json({ deleted: 1 });
});
memoryRoutes.delete("/", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM user_memories WHERE user_id = ?1").bind(c.var.auth!.user.id).run();
  return c.json({ deleted: r.meta.changes ?? 0 });
});

/** Memory lines for the system prompt (newest first, bounded). */
export async function memoryPrompt(db: D1Database, userId: string): Promise<string> {
  const { results } = await db.prepare("SELECT content FROM user_memories WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 40").bind(userId).all<{ content: string }>();
  if (!results.length) return "";
  let out = "";
  for (const r of results) {
    if (out.length + r.content.length > 2500) break;
    out += `- ${r.content}\n`;
  }
  return "حافظهٔ ذخیره‌شدهٔ کاربر (فقط برای شخصی‌سازی؛ به آن اشاره نکن مگر مرتبط باشد):\n" + out;
}

// ---------- attachments ----------
attachmentRoutes.use("*", requirePermission("chat:use"));
attachmentRoutes.post("/", async (c) => {
  const b = await parseJson(c, attachmentSchema);
  const me = c.var.auth!.user.id;
  const data = b.kind === "text" ? b.text : b.data;
  if (b.kind === "image" && Math.floor((data.length * 3) / 4) > 420_000) throw new ApiError(413, "invalid_input", { reason: "image too large" });
  const used = await c.env.DB.prepare("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM attachments WHERE user_id = ?1").bind(me).first<{ n: number }>();
  if ((used?.n ?? 0) + data.length > ATTACH_USER_BYTES) throw new ApiError(409, "conflict", { reason: "attachment storage full" });
  const id = crypto.randomUUID();
  const now = c.var.deps.now();
  await c.env.DB.prepare("INSERT INTO attachments (id, user_id, kind, name, mime, size, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(id, me, b.kind, b.name, b.mime || "text/plain", data.length, data, now)
    .run();
  return c.json({ attachment: { id, kind: b.kind, name: b.name, mime: b.mime, size: data.length } }, 201);
});
attachmentRoutes.get("/:id/raw", async (c) => {
  const row = await c.env.DB.prepare("SELECT kind, mime, data, name FROM attachments WHERE id = ?1 AND user_id = ?2")
    .bind(c.req.param("id"), c.var.auth!.user.id)
    .first<{ kind: string; mime: string; data: string; name: string }>();
  if (!row) throw new ApiError(404, "not_found");
  if (row.kind === "text") return c.body(row.data, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=3600" });
  const bin = Uint8Array.from(atob(row.data), (ch) => ch.charCodeAt(0));
  return c.body(bin, 200, { "content-type": row.mime, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
});
attachmentRoutes.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM attachments WHERE id = ?1 AND user_id = ?2").bind(c.req.param("id"), c.var.auth!.user.id).run();
  if (!r.meta.changes) throw new ApiError(404, "not_found");
  return c.json({ deleted: 1 });
});
