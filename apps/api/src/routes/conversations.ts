/**
 * Server-side chat history + streaming answers (parity with the old Space's chat.js, without Supabase):
 *   GET    /api/conversations?q=          list mine (search by title/content)
 *   POST   /api/conversations             create
 *   DELETE /api/conversations             delete all mine
 *   GET    /api/conversations/:id         one conversation with its messages
 *   PATCH  /api/conversations/:id         rename
 *   DELETE /api/conversations/:id         delete
 *   POST   /api/conversations/:id/messages     send → SSE stream (meta, sources, delta…, done | error)
 *   POST   /api/conversations/:id/regenerate   drop the last answer and stream a new one
 *   POST   /api/conversations/:id/append       save turns answered by the in-browser offline model
 *   POST   /api/conversations/:id/share        {enabled} → read-only link id
 *   PATCH  /api/messages/:id                   {rating} feedback (see messageRoutes)
 */
import { Hono, type Context } from "hono";
import {
  appendMessagesSchema,
  CHAT_MAX_TOTAL_CHARS,
  conversationCreateSchema,
  conversationPatchSchema,
  feedbackSchema,
  regenerateSchema,
  sendMessageSchema,
  shareSchema,
  truncateSchema,
} from "@rayan/shared";
import type { ChatTurn } from "../deps";
import type { AppEnv } from "../env";
import { buildSystemPrompt, type Persona } from "../lib/ai";
import { guardedStream } from "../lib/ai-guard";
import { randomToken } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/request";
import { searchGanjoor, versesPrompt } from "../lib/ganjoor";
import { isQuoteRequest, needsSearch, quoteGuard, searchWikipedia, sourcesPrompt, type Source } from "../lib/websearch";
import { chatUserLimit, requirePermission } from "../middleware/auth";
import { PromptGuard } from "@rayan/cortex";
import type { ImagePart } from "../lib/gemini";
import { findModel } from "../lib/models";
import { memoryPrompt } from "./parity";

export const conversationRoutes = new Hono<AppEnv>();
export const messageRoutes = new Hono<AppEnv>();

const uid = () => crypto.randomUUID();
const titleOf = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60) || "گفت‌وگوی تازه";

interface ConvRow {
  id: string;
  user_id: string;
  title: string;
  share_id: string | null;
  pinned_at: number | null;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}
interface MsgRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta: string | null;
  rating: number | null;
  created_at: number;
}

export const publicMessage = (m: MsgRow) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  meta: m.meta ? (JSON.parse(m.meta) as Record<string, unknown>) : null,
  rating: m.rating,
  created_at: m.created_at,
});

async function ownProject(c: Context<AppEnv>, id: string) {
  const p = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?1 AND user_id = ?2").bind(id, c.var.auth!.user.id).first();
  if (!p) throw new ApiError(404, "not_found", { reason: "project" });
}

async function ownConversation(c: Context<AppEnv>, id: string): Promise<ConvRow> {
  const row = await c.env.DB.prepare("SELECT * FROM conversations WHERE id = ?1 AND user_id = ?2")
    .bind(id, c.var.auth!.user.id)
    .first<ConvRow>();
  if (!row) throw new ApiError(404, "not_found");
  return row;
}

export async function loadPersona(db: D1Database, userId: string): Promise<Persona | null> {
  const row = await db.prepare("SELECT data FROM user_prefs WHERE user_id = ?1").bind(userId).first<{ data: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Persona;
  } catch {
    return null;
  }
}

/** Most recent turns inside the per-request character budget, always starting with a user turn. */
export function historyWindow(rows: { role: "user" | "assistant"; content: string }[], budget = CHAT_MAX_TOTAL_CHARS): ChatTurn[] {
  const out: ChatTurn[] = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0 && out.length < 20; i--) {
    const r = rows[i]!;
    const text = r.content.slice(0, 4000);
    if (out.length && total + text.length > budget) break;
    total += text.length;
    out.unshift({ role: r.role, content: text });
  }
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

conversationRoutes.use("*", requirePermission("chat:use"));

conversationRoutes.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const me = c.var.auth!.user.id;
  const cols = "id, title, share_id, pinned_at, project_id, created_at, updated_at";
  const order = "ORDER BY (pinned_at IS NULL), pinned_at DESC, updated_at DESC LIMIT 300";
  const sql = q
    ? `SELECT ${cols} FROM conversations c
        WHERE user_id = ?1 AND (title LIKE ?2 ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?2 ESCAPE '\\'))
        ${order}`
    : `SELECT ${cols} FROM conversations WHERE user_id = ?1 ${order}`;
  const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const stmt = q ? c.env.DB.prepare(sql).bind(me, like) : c.env.DB.prepare(sql).bind(me);
  const { results } = await stmt.all();
  return c.json({ conversations: results });
});

