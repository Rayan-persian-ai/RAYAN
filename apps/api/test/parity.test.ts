import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AiProvider, ChatCallOptions, ChatTurn } from "../src/deps";
import { buildSystemPrompt, DEEP_MODE_PROMPT, PERSIAN_SYSTEM_PROMPT } from "../src/lib/ai";
import { clampTokens, workersAiDeltas } from "../src/lib/ai-chain";
import { cleanTranslation, imageUrl, needsTranslation } from "../src/lib/images";
import { imageDims, validImage } from "../src/lib/image-router";
import { needsSearch, searchWikipedia, simplify } from "../src/lib/websearch";
import { historyWindow } from "../src/routes/conversations";
import { client, grantRole, makeDeps as baseDeps, registeredClient } from "./helpers";

// Every test gets its own UTC day so the shared AI daily cap (AI_DAILY_LIMIT=3 in tests) never bleeds between tests.
let dayN = 0;
const makeDeps: typeof baseDeps = (over = {}) => {
  const now = Date.UTC(2040, 0, 1 + ++dayN * 3, 12);
  // no real network in tests: outbound fetch (Wikipedia / Ganjoor) is offline unless a test injects a stub
  const offline = (async () => {
    throw new Error("offline test");
  }) as unknown as typeof fetch;
  return baseDeps({ now: () => now, fetch: offline, ...over });
};

/** Mock LLM that records messages + options; optionally streams in chunks or answers in English. */
function recAi(opts: { chunks?: string[]; reply?: (m: ChatTurn[]) => string; fail?: boolean } = {}) {
  const calls: { messages: ChatTurn[]; opts?: ChatCallOptions }[] = [];
  const reply = opts.reply ?? ((m: ChatTurn[]) => `پاسخ: ${m.at(-1)?.content ?? ""}`);
  const provider: AiProvider = {
    name: "rec",
    isAvailable: () => true,
    async chat(_e, messages, o) {
      calls.push({ messages, opts: o });
      if (opts.fail) throw new Error("down");
      return reply(messages);
    },
  };
  if (opts.chunks) {
    provider.chatStream = async (_e, messages, o) => {
      calls.push({ messages, opts: o });
      const chunks = opts.chunks!;
      return {
        provider: "stream-mock",
        model: "m",
        stream: (async function* () {
          for (const c of chunks) yield c;
        })(),
      };
    };
  }
  return { provider, calls };
}

interface Ev {
  type: string;
  [k: string]: any;
}
async function sse(res: Response): Promise<Ev[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.slice(5).trim()) as Ev);
}

async function newConv(c: Awaited<ReturnType<typeof registeredClient>>["c"]) {
  const r = await c.json("POST", "/api/conversations", {});
  expect(r.status).toBe(201);
  return r.body.conversation.id as string;
}

describe("conversations: history CRUD, search, isolation", () => {
  it("creates, lists, searches, renames, deletes — and hides other users' chats", async () => {
    const ai = recAi();
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider }) });
    const id = await newConv(c);
    const s = await c.request("POST", `/api/conversations/${id}/messages`, { content: "دربارهٔ کوروش بزرگ" });
    expect(s.status).toBe(200);
    await sse(s);
    const list = await c.json("GET", "/api/conversations");
    expect(list.body.conversations[0]).toMatchObject({ id, title: "دربارهٔ کوروش بزرگ" }); // first message names it
    expect((await c.json("GET", "/api/conversations?q=" + encodeURIComponent("کوروش"))).body.conversations).toHaveLength(1);
    expect((await c.json("GET", "/api/conversations?q=" + encodeURIComponent("پاسخ:"))).body.conversations).toHaveLength(1); // content search
    expect((await c.json("GET", "/api/conversations?q=zzz")).body.conversations).toHaveLength(0);
    expect((await c.json("PATCH", `/api/conversations/${id}`, { title: "تاریخ" })).status).toBe(200);
    const one = await c.json("GET", `/api/conversations/${id}`);
    expect(one.body.conversation.title).toBe("تاریخ");
    expect(one.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(one.body.conversation.user_id).toBeUndefined();

    const other = await registeredClient();
    expect((await other.c.json("GET", `/api/conversations/${id}`)).status).toBe(404);
    expect((await other.c.json("DELETE", `/api/conversations/${id}`)).status).toBe(404);
    expect((await other.c.request("POST", `/api/conversations/${id}/messages`, { content: "سلام" })).status).toBe(404);

    expect((await c.json("DELETE", `/api/conversations/${id}`)).status).toBe(200);
    expect((await c.json("GET", `/api/conversations/${id}`)).status).toBe(404);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1").bind(id).first<{ n: number }>();
    expect(n!.n).toBe(0); // cascade
  });

  it("requires login and deletes all chats on request", async () => {
    expect((await client().json("GET", "/api/conversations")).status).toBe(401);
    const { c } = await registeredClient({ deps: makeDeps() });
    await newConv(c);
    await newConv(c);
    expect((await c.json("DELETE", "/api/conversations")).body.deleted).toBe(2);
    expect((await c.json("GET", "/api/conversations")).body.conversations).toHaveLength(0);
  });
});

