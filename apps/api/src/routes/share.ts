import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { publicMessage } from "./conversations";

/** Public, read-only view of a conversation the owner chose to share (no auth, no user data). */
export const shareRoutes = new Hono<AppEnv>();

shareRoutes.get("/:shareId", async (c) => {
  const shareId = c.req.param("shareId");
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(shareId)) throw new ApiError(404, "not_found");
  const conv = await c.env.DB.prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE share_id = ?1")
    .bind(shareId)
    .first<{ id: string; title: string; created_at: number; updated_at: number }>();
  if (!conv) throw new ApiError(404, "not_found");
  const { results } = await c.env.DB.prepare(
    "SELECT id, role, content, meta, NULL AS rating, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at, rowid",
  )
    .bind(conv.id)
    .all<{ id: string; role: "user" | "assistant"; content: string; meta: string | null; rating: null; created_at: number }>();
  return c.json({ title: conv.title, updated_at: conv.updated_at, messages: results.map(publicMessage).map(({ rating: _r, ...m }) => m) });
});
