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
import type { AiProvider, ChatTurn } from "../deps";
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
  chatDetailed(env: Env, messages: ChatTurn[]): Promise<{ text: string; provider: string; model: string }>;
  providerIds(env: Env): string[];
}

export function createChainProvider(opts: ChainOptions = {}): ChainProvider {
  const now = opts.now ?? (() => Date.now());
  // Isolate-local breaker/interval state carried across requests (D1 holds the authoritative daily counts).
  let snapshot: RouterSnapshot | null = null;
  const build = (env: Env) => workersProvidersFromEnv(stringEnv(env), { ai: env.AI as never, fetch: opts.fetch });

  const chatDetailed = async (env: Env, messages: ChatTurn[]) => {
    const providers = build(env).map((p) => metered(p, env, now));
    const router = new AiRouter({
      providers,
      now,
      onStateChange: (s) => (snapshot = s),
      log: opts.log ?? ((l) => console.log(l)),
    });
    router.restore(snapshot);
    try {
      const r = await router.chat(messages, { maxTokens: 512 });
      return { text: r.text, provider: r.provider, model: r.model };
    } catch (e) {
      if (e instanceof AllProvidersFailedError) {
        const allCapped = e.attempts.length > 0 && e.attempts.every((a) => QUOTA_REASONS.test(a.reason ?? ""));
        if (allCapped) throw new AiCapError(e.attempts);
      }
      throw e;
    }
  };

  return {
    name: "chain",
    selfMetered: true,
    isAvailable: (env) => build(env).length > 0,
    providerIds: (env) => build(env).map((p) => p.id),
    chatDetailed,
    chat: async (env, messages) => (await chatDetailed(env, messages)).text,
  };
}