describe("streaming answers (SSE)", () => {
  it("streams deltas from a streaming provider and stores the joined answer", async () => {
    const ai = recAi({ chunks: ["سلام", "، ", "خوش آمدید"] });
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider }) });
    const id = await newConv(c);
    const res = await c.request("POST", `/api/conversations/${id}/messages`, { content: "سلام" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const ev = await sse(res);
    expect(ev[0]).toMatchObject({ type: "meta", conversation_id: id, provider: "stream-mock" });
    expect(ev.filter((e) => e.type === "delta").map((e) => e.text)).toEqual(["سلام", "، ", "خوش آمدید"]);
    expect(ev.at(-1)).toMatchObject({ type: "done", provider: "stream-mock" });
    const msgs = (await c.json("GET", `/api/conversations/${id}`)).body.messages;
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "سلام، خوش آمدید", meta: { engine: "server", provider: "stream-mock", mode: "fast" } });
    expect(ai.calls[0]!.opts).toMatchObject({ maxTokens: 1536, model: "auto" });
  });

  it("falls back to a single chunk for non-streaming providers and sends the full history", async () => {
    const ai = recAi();
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider }) });
    const id = await newConv(c);
    await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "اول" }));
    const ev = await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "دوم" }));
    expect(ev.filter((e) => e.type === "delta").map((e) => e.text).join("")).toBe("پاسخ: دوم");
    const sent = ai.calls[1]!.messages;
    expect(sent[0]!.role).toBe("system");
    expect(sent.slice(1).map((m) => m.content)).toEqual(["اول", "پاسخ: اول", "دوم"]);
  });

  it("uses the anti-hallucination prompt, the user's personalisation and deep mode", async () => {
    const ai = recAi();
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider }) });
    expect((await c.json("PUT", "/api/me/prefs", { name: "تایماز", style: "short", about: "برنامه‌نویس", theme: "dark" })).status).toBe(200);
    expect((await c.json("GET", "/api/me/prefs")).body.prefs).toMatchObject({ name: "تایماز", style: "short", theme: "dark" });
    const id = await newConv(c);
    await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "یک بیت از حافظ بگو", deep: true }));
    const sys = ai.calls[0]!.messages[0]!.content;
    expect(sys).toContain("هرگز بیت، شعر");
    expect(sys).toContain("گنجور");
    expect(sys).toContain("«تایماز»");
    expect(sys).toContain("کوتاه و خلاصه");
    expect(sys).toContain(DEEP_MODE_PROMPT);
    expect(ai.calls[0]!.opts).toMatchObject({ maxTokens: 2048, model: "auto" });
    expect((await c.json("PUT", "/api/me/prefs", { style: "loud" })).status).toBe(400);
  });

  it("grounds factual questions on Persian Wikipedia when search is on (and only then)", async () => {
    const ai = recAi();
    const urls: string[] = [];
    const fakeFetch = (async (u: string) => {
      urls.push(String(u));
      const q = new URL(String(u));
      if (q.searchParams.get("list") === "search") return Response.json({ query: { search: [{ title: "تهران" }] } });
      return Response.json({ query: { pages: [{ title: "تهران", extract: "تهران پایتخت و پرجمعیت‌ترین شهر ایران است و مرکز استان تهران." }] } });
    }) as typeof fetch;
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider, fetch: fakeFetch }) });
    const id = await newConv(c);
    const ev = await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "پایتخت ایران کجاست؟", search: true }));
    const src = ev.find((e) => e.type === "sources");
    expect(src!.sources).toEqual([{ title: "تهران", url: "https://fa.wikipedia.org/wiki/%D8%AA%D9%87%D8%B1%D8%A7%D9%86" }]);
    expect(ai.calls[0]!.messages[0]!.content).toContain("[1] تهران");
    expect(urls[0]).toContain("fa.wikipedia.org");
    const stored = (await c.json("GET", `/api/conversations/${id}`)).body.messages[1];
    expect(stored.meta.sources).toHaveLength(1);

    urls.length = 0;
    await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "پایتخت فرانسه کجاست؟", search: false }));
    await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "سلام خوبی", search: true }));
    expect(urls).toHaveLength(0); // search off, and small talk never searches
  });

  it("regenerates the last answer in place", async () => {
    let n = 0;
    const ai = recAi({ reply: () => `نسخه ${++n}` });
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider }) });
    const id = await newConv(c);
    await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "شعر بگو" }));
    const ev = await sse(await c.request("POST", `/api/conversations/${id}/regenerate`, {}));
    expect(ev.at(-1)!.type).toBe("done");
    const msgs = (await c.json("GET", `/api/conversations/${id}`)).body.messages;
    expect(msgs.map((m: any) => m.content)).toEqual(["شعر بگو", "نسخه 2"]);
  });

  it("answers with a JSON 429 (not a broken stream) when the daily cap is reached, and 502 when AI fails", async () => {
    const now = Date.UTC(2033, 3, 3, 12);
    const { c } = await registeredClient({ deps: makeDeps({ ai: recAi().provider, now: () => now }) });
    const id = await newConv(c);
    for (let i = 0; i < 3; i++) await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "سلام " + i }));
    const capped = await c.json("POST", `/api/conversations/${id}/messages`, { content: "باز هم" });
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("daily_cap_reached");

    const bad = await registeredClient({ deps: makeDeps({ ai: recAi({ fail: true }).provider, now: () => now + 86400_000 * 3 }) });
    const id2 = await newConv(bad.c);
    expect((await bad.c.json("POST", `/api/conversations/${id2}/messages`, { content: "سلام" })).status).toBe(502);
  });

  it("saves turns answered by the in-browser offline model", async () => {
    const { c } = await registeredClient({ deps: makeDeps() });
    const id = await newConv(c);
    const r = await c.json("POST", `/api/conversations/${id}/append`, {
      messages: [
        { role: "user", content: "سلام آفلاین" },
        { role: "assistant", content: "سلام! من در مرورگر شما اجرا می‌شوم." },
      ],
    });
    expect(r.status).toBe(201);
    const msgs = (await c.json("GET", `/api/conversations/${id}`)).body.messages;
    expect(msgs[1].meta).toEqual({ engine: "local" });
    expect((await c.json("POST", `/api/conversations/${id}/append`, { messages: [], engine: "local" })).status).toBe(400);
  });
});

