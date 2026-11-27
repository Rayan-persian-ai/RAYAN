/**
 * Multi-provider AI chain for the Worker (uses @rayan/ai-router):
 *   1. Workers AI via the `AI` binding — metered by the D1 Cost Controller (service "workers_ai",
 *      AI_DAILY_LIMIT calls/day, sized to stay inside the free 10k neurons/day).
 *   2. Pollinations (anonymous, no key) — politeness interval + its own D1 daily cap ("ai_pollinations").
 *   3. Any keyed provider whose secret exists (HF_TOKEN, GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY
 *      [:free models only], CEREBRAS_API_KEY, MISTRAL_API_KEY, GITHUB_MODELS_TOKEN) — each with a D1 daily cap.
 * The local llama.cpp provider does not exist on Workers. The kill switch (feature flag ai_enabled) is
 * checked by the callers (guardedChat / cortex) before the chain runs.
 */
import {
  AiRouter,
  AllProvidersFailedError,
  ProviderError,
  stringEnv,
  workersProvidersFromEnv,
  type FetchLike,
  type Provider,
  type RouterSnapshot,
} from "@rayan/ai-router";
import type { AiProvider, ChatCallOptions, ChatTurn } from "../deps";
import type { Env } from "../env";
import { AI_SERVICE, envAiLimit, reserveUsage } from "./cost";
import { GEMINI_SERVICE, geminiKey, geminiStream, type ImagePart } from "./gemini";
import { findModel, geminiOrder, unitsFor, WA_AUTO_TEXT, WA_AUTO_VISION, MODELS } from "./models";
import { intVar } from "../env";

/** Every provider in the chain refused for quota/cap reasons (not an error): maps to 429 daily_cap_reached. */
export class AiCapError extends Error {
  constructor(readonly attempts: unknown) {
    super("all AI providers are at their daily cap");
    this.name = "AiCapError";
  }
}

/** D1 cost-controller service name per provider (workers-ai keeps the original "workers_ai" counter). */
export function serviceFor(providerId: string): string {
  return providerId === "workers-ai" ? AI_SERVICE : `ai_${providerId.replace(/-/g, "_")}`;
}

const CAP_RETRY_MS = 5 * 60_000; // re-check D1 every 5 min, so a super_admin raising a cap takes effect quickly

/** Wraps a provider so each call first reserves one unit in D1 (atomic, cross-isolate). */
function metered(p: Provider, env: Env, now: () => number): Provider {
  const limit = p.id === "workers-ai" ? envAiLimit(env) : p.dailyCap > 0 && Number.isFinite(p.dailyCap) ? p.dailyCap : 0;
  return {
    ...p,
    chat: async (messages, opts) => {
      if (limit > 0 || p.id === "workers-ai") {
        const r = await reserveUsage(env.DB, serviceFor(p.id), limit, now());
        if (!r.allowed) throw new ProviderError(`${p.id}: RAYAN daily cap ${r.count}/${r.limit}`, "quota", undefined, CAP_RETRY_MS);
      }
      return p.chat(messages, opts);
    },
  };
}

const QUOTA_REASONS = /^(quota|daily_cap|quota_exhausted)/;

