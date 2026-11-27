import { ProviderError, type CallOptions, type ChatMessage, type Provider } from "../types";
import { hfRouterProvider, KEYED_PROVIDERS, keyedProvider, pollinationsProvider, type EnvLike } from "./index";
import type { FetchLike } from "./http";

/** Minimal shape of the Cloudflare Workers AI binding (`env.AI`), so this package needs no workers-types. */
export interface AiBindingLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

const QUOTA = /(4006|daily free allocation|neurons|quota|exceeded your|capacity)/i;
const RATE = /(3040|rate limit|too many requests|429)/i;

/**
 * (a') Cloudflare Workers AI through the Worker's own `AI` binding — no token, no network hop.
 * Daily neuron budget (free: 10k/day) is enforced by the caller's cost controller, not here; this
 * provider only maps binding errors (4006 = daily free allocation used) to router failure kinds.
 */
export function workersAiBindingProvider(ai: AiBindingLike | undefined, env: EnvLike = {}): Provider | null {
  if (!ai) return null;
  const model = env.AI_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct";
  return {
    id: "workers-ai",
    label: "Cloudflare Workers AI (binding)",
    model,
    dailyCap: 0, // enforced outside (D1 cost controller, AI_DAILY_LIMIT)
    minIntervalMs: 0,
    timeoutMs: Number(env.WORKERS_AI_TIMEOUT_MS) || 30_000,
    async chat(messages: ChatMessage[], opts: CallOptions) {
      let out: unknown;
      try {
        out = await ai.run(model, { messages, max_tokens: (opts.maxTokens ?? 1024) + (/gpt-oss/.test(model) ? 1536 : 0) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (QUOTA.test(msg)) throw new ProviderError(`workers-ai: ${msg}`, "quota");
        if (RATE.test(msg)) throw new ProviderError(`workers-ai: ${msg}`, "rate");
        throw new ProviderError(`workers-ai: ${msg}`, "server");
      }
      const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
      const r = typeof o?.response === "string" ? o.response : o?.choices?.[0]?.message?.content;
      if (typeof r !== "string" || !r) throw new ProviderError("workers-ai: unexpected response shape", "bad_response");
      return r;
    },
  };
}

/**
 * Provider chain for Cloudflare Workers (no local model — workerd cannot run llama.cpp):
 * workers-ai (binding) -> pollinations (anonymous, no key) -> keyed providers whose secret exists
 * (hf-router, groq, gemini, openrouter[:free only], cerebras, mistral, github).
 * AI_DISABLE (csv) removes providers; AI_PROVIDER_ORDER (csv) reorders them.
 */
export function workersProvidersFromEnv(env: EnvLike, c: { ai?: AiBindingLike; fetch?: FetchLike } = {}): Provider[] {
  const all = [
    workersAiBindingProvider(c.ai, env),
    pollinationsProvider(env, c),
    hfRouterProvider(env, c),
    ...KEYED_PROVIDERS.map((s) => keyedProvider(s, env, c)),
  ].filter((p): p is Provider => p !== null);
  const disabled = new Set((env.AI_DISABLE || "").split(",").map((s) => s.trim()).filter(Boolean));
  let list = all.filter((p) => !disabled.has(p.id));
  const order = (env.AI_PROVIDER_ORDER || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (order.length) {
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length + all.findIndex((p) => p.id === id));
    list = [...list].sort((a, b) => rank(a.id) - rank(b.id));
  }
  return list;
}

/** Copies only string values (Worker env also carries bindings such as DB/AI objects). */
export function stringEnv(env: object): EnvLike {
  const out: EnvLike = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}