describe("share, feedback, images, stats", () => {
  it("shares a read-only copy publicly and can revoke it", async () => {
    const { c } = await registeredClient({ deps: makeDeps() });
    const id = await newConv(c);
    await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "سلام" }));
    const on = await c.json("POST", `/api/conversations/${id}/share`, { enabled: true });
    const shareId = on.body.share_id as string;
    expect(shareId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect((await c.json("POST", `/api/conversations/${id}/share`, { enabled: true })).body.share_id).toBe(shareId); // stable
    const pub = await client().json("GET", `/api/share/${shareId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(pub.body)).not.toContain("user_id");
    await c.json("POST", `/api/conversations/${id}/share`, { enabled: false });
    expect((await client().json("GET", `/api/share/${shareId}`)).status).toBe(404);
    expect((await client().json("GET", `/api/share/..%2Fx`)).status).toBe(404);
  });

  it("records 👍/👎 feedback only on the owner's answers", async () => {
    const { c } = await registeredClient({ deps: makeDeps() });
    const id = await newConv(c);
    const ev = await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "سلام" }));
    const mid = ev.at(-1)!.message_id as string;
    expect((await c.json("PATCH", `/api/messages/${mid}`, { rating: 1 })).status).toBe(200);
    expect((await c.json("GET", `/api/conversations/${id}`)).body.messages[1].rating).toBe(1);
    expect((await c.json("PATCH", `/api/messages/${mid}`, { rating: 0 })).status).toBe(200);
    expect((await c.json("GET", `/api/conversations/${id}`)).body.messages[1].rating).toBeNull();
    expect((await c.json("PATCH", `/api/messages/${mid}`, { rating: 5 })).status).toBe(400);
    const other = await registeredClient();
    expect((await other.c.json("PATCH", `/api/messages/${mid}`, { rating: -1 })).status).toBe(404);
    const st = await c.json("GET", "/api/me/stats");
    expect(st.body.stats).toMatchObject({ conversations: 1, messages: 1, answers: 1, feedback: 0 });
  });

  it("routes images (Pollinations fallback without Workers AI), validates the bytes, stores them and saves the chat turn", async () => {
    const ai = recAi({ reply: () => "An orange cat on a Persian rug, warm light" });
    const fetched: string[] = [];
    const fetchStub = (async (u: string) => {
      fetched.push(String(u));
      return new Response(fakeJpeg(1216, 832), { headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider, fetch: fetchStub }) });
    const id = await newConv(c);
    const r = await c.json("POST", "/api/images", { prompt: "گربهٔ نارنجی روی فرش ایرانی", size: "wide", conversation_id: id, n: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ en: "An orange cat on a Persian rug, warm light", enhanced: true, failed: 0 });
    expect(r.body.images).toHaveLength(2);
    expect(r.body.images[0]).toMatchObject({ provider: "pollinations", width: 1216, height: 832 });
    expect(fetched[0]).toContain("width=1216&height=832");
    expect(ai.calls[0]!.messages[0]!.content).toContain("English prompt");
    const raw = await c.request("GET", r.body.images[0].url);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/jpeg");
    expect((await client().request("GET", r.body.images[0].url)).status).toBe(404); // not public
    const msgs = (await c.json("GET", `/api/conversations/${id}`)).body.messages;
    expect(msgs[1].meta.images).toHaveLength(2);
    expect((await c.json("GET", "/api/images")).body.images).toHaveLength(2);
    expect((await c.json("GET", "/api/conversations")).body.conversations[0].title).toContain("🎨");
    // a "busy" placeholder (tiny / wrong size) is never shown
    const busy = (async () => new Response(fakeJpeg(512, 512, 4000), { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    const c2 = (await registeredClient({ deps: makeDeps({ ai: ai.provider, fetch: busy }) })).c;
    expect((await c2.json("POST", "/api/images", { prompt: "a red car", enhance: false })).status).toBe(503);
    expect((await c2.json("POST", "/api/images", { prompt: "x", size: "huge" })).status).toBe(400);
    expect((await c2.json("POST", "/api/images", { prompt: "a cat", conversation_id: id })).status).toBe(404);
  });
});

/** Minimal JPEG header (SOI + SOF0 with the given size) padded to `bytes`. */
function fakeJpeg(w: number, h: number, bytes = 40_000) {
  const b = new Uint8Array(bytes);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
  return b;
}

describe("support inbox and announcements", () => {
  it("lets a user write to support and an admin reply; announcements are super_admin-managed and public", async () => {
    const u = await registeredClient();
    const t = await u.c.json("POST", "/api/support", { body: "دکمهٔ ساخت تصویر کار نمی‌کند" });
    expect(t.status).toBe(201);
    expect((await u.c.json("GET", "/api/admin/support")).status).toBe(403);

    const a = await registeredClient();
    await grantRole(a.userId, "super_admin");
    const inbox = await a.c.json("GET", "/api/admin/support?status=open");
    expect(inbox.body.tickets.some((x: any) => x.id === t.body.ticket.id && x.email === u.email)).toBe(true);
    expect((await a.c.json("POST", `/api/admin/support/${t.body.ticket.id}/reply`, { reply: "درست شد، ممنون" })).status).toBe(200);
    const mine = await u.c.json("GET", "/api/support");
    expect(mine.body.tickets[0]).toMatchObject({ reply: "درست شد، ممنون", status: "answered" });

    expect((await u.c.json("POST", "/api/admin/announcements", { body: "به‌روزرسانی امشب" })).status).toBe(403);
    const an = await a.c.json("POST", "/api/admin/announcements", { body: "به‌روزرسانی امشب" });
    expect(an.status).toBe(201);
    const pub = await client().json("GET", "/api/announcements");
    expect(pub.body.announcements.some((x: any) => x.id === an.body.id)).toBe(true);
    await a.c.json("PATCH", `/api/admin/announcements/${an.body.id}`, { active: false });
    expect((await client().json("GET", "/api/announcements")).body.announcements.some((x: any) => x.id === an.body.id)).toBe(false);
  });
});

describe("pure helpers", () => {
  it("search heuristics", () => {
    expect(needsSearch("پایتخت ایران کجاست؟")).toBe(true);
    expect(needsSearch("کوروش کیست")).toBe(true);
    expect(needsSearch("سلام خوبی؟")).toBe(false);
    expect(needsSearch("یک ایمیل اداری بنویس")).toBe(false);
    expect(simplify("پایتخت ایران کجاست؟")).toBe("پایتخت ایران");
  });

  it("searchWikipedia never throws", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await searchWikipedia("تهران چیست؟", { fetchFn: boom })).toEqual([]);
  });

  it("history window keeps the newest turns within budget and starts with the user", () => {
    const rows = [
      { role: "assistant" as const, content: "سلام" },
      { role: "user" as const, content: "الف".repeat(10) },
      { role: "assistant" as const, content: "ب".repeat(10) },
      { role: "user" as const, content: "ج" },
    ];
    expect(historyWindow(rows).map((r) => r.role)).toEqual(["user", "assistant", "user"]);
    expect(historyWindow(rows, 12).map((r) => r.content)).toEqual(["ج"]);
  });

  it("parses the Workers AI SSE stream", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        const all = enc.encode('data: {"response":"سلام"}');
        ctl.enqueue(all.slice(0, 22)); // split inside a multi-byte character
        ctl.enqueue(all.slice(22));
        ctl.enqueue(enc.encode('\n\n\n\ndata: {"response":" دنیا"}\n\ndata: [DONE]\n\n'));
        ctl.close();
      },
    });
    const out: string[] = [];
    for await (const t of workersAiDeltas(body)) out.push(t);
    expect(out.join("")).toBe("سلام دنیا");
    expect(clampTokens(undefined)).toBe(1024);
    expect(clampTokens(99999)).toBe(2048);
  });

  it("image helpers and system prompt", () => {
    expect(needsTranslation("cat")).toBe(false);
    expect(needsTranslation("گربه")).toBe(true);
    expect(cleanTranslation('"Prompt: a cat"')).toBe("a cat");
    expect(cleanTranslation("گربه")).toBeNull();
    expect(cleanTranslation("Here it is:\nAn orange cat (گربه) on a rug")).toBe("An orange cat on a rug");
    expect(cleanTranslation("English prompt: An orange cat on a rug\n")).toBe("An orange cat on a rug");
    expect(imageUrl("a b", "tall", 7)).toBe("https://image.pollinations.ai/prompt/a%20b?model=flux&width=768&height=1344&seed=7&nologo=true&safe=true");
    expect(buildSystemPrompt().startsWith(PERSIAN_SYSTEM_PROMPT)).toBe(true);
    expect(buildSystemPrompt()).toContain("به وقت تهران");
    expect(PERSIAN_SYSTEM_PROMPT).toContain("مطمئن نیستم");
    expect(PERSIAN_SYSTEM_PROMPT.length).toBeLessThan(2000); // cortex slices its system prompt at 2000 chars
  });
});

describe("edit message (truncate + resend)", () => {
  it("deletes the edited user message and everything after it, only for the owner", async () => {
    const { c } = await registeredClient({ deps: makeDeps() });
    const id = await newConv(c);
    const ev1 = await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "اول" }));
    await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "دوم" }));
    const msgs = (await c.json("GET", `/api/conversations/${id}`)).body.messages;
    const second = msgs[2].id;
    expect((await c.json("POST", `/api/conversations/${id}/truncate`, { from_message_id: ev1.at(-1)!.message_id })).status).toBe(404); // assistant id: not allowed
    const other = await registeredClient();
    expect((await other.c.json("POST", `/api/conversations/${id}/truncate`, { from_message_id: second })).status).toBe(404);
    const r = await c.json("POST", `/api/conversations/${id}/truncate`, { from_message_id: second });
    expect(r.body.deleted).toBe(2);
    expect((await c.json("GET", `/api/conversations/${id}`)).body.messages.map((m: any) => m.content)).toEqual(["اول", "پاسخ آزمایشی: اول"]);
  });
});

describe("poetry / quote anti-hallucination guard", () => {
  it("adds a last-position warning and a Ganjoor verification link for quote requests only", async () => {
    const ai = recAi();
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider }) });
    const id = await newConv(c);
    const ev = await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "یک بیت از حافظ دربارهٔ باران بنویس" }));
    const sent = ai.calls[0]!.messages;
    expect(sent.at(-2)).toMatchObject({ role: "system" });
    expect(sent.at(-2)!.content).toContain("هرگز بیت نساز");
    expect(sent.at(-1)).toEqual({ role: "user", content: "یک بیت از حافظ دربارهٔ باران بنویس" });
    expect(ev.find((e) => e.type === "sources")!.sources[0].url).toMatch(/^https:\/\/ganjoor\.net\/search\?s=/);
    await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "یک ایمیل اداری بنویس" }));
    expect(ai.calls[1]!.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });
});

describe("Ganjoor verse grounding", () => {
  it("feeds real couplets for a poet + topic and lists them as sources", async () => {
    const { searchGanjoor, topicTerm, coupletsWith, poetOf } = await import("../src/lib/ganjoor");
    expect(poetOf("یک بیت از حافظ")).toEqual({ id: 2, name: "حافظ" });
    expect(poetOf("شعر نو بگو")).toBeNull();
    expect(topicTerm("یک بیت دقیق از حافظ دربارهٔ باران بنویس")).toBe("باران");
    expect(coupletsWith("الف\nدر سنگ خاره قطره باران اثر نکرد\nب\nج", "باران")).toEqual(["الف / در سنگ خاره قطره باران اثر نکرد"]);
    const urls: string[] = [];
    const fake = (async (u: string) => {
      urls.push(String(u));
      return Response.json([{ fullTitle: "حافظ » غزلیات » غزل شمارهٔ ۱۳۹", fullUrl: "/hafez/ghazal/sh139", plainText: "مصرع یک\\nدر سنگ خاره قطره باران اثر نکرد" .replace("\\\\n", "\n") }]);
    }) as typeof fetch;
    const r = await searchGanjoor("یک بیت از حافظ دربارهٔ باران", { fetchFn: fake });
    expect(urls[0]).toContain("poetId=2");
    expect(r!.verses[0]).toMatchObject({ url: "https://ganjoor.net/hafez/ghazal/sh139" });

    const ai = recAi();
    const { c } = await registeredClient({ deps: makeDeps({ ai: ai.provider, fetch: fake }) });
    const id = await newConv(c);
    const ev = await sse(await c.request("POST", `/api/conversations/${id}/messages`, { content: "یک بیت از حافظ دربارهٔ باران بنویس" }));
    expect(ai.calls[0]!.messages.at(-2)!.content).toContain("غزل شمارهٔ ۱۳۹");
    const s = ev.find((e) => e.type === "sources")!.sources;
    expect(s[0].url).toBe("https://ganjoor.net/hafez/ghazal/sh139");
    expect(s.at(-1).title).toBe("بررسی متن در گنجور");
  });
});
