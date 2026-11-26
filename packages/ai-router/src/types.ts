export type Role = "system" | "user" | "assistant";
export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CallOptions {
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
}

/**
 * Why a provider call failed. The router maps each kind to a different penalty:
 * - quota:    the provider's free allowance is used up -> skip until it resets (default: next UTC midnight)
 * - rate:     short-term rate limit -> cool down (Retry-After or 60s)
 * - auth:     key missing/invalid -> disable for an hour (operator must fix)
 * - server/network/timeout/bad_response: transient -> counts toward the circuit breaker
 */
export type FailureKind = "quota" | "rate" | "auth" | "server" | "network" | "timeout" | "bad_response";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Provider {
  /** Stable id, e.g. "cloudflare", "hf-router", "pollinations", "groq", "local". */
  readonly id: string;
  /** Human label for status output. */
  readonly label: string;
  /** Model id actually used (for status / logs). */
  readonly model: string;
  /** Max successful calls per UTC day (0 or Infinity = unlimited). Enforced by the router, not the provider. */
  readonly dailyCap: number;
  /** Minimum gap between two calls to this provider (politeness / free-tier terms). 0 = none. */
  readonly minIntervalMs: number;
  /** Per-call timeout. */
  readonly timeoutMs: number;
  /** Local last resort: never quota-limited, always attempted when everything else failed. */
  readonly lastResort?: boolean;
  /** Optional cheap readiness probe (e.g. local llama.cpp still loading the model). */
  ready?(): Promise<boolean>;
  /** How long the router may wait for ready() to turn true (e.g. local model still loading). Default 0. */
  readonly readyWaitMs?: number;
  chat(messages: ChatMessage[], opts: CallOptions): Promise<string>;
}

export type BreakerState = "closed" | "open" | "half_open";

export interface ProviderStats {
  day: string; // UTC yyyy-mm-dd the counters belong to
  usedToday: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  breaker: BreakerState;
  openUntil: number; // epoch ms, breaker open / cooldown until
  exhaustedUntil: number; // epoch ms, quota exhausted until
  disabledUntil: number; // epoch ms, auth failure
  lastCallAt: number;
  lastOkAt: number;
  lastError: string | null;
  lastErrorKind: FailureKind | null;
  avgLatencyMs: number;
}

export interface Attempt {
  provider: string;
  outcome: "ok" | "skipped" | "failed" | "non_persian";
  reason?: string;
  ms?: number;
}

export interface RouterResult {
  text: string;
  provider: string;
  model: string;
  attempts: Attempt[];
}