conversationRoutes.post("/", async (c) => {
  const { title, project_id } = await parseJson(c, conversationCreateSchema);
  const now = c.var.deps.now();
  if (project_id) await ownProject(c, project_id);
  const row = { id: uid(), title: titleOf(title ?? ""), share_id: null, pinned_at: null, project_id: project_id ?? null, created_at: now, updated_at: now };
  await c.env.DB.prepare("INSERT INTO conversations (id, user_id, title, project_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)")
    .bind(row.id, c.var.auth!.user.id, row.title, row.project_id, now)
    .run();
  return c.json({ conversation: row }, 201);
});

conversationRoutes.delete("/", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM conversations WHERE user_id = ?1").bind(c.var.auth!.user.id).run();
  return c.json({ deleted: r.meta.changes ?? 0 });
});

conversationRoutes.get("/:id", async (c) => {
  const conv = await ownConversation(c, c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    "SELECT id, role, content, meta, rating, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at, rowid",
  )
    .bind(conv.id)
    .all<MsgRow>();
  const { user_id: _u, ...pub } = conv;
  return c.json({ conversation: pub, messages: results.map(publicMessage) });
});

conversationRoutes.patch("/:id", async (c) => {
  const conv = await ownConversation(c, c.req.param("id"));
  const b = await parseJson(c, conversationPatchSchema);
  if (b.project_id) await ownProject(c, b.project_id);
  const title = b.title ?? conv.title;
  const pinned_at = b.pinned === undefined ? conv.pinned_at : b.pinned ? c.var.deps.now() : null;
  const project_id = b.project_id === undefined ? conv.project_id : b.project_id;
  await c.env.DB.prepare("UPDATE conversations SET title = ?1, pinned_at = ?2, project_id = ?3 WHERE id = ?4").bind(title, pinned_at, project_id, conv.id).run();
  return c.json({ id: conv.id, title, pinned_at, project_id });
});

conversationRoutes.delete("/:id", async (c) => {
  const conv = await ownConversation(c, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM conversations WHERE id = ?1").bind(conv.id).run();
  return c.json({ deleted: 1 });
});

/** «ویرایش پیام»: deletes a user message and everything after it, so the edited text can be sent again. */
conversationRoutes.post("/:id/truncate", async (c) => {
  const conv = await ownConversation(c, c.req.param("id"));
  const { from_message_id } = await parseJson(c, truncateSchema);
  const m = await c.env.DB.prepare("SELECT rowid AS rid, created_at FROM messages WHERE id = ?1 AND conversation_id = ?2 AND role = 'user'")
    .bind(from_message_id, conv.id)
    .first<{ rid: number; created_at: number }>();
  if (!m) throw new ApiError(404, "not_found");
  const r = await c.env.DB.prepare(
    "DELETE FROM messages WHERE conversation_id = ?1 AND (created_at > ?2 OR (created_at = ?2 AND rowid >= ?3))",
  )
    .bind(conv.id, m.created_at, m.rid)
    .run();
  return c.json({ deleted: r.meta.changes ?? 0 });
});

conversationRoutes.post("/:id/share", async (c) => {
  const conv = await ownConversation(c, c.req.param("id"));
  const { enabled } = await parseJson(c, shareSchema);
  const shareId = enabled ? (conv.share_id ?? randomToken(12)) : null;
  await c.env.DB.prepare("UPDATE conversations SET share_id = ?1 WHERE id = ?2").bind(shareId, conv.id).run();
  return c.json({ share_id: shareId });
});

conversationRoutes.post("/:id/append", async (c) => {
  const conv = await ownConversation(c, c.req.param("id"));
  const { messages, engine } = await parseJson(c, appendMessagesSchema);
  const now = c.var.deps.now();
  const ids: string[] = [];
  const stmts = messages.map((m, i) => {
    const id = uid();
    ids.push(id);
    return c.env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(id, conv.id, c.var.auth!.user.id, m.role, m.content, m.role === "assistant" ? JSON.stringify({ engine }) : null, now + i);
  });
  stmts.push(c.env.DB.prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2").bind(now, conv.id));
  await c.env.DB.batch(stmts);
  return c.json({ ids }, 201);
});

conversationRoutes.post("/:id/messages", chatUserLimit, async (c) => {
  const conv = await ownConversation(c, c.req.param("id"));
  const body = await parseJson(c, sendMessageSchema);
  const now = c.var.deps.now();
  const userMsgId = uid();
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1").bind(conv.id).first<{ n: number }>();
  let atts: { id: string; kind: string; name: string }[] = [];
  if (body.attachment_ids.length) {
    const ph = body.attachment_ids.map((_, i) => `?${i + 3}`).join(",");
    const { results } = await c.env.DB.prepare(
      `SELECT id, kind, name FROM attachments WHERE user_id = ?1 AND (conversation_id IS NULL OR conversation_id = ?2) AND id IN (${ph})`,
    )
      .bind(c.var.auth!.user.id, conv.id, ...body.attachment_ids)
      .all<{ id: string; kind: string; name: string }>();
    if (results.length !== new Set(body.attachment_ids).size) throw new ApiError(404, "not_found", { reason: "attachment" });
    atts = results;
  }
  const stmts = [
    c.env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6)").bind(
      userMsgId,
      conv.id,
      c.var.auth!.user.id,
      body.content,
      atts.length ? JSON.stringify({ attachments: atts }) : null,
      now,
    ),
    ...atts.map((a) => c.env.DB.prepare("UPDATE attachments SET conversation_id = ?1 WHERE id = ?2").bind(conv.id, a.id)),
  ];
  // the first message names the conversation (like the old site)
  if (!count?.n) stmts.push(c.env.DB.prepare("UPDATE conversations SET title = ?1 WHERE id = ?2").bind(titleOf(body.content), conv.id));
  await c.env.DB.batch(stmts);
  return answer(c, conv, { search: body.search, deep: body.deep, model: body.model, userMessageId: userMsgId });
});

