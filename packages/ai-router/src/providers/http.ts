import { ProviderError, type CallOptions, type ChatMessage } from "../types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(1000, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(1000, at - Date.now()) : undefined;
}

const QUOTA_HINT = /(quota|daily|per day|exhaust|credits|insufficient|billing|allocation|limit reached for today|free tier)/i;

/** Maps an HTTP error response to a ProviderError the router understands. */
export async function httpError(res: Response, provider: string): Promise<ProviderError> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    /* ignore */
  }
  const msg = `${provider} HTTP ${res.status}: ${body.replace(/\s+/g, " ").trim()}`;
  const s = res.status;
  if (s === 402) return new ProviderError(msg, "quota", s);
  if (s === 429) return QUOTA_HINT.test(body) ? new ProviderError(msg, "quota", s, retryAfterMs(res)) : new ProviderError(msg, "rate", s, retryAfterMs(res));
  if (s === 401 || s === 403) return new ProviderError(msg, "auth", s);
  if (s === 408 || s === 504) return new ProviderError(msg, "timeout", s);
  return new ProviderError(msg, "server", s);
}

/** Extracts assistant text from an OpenAI-compatible chat completion body. */
export function openAiText(json: unknown): string {
  const c = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join("");
  throw new ProviderError("unexpected response shape", "bad_response");
}

export interface OpenAiCompatConfig {
  url: string; // full .../chat/completions URL
  model: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  fetch?: FetchLike;
}

export async function openAiCompatChat(provider: string, cfg: OpenAiCompatConfig, messages: ChatMessage[], opts: CallOptions): Promise<string> {
  const f = cfg.fetch ?? fetch;
  const res = await f(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...cfg.headers },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: opts.maxTokens,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      stream: false,
      ...cfg.extraBody,
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw await httpError(res, provider);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ProviderError(`${provider}: invalid JSON`, "bad_response", res.status);
  }
  return openAiText(json);
}
