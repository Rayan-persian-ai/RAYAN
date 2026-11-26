import { Hono } from "hono";
import { imageRequestSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { guardedChat } from "../lib/ai-guard";
import { reserveUsage } from "../lib/cost";
import { ApiError } from "../lib/errors";
import { cleanTranslation, IMAGE_DAILY_DEFAULT, IMAGE_SERVICE, imageUrl, needsTranslation, TRANSLATE_PROMPT } from "../lib/images";
import { parseJson } from "../lib/request";
import { chatUserLimit, requirePermission } from "../middleware/auth";

export const imageRoutes = new Hono<AppEnv>();

/**
 * POST /api/images {prompt, size, conversation_id?} → {url, prompt, en, size, seed}
 * Persian prompts are translated to English by the AI chain first (one small call; on any failure the
 * original prompt is used). When conversation_id is given, the request and the image are saved into
 * that conversation's history.
 */
imageRoutes.post("/", requirePermission("chat:use"), chatUserLimit, async (c) => {
  const { prompt, size, conversation_id } = await parseJson(c, imageRequestSchema);
  const userId = c.var.auth!.user.id;
  const db = c.env.DB;
  if (conversation_id) {
    const own = await db.prepare("SELECT id FROM conversations WHERE id = ?1 AND user_id = ?2").bind(conversation_id, userId).first();
    if (!own) throw new ApiError(404, "not_found");
  }
  const cap = await reserveUsage(db, IMAGE_SERVICE, IMAGE_DAILY_DEFAULT, c.var.deps.now());
  if (!cap.allowed) throw new ApiError(429, "daily_cap_reached", { used: cap.count, limit: cap.limit, day: cap.day });

  let en = prompt;
  let translated = false;
  if (needsTranslation(prompt)) {
    try {
      const r = await guardedChat(c.env, c.var.deps, [{ role: "user", content: prompt }], { system: TRANSLATE_PROMPT, maxTokens: 160 });
      const t = cleanTranslation(r.reply);
      if (!t) console.log("image translation unusable:", JSON.stringify(r.reply).slice(0, 200));
      if (t) {
        en = t;
        translated = true;
      }
    } catch (e) {
      console.log("image translation failed:", e instanceof Error ? e.message : String(e)); // keep the original prompt
    }
  }
  const seed = Math.floor(Math.random() * 2 ** 31);
  const image = { url: imageUrl(en, size, seed), prompt, en, size, seed, translated };

  if (conversation_id) {
    const now = c.var.deps.now();
    const count = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1").bind(conversation_id).first<{ n: number }>();
    const stmts = [
      db.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6)")
        .bind(crypto.randomUUID(), conversation_id, userId, prompt, JSON.stringify({ image_request: true }), now),
      db.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6)")
        .bind(crypto.randomUUID(), conversation_id, userId, `تصویر «${prompt.slice(0, 200)}» ساخته شد.`, JSON.stringify({ engine: "pollinations", image }), now + 1),
      db.prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2").bind(now, conversation_id),
    ];
    if (!count?.n) stmts.push(db.prepare("UPDATE conversations SET title = ?1 WHERE id = ?2").bind(`🎨 ${prompt.slice(0, 56)}`, conversation_id));
    await db.batch(stmts);
  }
  return c.json(image);
});
