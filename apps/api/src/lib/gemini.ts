/**
 * Google Gemini (AI Studio free tier) — native REST, streaming via :streamGenerateContent?alt=sse.
 * Key: GEMINI_API_KEY Worker secret, else the AES-GCM copy in D1 app_secrets ("gemini_api_key",
 * provisioned through the one-time /api/admin/provision/gemini route). The key is never logged or returned.
 */
import type { ChatTurn } from "../deps";
import type { Env } from "../env";
import { getSecret } from "./secretbox";

export const GEMINI_SERVICE = "ai_gemini";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

export class GeminiError extends Error {
  constructor(readonly status: number, msg: string) {
    super(msg);
  }
}

let cached: { v: string | null; at: number } | null = null;
export function resetGeminiKey() {
  cached = null;
}
export async function geminiKey(env: Env): Promise<string | null> {
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  if (!env.DATA_ENC_KEY) return null;
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.v;
  let v: string | null = null;
  try {
    v = await getSecret(env, "gemini_api_key");
  } catch {
    v = null;
  }
  cached = { v, at: Date.now() };
  return v;
}

export interface ImagePart {
  mime: string;
  /** base64 (no data: prefix) */
  data: string;
}

/** Converts chat turns to Gemini's {systemInstruction, contents}; images are attached to the last user turn. */
export function toGemini(messages: ChatTurn[], images: ImagePart[] = []) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  const contents: { role: "user" | "model"; parts: Record<string, unknown>[] }[] = [];
  turns.forEach((m, i) => {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: Record<string, unknown>[] = [{ text: m.content }];
    if (i === turns.length - 1 && role === "user") for (const im of images) parts.push({ inlineData: { mimeType: im.mime, data: im.data } });
    const prev = contents.at(-1);
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  });
  return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents };
}

/** Parses Gemini SSE into text deltas (thought parts are skipped). */
export async function* geminiDeltas(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const j = JSON.parse(line.slice(5).trim()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
          for (const p of j.candidates?.[0]?.content?.parts ?? []) if (!p.thought && typeof p.text === "string" && p.text) yield p.text;
        } catch {
          /* partial line */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Starts a streaming generation. Resolves once Google accepted the request (HTTP 200), so callers can
 * fall through to the next model/provider on 429 (quota) / 503 (overloaded) / 404 (retired model).
 */
export async function geminiStream(
  key: string,
  model: string,
  messages: ChatTurn[],
  o: { maxTokens: number; images?: ImagePart[]; fetchFn?: typeof fetch; thinking?: boolean },
): Promise<AsyncIterable<string>> {
  const f = o.fetchFn ?? fetch;
  const body = (thinking: boolean) =>
    JSON.stringify({
      ...toGemini(messages, o.images),
      generationConfig: { maxOutputTokens: o.maxTokens + (thinking ? 2048 : 0), temperature: 0.7, ...(thinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}) },
      safetySettings: [],
    });
  const call = (thinking: boolean) =>
    f(`${BASE}${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: body(thinking),
    });
  const wantThinking = o.thinking !== false && !/lite/.test(model);
  let r = await call(wantThinking);
  if (r.status === 400 && wantThinking) {
    await r.body?.cancel();
    r = await call(false); // model without thinkingConfig support
  }
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => "");
    let msg = `${r.status}`;
    try {
      msg = (JSON.parse(t) as { error?: { message?: string } }).error?.message?.slice(0, 160) ?? msg;
    } catch {
      /* keep status */
    }
    throw new GeminiError(r.status, `gemini ${model}: ${msg}`);
  }
  return geminiDeltas(r.body);
}
