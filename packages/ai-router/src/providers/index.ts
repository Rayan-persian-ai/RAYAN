import { ProviderError, type CallOptions, type ChatMessage, type Provider } from "../types";
import { httpError, openAiCompatChat, type FetchLike } from "./http";

export type EnvLike = Record<string, string | undefined>;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};
const flag = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));

interface Common {
  fetch?: FetchLike;
}

function base(env: EnvLike, id: string, defaults: { cap: number; interval?: number; timeout?: number }) {
  const key = id.toUpperCase().replace(/-/g, "_");
  return {
    dailyCap: num(env[`${key}_DAILY_CAP`], defaults.cap),
    minIntervalMs: num(env[`${key}_MIN_INTERVAL_MS`], defaults.interval ?? 0),
    timeoutMs: num(env[`${key}_TIMEOUT_MS`], defaults.timeout ?? 30_000),
  };
}

/** (a) Cloudflare Workers AI over REST (free: 10k neurons/day per account). */
export function cloudflareProvider(env: EnvLike, c: Common = {}): Provider | null {
  const acct = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!acct || !token) return null;
  const model = env.CF_AI_MODEL || env.AI_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct";
  const f = c.fetch ?? fetch;
  return {
    id: "cloudflare",
    label: "Cloudflare Workers AI (REST)",
    model,
    ...base(env, "cloudflare", { cap: 150 }),
    async chat(messages: ChatMessage[], opts: CallOptions) {
      const res = await f(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acct)}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ messages, max_tokens: opts.maxTokens }),
        signal: opts.signal,
      });
      if (!res.ok) throw await httpError(res, "cloudflare");
      const j = (await res.json()) as { success?: boolean; result?: { response?: unknown }; errors?: Array<{ code?: number; message?: string }> };
      if (j.errors?.some((e) => e.code === 4006)) throw new ProviderError("cloudflare daily free allocation used", "quota");
      if (!j.success || typeof j.result?.response !== "string") throw new ProviderError("cloudflare: unexpected response", "bad_response");
      return j.result.response;
    },
  };
}

/** (b) Hugging Face Inference Providers router (OpenAI-compatible). Free monthly credits; 402 when used up. */
export function hfRouterProvider(env: EnvLike, c: Common = {}): Provider | null {
  const token = env.HF_TOKEN;
  if (!token || !flag(env.HF_ROUTER_ENABLED, true)) return null;
  const model = env.HF_ROUTER_MODEL || "google/gemma-3-4b-it:cheapest";
  return {
    id: "hf-router",
    label: "Hugging Face Inference Providers",
    model,
    ...base(env, "hf-router", { cap: 50 }),
    async chat(messages, opts) {
      try {
        return await openAiCompatChat(
          "hf-router",
          { url: "https://router.huggingface.co/v1/chat/completions", model, headers: { authorization: `Bearer ${token}` }, fetch: c.fetch },
          messages,
          opts,
        );
      } catch (e) {
        // Free credits are monthly: re-probe every 6h instead of hammering (402 costs nothing, but be polite).
        if (e instanceof ProviderError && e.kind === "quota") throw new ProviderError(e.message, "quota", e.status, 6 * 3600_000);
        throw e;
      }
    },
  };
}

/** (c) Pollinations text API: free, anonymous tier. One request per 15 s per their published anonymous limits. */
export function pollinationsProvider(env: EnvLike, c: Common = {}): Provider | null {
  if (!flag(env.POLLINATIONS_ENABLED, true)) return null;
  const model = env.POLLINATIONS_MODEL || "openai";
  const referrer = env.POLLINATIONS_REFERRER || "rayan-platform";
  return {
    id: "pollinations",
    label: "Pollinations (anonymous)",
    model,
    ...base(env, "pollinations", { cap: 300, interval: 15_000, timeout: 45_000 }),
    chat: (messages, opts) =>
      openAiCompatChat(
        "pollinations",
        { url: "https://text.pollinations.ai/openai", model, extraBody: { referrer, private: true }, fetch: c.fetch },
        messages,
        opts,
      ),
  };
}

interface KeyedSpec {
  id: string;
  label: string;
  envKey: string;
  modelEnv: string;
  defaultModel: string;
  url: string;
  cap: number;
  interval?: number;
  validateModel?: (m: string) => string | null;
}