export interface ChainOptions {
  fetch?: FetchLike;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ChainProvider extends AiProvider {
  chatDetailed(env: Env, messages: ChatTurn[], opts?: ChatCallOptions): Promise<{ text: string; provider: string; model: string }>;
  chatStream(env: Env, messages: ChatTurn[], opts?: ChatCallOptions): Promise<{ stream: AsyncIterable<string>; provider: string; model: string }>;
  providerIds(env: Env): string[];
}

export function createChainProvider(opts: ChainOptions = {}): ChainProvider {
  const now = opts.now ?? (() => Date.now());
  // Isolate-local breaker/interval state carried across requests (D1 holds the authoritative daily counts).
  let snapshot: RouterSnapshot | null = null;
  const build = (env: Env) => workersProvidersFromEnv(stringEnv(env), { ai: env.AI as never, fetch: opts.fetch });

  const chatDetailed = async (env: Env, messages: ChatTurn[], o: ChatCallOptions = {}) => {
    const providers = build(env).map((p) => metered(p, env, now));
    const router = new AiRouter({
      providers,
      now,
      onStateChange: (s) => (snapshot = s),
      log: opts.log ?? ((l) => console.log(l)),
    });
    router.restore(snapshot);
    try {
      const r = await router.chat(messages, { maxTokens: clampTokens(o.maxTokens) });
      return { text: r.text, provider: r.provider, model: r.model };
    } catch (e) {
      if (e instanceof AllProvidersFailedError) {
        const allCapped = e.attempts.length > 0 && e.attempts.every((a) => QUOTA_REASONS.test(a.reason ?? ""));
        if (allCapped) throw new AiCapError(e.attempts);
      }
      throw e;
    }
  };

  /**
   * Streaming answer with the model picker + fallback:
   *   1. Gemini (free AI Studio key, if provisioned) — model order from lib/models.ts, metered by "ai_gemini".
   *   2. Workers AI binding (stream:true) — chosen / auto models, each reserving its `units` of AI_DAILY_LIMIT.
   *   3. The non-streaming chain (Pollinations / keyed providers), yielded as one chunk.
   * Any refusal before the first byte (quota 429, overload 503, retired model 404, cap) falls through.
   */
  const chatStream = async (env: Env, messages: ChatTurn[], o: ChatCallOptions = {}) => {
    const log = opts.log ?? ((l: string) => console.log(l));
    const info = findModel(o.model);
    const images: ImagePart[] = o.images ?? [];
    const maxTokens = clampTokens(o.maxTokens);
    const disabledList = String((env as unknown as Record<string, unknown>).AI_DISABLE ?? "").split(",").map((x) => x.trim());
    const fetchFn = (opts.fetch as typeof fetch | undefined) ?? fetch;

    // 1) Gemini
    if ((info.provider === "auto" || info.provider === "gemini") && !disabledList.includes("gemini")) {
      const key = await geminiKey(env);
      if (key) {
        const r = await reserveUsage(env.DB, GEMINI_SERVICE, intVar((env as { GEMINI_DAILY_LIMIT?: string }).GEMINI_DAILY_LIMIT, 1000), now());
        if (r.allowed) {
          const base = geminiOrder(env as { GEMINI_MODELS?: string });
          const order = info.provider === "gemini" ? [info.upstream!, ...base.filter((m) => m !== info.upstream)] : base;
          for (const m of order) {
            try {
              const stream = await geminiStream(key, m, messages, { maxTokens, images, fetchFn });
              return { stream, provider: "gemini", model: m };
            } catch (e) {
              log(`gemini ${m} refused, trying next: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
    }

    // 2) Workers AI
    const ai = env.AI as unknown as { run(model: string, inputs: Record<string, unknown>): Promise<unknown> } | undefined;
    if (ai && !disabledList.includes("workers-ai")) {
      const auto = images.length ? WA_AUTO_VISION : WA_AUTO_TEXT;
      let list = info.provider === "workers-ai" ? [info.upstream!, ...auto.filter((m) => m !== info.upstream)] : auto;
      if (images.length) list = list.filter((m) => MODELS.some((x) => x.upstream === m && x.vision));
      for (const model of list) {
        let ok = true;
        for (let u = 0; u < unitsFor(model); u++) {
          const r = await reserveUsage(env.DB, AI_SERVICE, envAiLimit(env), now());
          if (!r.allowed) ok = false;
        }
        if (!ok) break; // daily Workers AI budget used up → next provider
        try {
          const msgs = images.length ? withImages(messages, images) : messages;
          const reasoning = /gpt-oss/.test(model) ? 1536 : 0;
          const out = await ai.run(model, { messages: msgs, max_tokens: maxTokens + reasoning, stream: true });
          if (out instanceof ReadableStream) return { stream: workersAiDeltas(out), provider: "workers-ai", model };
          const text = responseText(out);
          if (text) return { stream: once(text), provider: "workers-ai", model };
        } catch (e) {
          log(`workers-ai ${model} failed, falling back: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // 3) Rest of the chain, non-streaming (workers-ai/gemini skipped so they are not charged twice).
    const rest = { ...env, AI: undefined, AI_DISABLE: [...disabledList, "gemini"].filter(Boolean).join(",") } as unknown as Env;
    const d = await chatDetailed(rest, messages, o);
    return { stream: once(d.text), provider: d.provider, model: d.model };
  };

  return {
    name: "chain",
    chatStream,
    selfMetered: true,
    isAvailable: (env) => build(env).length > 0,
    providerIds: (env) => build(env).map((p) => p.id),
    chatDetailed,
    chat: async (env, messages, o) => (await chatDetailed(env, messages, o)).text,
  };
}

/** Output budget per call: default 1024 tokens, never above 2048 (keeps neuron cost bounded). */
export function clampTokens(n: number | undefined): number {
  if (!n || !Number.isFinite(n)) return 1024;
  return Math.max(64, Math.min(2048, Math.floor(n)));
}

/** OpenAI-style content array with data-URL images on the last user turn (Workers AI vision models). */
export function withImages(messages: ChatTurn[], images: ImagePart[]): ChatTurn[] {
  const idx = messages.map((m) => m.role).lastIndexOf("user");
  return messages.map((m, i) =>
    i === idx
      ? ({ role: m.role, content: [{ type: "text", text: m.content }, ...images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } }))] } as unknown as ChatTurn)
      : m,
  );
}

/** Text of a non-streaming Workers AI result ({response} or OpenAI-style choices). */
export function responseText(out: unknown): string {
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  if (typeof o?.response === "string") return o.response;
  const c = o?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

async function* once(text: string): AsyncIterable<string> {
  yield text;
}

/** Parses the Workers AI SSE byte stream (`data: {"response":"…"}` … `data: [DONE]`) into text deltas. */
export async function* workersAiDeltas(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as { response?: unknown; choices?: { delta?: { content?: unknown } }[] };
          const t = typeof j.response === "string" ? j.response : j.choices?.[0]?.delta?.content;
          if (typeof t === "string" && t) yield t;
        } catch {
          /* partial or non-JSON line */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
