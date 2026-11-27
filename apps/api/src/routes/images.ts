import { Hono } from "hono";
import { imageRequestSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { guardedChat } from "../lib/ai-guard";
import { ApiError } from "../lib/errors";
import { cleanTranslation } from "../lib/images";
import { ENHANCE_PROMPT, generateImage, ImageRouterError, type ImageAspect } from "../lib/image-router";
import { parseJson } from "../lib/request";
import { chatUserLimit, requirePermission } from "../middleware/auth";

export const imageRoutes = new Hono<AppEnv>();
/** Newest generated images kept per user (D1 free storage is 500 MB per database). */
export const IMAGE_KEEP_PER_USER = 40;

/**
 * POST /api/images {prompt, size, n, quality, seed?, enhance, negative?, conversation_id?}
 *   → {images:[{id,url,provider,model,width,height,seed}], prompt, en, enhanced}
 * The request is rewritten into a rich English prompt by the text router (Gemini → Workers AI → …);
 * each variation goes through the image router (lib/image-router.ts). Images are stored in D1 and
 * served by GET /api/images/:id/raw (owner, or anyone holding the conversation's share link).
 */
imageRoutes.post("/", requirePermission("chat:use"), chatUserLimit, async (c) => {
  const b = await parseJson(c, imageRequestSchema);
  const userId = c.var.auth!.user.id;
  const db = c.env.DB;
  if (b.conversation_id) {
    const own = await db.prepare("SELECT id FROM conversations WHERE id = ?1 AND user_id = ?2").bind(b.conversation_id, userId).first();
    if (!own) throw new ApiError(404, "not_found");
  }
  let en = b.prompt;
  let enhanced = false;
  if (b.enhance || /[^\x00-\x7F]/.test(b.prompt)) {
    try {
      const r = await guardedChat(c.env, c.var.deps, [{ role: "user", content: b.prompt + (b.negative ? `\n(avoid: ${b.negative})` : "") }], { system: ENHANCE_PROMPT, maxTokens: 220 });
      const t = cleanTranslation(r.reply);
      if (t) {
        en = t;
        enhanced = true;
      }
    } catch (e) {
      console.log("image prompt enhancement failed:", e instanceof Error ? e.message : String(e));
    }
  }
  const base = b.seed ?? Math.floor(Math.random() * 2 ** 30);
  const now = c.var.deps.now();
  const results = await Promise.allSettled(
    Array.from({ length: b.n }, (_, i) =>
      generateImage(c.env, { prompt: en, aspect: b.size as ImageAspect, seed: base + i, quality: b.quality, negative: b.negative, now, fetchFn: c.var.deps.fetch }),
    ),
  );
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ok.length) {
    const why = results.map((r) => (r.status === "rejected" && r.reason instanceof ImageRouterError ? r.reason.attempts.join("; ") : "")).join(" | ");
    console.log("image router failed:", why);
    throw new ApiError(503, "ai_error", { reason: "image providers unavailable" });
  }
  const images = ok.map((g) => ({ id: crypto.randomUUID(), url: "", provider: g.provider, model: g.model, width: g.width, height: g.height, seed: g.seed, g }));
  for (const im of images) im.url = `/api/images/${im.id}/raw`;
  const stmts = images.map((im) =>
    db
      .prepare(
        "INSERT INTO gen_images (id, user_id, conversation_id, prompt, en_prompt, provider, model, width, height, seed, mime, bytes, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
      )
      .bind(im.id, userId, b.conversation_id ?? null, b.prompt, en, im.provider, im.model, im.width, im.height, im.seed, im.g.mime, im.g.data.length, im.g.data, now),
  );
  stmts.push(
    db
      .prepare(`DELETE FROM gen_images WHERE user_id = ?1 AND id NOT IN (SELECT id FROM gen_images WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ${IMAGE_KEEP_PER_USER})`)
      .bind(userId),
  );
  await db.batch(stmts);
  const pub = images.map(({ g: _g, ...rest }) => rest);
  const first = pub[0]!;
  const image = { url: first.url, prompt: b.prompt, en, size: b.size, seed: first.seed, provider: first.provider, model: first.model, translated: enhanced };

  if (b.conversation_id) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1").bind(b.conversation_id).first<{ n: number }>();
    const s2 = [
      db.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6)")
        .bind(crypto.randomUUID(), b.conversation_id, userId, b.prompt, JSON.stringify({ image_request: true, n: b.n, quality: b.quality, size: b.size }), now),
      db.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6)")
        .bind(crypto.randomUUID(), b.conversation_id, userId, `تصویر «${b.prompt.slice(0, 200)}» ساخته شد.`, JSON.stringify({ engine: "image", provider: first.provider, image, images: pub }), now + 1),
      db.prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2").bind(now, b.conversation_id),
    ];
    if (!count?.n) s2.push(db.prepare("UPDATE conversations SET title = ?1 WHERE id = ?2").bind(`🎨 ${b.prompt.slice(0, 56)}`, b.conversation_id));
    await db.batch(s2);
  }
  return c.json({ images: pub, image, prompt: b.prompt, en, enhanced, failed: b.n - ok.length });
});

/** Gallery: my images (newest first, no image bytes). */
imageRoutes.get("/", requirePermission("chat:use"), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, conversation_id, prompt, en_prompt, provider, model, width, height, seed, created_at FROM gen_images WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100",
  )
    .bind(c.var.auth!.user.id)
    .all();
  return c.json({ images: results.map((r) => ({ ...r, url: `/api/images/${r.id}/raw` })) });
});

imageRoutes.delete("/:id", requirePermission("chat:use"), async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM gen_images WHERE id = ?1 AND user_id = ?2").bind(c.req.param("id"), c.var.auth!.user.id).run();
  if (!r.meta.changes) throw new ApiError(404, "not_found");
  return c.json({ deleted: 1 });
});

/** Image bytes: the owner, or anyone with ?s=<share id> of the conversation the image belongs to. */
imageRoutes.get("/:id/raw", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT g.user_id, g.mime, g.data, cv.share_id FROM gen_images g LEFT JOIN conversations cv ON cv.id = g.conversation_id WHERE g.id = ?1",
  )
    .bind(c.req.param("id"))
    .first<{ user_id: string; mime: string; data: string; share_id: string | null }>();
  const s = c.req.query("s");
  if (!row || !(c.var.auth?.user.id === row.user_id || (s && row.share_id && s === row.share_id))) throw new ApiError(404, "not_found");
  const bin = Uint8Array.from(atob(row.data), (ch) => ch.charCodeAt(0));
  return c.body(bin, 200, { "content-type": row.mime, "cache-control": "private, max-age=604800, immutable", "x-content-type-options": "nosniff" });
});