conversationRoutes.post("/:id/regenerate", chatUserLimit, async (c) => {
  const conv = await ownConversation(c, c.req.param("id"));
  const body = await parseJson(c, regenerateSchema);
  const last = await c.env.DB.prepare("SELECT id, role FROM messages WHERE conversation_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(conv.id)
    .first<{ id: string; role: string }>();
  if (!last) throw new ApiError(409, "conflict", { reason: "empty conversation" });
  if (last.role === "assistant") await c.env.DB.prepare("DELETE FROM messages WHERE id = ?1").bind(last.id).run();
  return answer(c, conv, { search: body.search, deep: body.deep, model: body.model, userMessageId: null });
});

/** Runs the model over the stored history and streams the answer as SSE; stores it when done. */
async function answer(c: Context<AppEnv>, conv: ConvRow, opts: { search: boolean; deep: boolean; model?: string; userMessageId: string | null }) {
  const db = c.env.DB;
  const userId = c.var.auth!.user.id;
  const { results } = await db
    .prepare("SELECT role, content, meta FROM messages WHERE conversation_id = ?1 ORDER BY created_at, rowid")
    .bind(conv.id)
    .all<{ role: "user" | "assistant"; content: string; meta: string | null }>();
  // image turns and failed answers are not useful context for the text model
  // (decided on the parsed meta: a user turn whose attachments include kind "image" stays in context)
  const usable = results.filter((m) => {
    if (!m.meta) return true;
    try {
      const meta = JSON.parse(m.meta) as Record<string, unknown>;
      return !("image" in meta || "error" in meta || meta.engine === "image");
    } catch {
      return true;
    }
  });
  // attachments of the last user message: text → untrusted data block, images → vision input
  const lastRow = [...results].reverse().find((m) => m.role === "user");
  const attMeta = lastRow?.meta ? ((JSON.parse(lastRow.meta) as { attachments?: { id: string }[] }).attachments ?? []) : [];
  let attachText = "";
  const images: ImagePart[] = [];
  if (attMeta.length) {
    const ph = attMeta.map((_, i) => `?${i + 2}`).join(",");
    const { results: rows } = await db
      .prepare(`SELECT kind, name, mime, data FROM attachments WHERE user_id = ?1 AND id IN (${ph})`)
      .bind(userId, ...attMeta.map((a) => a.id))
      .all<{ kind: string; name: string; mime: string; data: string }>();
    const guard = new PromptGuard({ maxLength: 24_000 });
    for (const r of rows) {
      if (r.kind === "image") images.push({ mime: r.mime, data: r.data });
      else attachText += `\nفایل پیوست «${r.name.slice(0, 80)}»:\n` + guard.wrap(r.data.slice(0, 24_000), `file:${r.name.slice(0, 40)}`) + "\n";
    }
  }
  const history = historyWindow(usable);
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) throw new ApiError(409, "conflict", { reason: "no user message to answer" });

  let sources: Source[] = [];
  if (opts.search && needsSearch(lastUser.content)) {
    sources = await searchWikipedia(lastUser.content, { fetchFn: c.var.deps.fetch });
  }
  const persona = await loadPersona(db, userId);
  let system = buildSystemPrompt({ persona, deep: opts.deep });
  if ((persona as { memory?: boolean } | null)?.memory !== false) {
    const mem = await memoryPrompt(db, userId);
    if (mem) system += "\n\n" + mem;
  }
  if (conv.project_id) {
    const p = await db.prepare("SELECT name, instructions FROM projects WHERE id = ?1 AND user_id = ?2").bind(conv.project_id, userId).first<{ name: string; instructions: string }>();
    if (p) system += `\n\nاین گفت‌وگو در پروژهٔ «${p.name}» است.` + (p.instructions ? ` دستورهای پروژه (از طرف کاربر):\n${p.instructions}` : "");
  }
  if (attachText) system += "\n\n" + PromptGuard.SYSTEM_NOTICE + "\nکاربر این فایل‌ها را پیوست کرده است؛ برای پاسخ از محتوای آن‌ها استفاده کن:" + attachText;
  if (images.length) system += "\n\nکاربر تصویر پیوست کرده است؛ آن را دقیق ببین و به پرسش دربارهٔ آن پاسخ بده.";
  const modelId = opts.model ?? (persona as { model?: string } | null)?.model ?? "auto";
  if (sources.length) system += "\n\n" + sourcesPrompt(sources);
  // Anti-hallucination for poetry / quotes: a last-position reminder (models weigh it most) + a Ganjoor link to verify.
  let turns = history;
  let verify: { title: string; url: string } | null = null;
  let poemSources: { title: string; url: string }[] = [];
  if (isQuoteRequest(lastUser.content)) {
    const g = quoteGuard(lastUser.content);
    let guard = g.system;
    const real = await searchGanjoor(lastUser.content, { fetchFn: c.var.deps.fetch });
    if (real) {
      guard += "\n" + versesPrompt(real);
      poemSources = real.verses.map((v) => ({ title: v.title, url: v.url }));
    }
    turns = [...history.slice(0, -1), { role: "system", content: guard }, history.at(-1)!];
    verify = g.source;
  }

  // Errors before the first token (kill switch, daily cap, provider down) are normal JSON errors.
  const out = await guardedStream(c.env, c.var.deps, turns, { system, maxTokens: opts.deep ? 2048 : 1536, model: findModel(modelId).id, images });
  const shown = [...sources.map(({ title, url }) => ({ title, url })), ...poemSources, ...(verify ? [verify] : [])];

  const enc = new TextEncoder();
  // ReadableStream + enqueue never blocks on a slow reader; cancel() fires when the client stops.
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let clientGone = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      ctl = controller;
    },
    cancel() {
      clientGone = true; // user pressed «توقف» / closed the tab: keep what we have
    },
  });
  const send = async (obj: unknown) => {
    if (clientGone) return;
    try {
      ctl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
    } catch {
      clientGone = true;
    }
  };
  const assistantId = uid();
  const pump = (async () => {
    let text = "";
    let failed = false;
    await send({ type: "meta", conversation_id: conv.id, user_message_id: opts.userMessageId, message_id: assistantId, provider: out.provider, model: out.model });
    if (shown.length) await send({ type: "sources", sources: shown });
    try {
      for await (const delta of out.stream) {
        text += delta;
        await send({ type: "delta", text: delta });
        if (clientGone) break;
      }
    } catch (e) {
      failed = true;
      console.error("stream error", e);
    }
    const meta: Record<string, unknown> = { engine: "server", provider: out.provider, model: out.model, picked: modelId, mode: opts.deep ? "deep" : "fast" };
    if (shown.length) meta.sources = shown;
    if (clientGone) meta.stopped = true;
    if (!text.trim()) {
      meta.error = true;
      text = failed ? "⚠️ پاسخ‌گویی هوش مصنوعی با خطا مواجه شد. لطفاً دوباره تلاش کنید." : "⚠️ پاسخی دریافت نشد.";
    }
    const now = c.var.deps.now();
    await db.batch([
      db
        .prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6)")
        .bind(assistantId, conv.id, userId, text, JSON.stringify(meta), now),
      db.prepare("UPDATE conversations SET updated_at = ?1 WHERE id = ?2").bind(now, conv.id),
    ]);
    if (meta.error) await send({ type: "error", code: "ai_error", message: text, message_id: assistantId });
    else await send({ type: "done", message_id: assistantId, provider: out.provider, stopped: !!meta.stopped });
    try {
      ctl.close();
    } catch {
      /* already closed/cancelled */
    }
  })();
  try {
    c.executionCtx.waitUntil(pump);
  } catch {
    /* no execution context (unit tests without ctx) */
  }
  return c.body(readable, 200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
}

messageRoutes.patch("/:id", requirePermission("chat:use"), async (c) => {
  const { rating } = await parseJson(c, feedbackSchema);
  const r = await c.env.DB.prepare("UPDATE messages SET rating = ?1 WHERE id = ?2 AND user_id = ?3 AND role = 'assistant'")
    .bind(rating === 0 ? null : rating, c.req.param("id"), c.var.auth!.user.id)
    .run();
  if (!r.meta.changes) throw new ApiError(404, "not_found");
  return c.json({ id: c.req.param("id"), rating });
});