/** (d) Optional providers: each uses ONE user-supplied key and is disabled unless that key exists. */
export const KEYED_PROVIDERS: KeyedSpec[] = [
  { id: "groq", label: "Groq", envKey: "GROQ_API_KEY", modelEnv: "GROQ_MODEL", defaultModel: "llama-3.3-70b-versatile", url: "https://api.groq.com/openai/v1/chat/completions", cap: 500, interval: 2_000 },
  { id: "gemini", label: "Google Gemini", envKey: "GEMINI_API_KEY", modelEnv: "GEMINI_MODEL", defaultModel: "gemini-2.5-flash", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", cap: 200, interval: 6_000 },
  {
    id: "openrouter",
    label: "OpenRouter (:free models only)",
    envKey: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    cap: 45, // OpenRouter free models: 50 req/day without purchased credits
    interval: 4_000,
    validateModel: (m) => (m.endsWith(":free") ? null : "OPENROUTER_MODEL must end with ':free' (zero-cost policy)"),
  },
  { id: "cerebras", label: "Cerebras", envKey: "CEREBRAS_API_KEY", modelEnv: "CEREBRAS_MODEL", defaultModel: "llama3.1-8b", url: "https://api.cerebras.ai/v1/chat/completions", cap: 500, interval: 2_000 },
  { id: "mistral", label: "Mistral", envKey: "MISTRAL_API_KEY", modelEnv: "MISTRAL_MODEL", defaultModel: "mistral-small-latest", url: "https://api.mistral.ai/v1/chat/completions", cap: 300, interval: 1_500 },
  { id: "github", label: "GitHub Models", envKey: "GITHUB_MODELS_TOKEN", modelEnv: "GITHUB_MODELS_MODEL", defaultModel: "openai/gpt-4.1-mini", url: "https://models.github.ai/inference/chat/completions", cap: 140, interval: 4_000 },
];

export function keyedProvider(spec: KeyedSpec, env: EnvLike, c: Common = {}): Provider | null {
  const key = env[spec.envKey];
  if (!key) return null;
  const model = env[spec.modelEnv] || spec.defaultModel;
  const invalid = spec.validateModel?.(model);
  if (invalid) {
    console.warn(`[ai-router] ${spec.id} disabled: ${invalid}`);
    return null;
  }
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (spec.id === "openrouter") {
    headers["HTTP-Referer"] = env.PUBLIC_URL || "https://tm13911391-rayan-platform.hf.space";
    headers["X-Title"] = "Rayan Platform";
  }
  return {
    id: spec.id,
    label: spec.label,
    model,
    ...base(env, spec.id, { cap: spec.cap, interval: spec.interval }),
    chat: (messages, opts) => openAiCompatChat(spec.id, { url: spec.url, model, headers, fetch: c.fetch }, messages, opts),
  };
}

/** (e) Last resort: llama.cpp server in the same container. No credits, never exhausted. */
export function localLlamaProvider(env: EnvLike, c: Common = {}): Provider | null {
  if (!flag(env.LOCAL_LLM_ENABLED, true)) return null;
  const baseUrl = (env.LOCAL_LLM_URL || "http://127.0.0.1:8081").replace(/\/$/, "");
  const model = env.LOCAL_LLM_MODEL || "rayan-gemma3-1b-q4km";
  const maxTokens = num(env.LOCAL_LLM_MAX_TOKENS, 384);
  const f = c.fetch ?? fetch;
  let readyCache = { at: 0, ok: false };
  return {
    id: "local",
    label: "Local llama.cpp (gemma-3-1b Q4_K_M, CPU)",
    model,
    dailyCap: 0,
    minIntervalMs: 0,
    timeoutMs: num(env.LOCAL_TIMEOUT_MS, 180_000),
    lastResort: true,
    readyWaitMs: num(env.LOCAL_READY_WAIT_MS, 30_000),
    async ready() {
      const now = Date.now();
      if (readyCache.ok && now - readyCache.at < 5_000) return true;
      try {
        const r = await f(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
        readyCache = { at: now, ok: r.ok };
      } catch {
        readyCache = { at: now, ok: false };
      }
      return readyCache.ok;
    },
    chat: (messages, opts) =>
      openAiCompatChat(
        "local",
        { url: `${baseUrl}/v1/chat/completions`, model, fetch: c.fetch, extraBody: { cache_prompt: true } },
        messages,
        { ...opts, maxTokens: Math.min(opts.maxTokens, maxTokens) },
      ),
  };
}

/**
 * Builds the provider chain from env, in the documented order:
 * cloudflare -> hf-router -> pollinations -> groq, gemini, openrouter, cerebras, mistral, github -> local.
 * AI_PROVIDER_ORDER (csv of ids) reorders remote providers; AI_DISABLE (csv) removes any.
 */
export function providersFromEnv(env: EnvLike, c: Common = {}): Provider[] {
  const all = [
    cloudflareProvider(env, c),
    hfRouterProvider(env, c),
    pollinationsProvider(env, c),
    ...KEYED_PROVIDERS.map((s) => keyedProvider(s, env, c)),
    localLlamaProvider(env, c),
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
