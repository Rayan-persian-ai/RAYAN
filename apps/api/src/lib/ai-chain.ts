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
   * Streams from Workers AI (binding, stream:true) after reserving one unit of the D1 daily cap.
   * If the binding is missing, the cap is reached or the binding refuses before the first byte,
   * falls back to the whole non-streaming chain (Pollinations / keyed providers) and yields its
   * answer as a single chunk — so the caller always gets the same streaming interface.
   */
  const chatStream = async (env: Env, messages: ChatTurn[], o: ChatCallOptions = {}) => {
    const ai = env.AI as unknown as { run(model: string, inputs: Record<string, unknown>): Promise<unknown> } | undefined;
    const model = env.AI_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct";
    const disabled = (env as unknown as Record<string, unknown>).AI_DISABLE;
    const wantWorkers = ai && !(typeof disabled === "string" && disabled.split(",").map((x) => x.trim()).includes("workers-ai"));
    if (wantWorkers) {
      const r = await reserveUsage(env.DB, AI_SERVICE, envAiLimit(env), now());
      if (r.allowed) {
        try {
          const out = await ai!.run(model, { messages, max_tokens: clampTokens(o.maxTokens), stream: true });
          if (out instanceof ReadableStream) return { stream: workersAiDeltas(out), provider: "workers-ai", model };
          const text = (out as { response?: unknown } | null)?.response;
          if (typeof text === "string" && text) return { stream: once(text), provider: "workers-ai", model };
        } catch (e) {
          (opts.log ?? ((l) => console.log(l)))(`workers-ai stream failed, falling back: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // Fallback: rest of the chain, non-streaming (workers-ai is skipped so it is not charged twice).
    const rest = { ...env, AI: undefined } as Env;
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
