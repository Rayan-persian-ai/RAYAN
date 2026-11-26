import { cleanOutput, isMostlyPersian, wantsPersian, withPersianInstruction } from "./persian";
import {
  ProviderError,
  type Attempt,
  type ChatMessage,
  type FailureKind,
  type Provider,
  type ProviderStats,
  type RouterResult,
} from "./types";

export interface RouterOptions {
  providers: Provider[];
  now?: () => number;
  /** Consecutive transient failures before the breaker opens. */
  failureThreshold?: number;
  /** First breaker cooldown; doubles on each re-trip, capped at maxCooldownMs. */
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  /** Require Persian output when the user writes Persian (default true). */
  enforcePersian?: boolean;
  /** Called (debounced by the caller if needed) whenever stats change, for persistence. */
  onStateChange?: (snapshot: RouterSnapshot) => void;
  log?: (line: string) => void;
}

export interface RouterSnapshot {
  version: 1;
  stats: Record<string, ProviderStats>;
  lastServed: { provider: string; model: string; at: number } | null;
}

export class AllProvidersFailedError extends Error {
  constructor(readonly attempts: Attempt[]) {
    super(`all AI providers failed: ${attempts.map((a) => `${a.provider}=${a.outcome}${a.reason ? `(${a.reason})` : ""}`).join(", ")}`);
    this.name = "AllProvidersFailedError";
  }
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function freshStats(day: string): ProviderStats {
  return {
    day,
    usedToday: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    breaker: "closed",
    openUntil: 0,
    exhaustedUntil: 0,
    disabledUntil: 0,
    lastCallAt: 0,
    lastOkAt: 0,
    lastError: null,
    lastErrorKind: null,
    avgLatencyMs: 0,
  };
}

function classify(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return new ProviderError("timeout", "timeout");
  return new ProviderError(e instanceof Error ? e.message : String(e), "network");
}

export class AiRouter {
  private readonly providers: Provider[];
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly baseCooldown: number;
  private readonly maxCooldown: number;
  private readonly enforcePersian: boolean;
  private readonly stats = new Map<string, ProviderStats>();
  private readonly trips = new Map<string, number>();
  private readonly halfOpenInFlight = new Set<string>();
  private lastServed: RouterSnapshot["lastServed"] = null;

  constructor(private readonly opts: RouterOptions) {
    // Remote providers keep their configured order; last-resort (local) providers always go last.
    this.providers = [...opts.providers.filter((p) => !p.lastResort), ...opts.providers.filter((p) => p.lastResort)];
    this.now = opts.now ?? Date.now;
    this.threshold = opts.failureThreshold ?? 3;
    this.baseCooldown = opts.baseCooldownMs ?? 30_000;
    this.maxCooldown = opts.maxCooldownMs ?? 10 * 60_000;
    this.enforcePersian = opts.enforcePersian ?? true;
  }

  get providerIds(): string[] {
    return this.providers.map((p) => p.id);
  }

  restore(snapshot: Partial<RouterSnapshot> | null | undefined) {
    if (!snapshot || snapshot.version !== 1 || !snapshot.stats) return;
    for (const p of this.providers) {
      const s = snapshot.stats[p.id];
      if (s) this.stats.set(p.id, { ...freshStats(s.day), ...s, breaker: s.breaker === "half_open" ? "open" : s.breaker });
    }
    this.lastServed = snapshot.lastServed ?? null;
  }

  snapshot(): RouterSnapshot {
    const stats: Record<string, ProviderStats> = {};
    for (const p of this.providers) stats[p.id] = { ...this.stat(p.id) };
    return { version: 1, stats, lastServed: this.lastServed };
  }

  /** Public, secret-free status for /api/ai/status. */
  status() {
    const now = this.now();
    return {
      order: this.providerIds,
      lastServed: this.lastServed,
      providers: this.providers.map((p) => {
        const s = this.stat(p.id);
        return {
          id: p.id,
          label: p.label,
          model: p.model,
          lastResort: Boolean(p.lastResort),
          available: this.skipReason(p, s, now) === null,
          skipReason: this.skipReason(p, s, now),
          breaker: s.breaker,
          usedToday: s.usedToday,
          dailyCap: Number.isFinite(p.dailyCap) && p.dailyCap > 0 ? p.dailyCap : null,
          successes: s.successes,
          failures: s.failures,
          lastOkAt: s.lastOkAt || null,
          lastError: s.lastError,
          lastErrorKind: s.lastErrorKind,
          exhaustedUntil: s.exhaustedUntil > now ? s.exhaustedUntil : null,
          avgLatencyMs: Math.round(s.avgLatencyMs),
        };
      }),
    };
  }

  private stat(id: string): ProviderStats {
    const today = utcDay(this.now());
    let s = this.stats.get(id);
    if (!s) {
      s = freshStats(today);
      this.stats.set(id, s);
    } else if (s.day !== today) {
      // New UTC day: daily counters reset; quota/breaker timers keep their own deadlines.
      s.day = today;
      s.usedToday = 0;
    }
    return s;
  }

  private skipReason(p: Provider, s: ProviderStats, now: number): string | null {
    if (p.lastResort) return null; // never exhausted by design
    if (s.disabledUntil > now) return "auth_disabled";
    if (s.exhaustedUntil > now) return "quota_exhausted";
    if (p.dailyCap > 0 && Number.isFinite(p.dailyCap) && s.usedToday >= p.dailyCap) return "daily_cap";
    if (s.breaker === "open" && s.openUntil > now) return "circuit_open";
    if (s.breaker !== "closed" && this.halfOpenInFlight.has(p.id)) return "circuit_half_open_busy";
    if (p.minIntervalMs > 0 && s.lastCallAt && now - s.lastCallAt < p.minIntervalMs) return "min_interval";
    return null;
  }

  private changed() {
    this.opts.onStateChange?.(this.snapshot());
  }

  private recordFailure(p: Provider, s: ProviderStats, err: ProviderError) {
    const now = this.now();
    s.failures++;
    s.lastError = err.message.slice(0, 300);
    s.lastErrorKind = err.kind;
    switch (err.kind) {
      case "quota":
        s.exhaustedUntil = now + (err.retryAfterMs ?? nextUtcMidnight(now) - now);
        return;
      case "rate":
        s.breaker = "open";
        s.openUntil = now + (err.retryAfterMs ?? 60_000);
        return;
      case "auth":
        s.disabledUntil = now + 60 * 60_000;
        return;
      default: {
        s.consecutiveFailures++;
        if (s.breaker === "half_open" || s.consecutiveFailures >= this.threshold) {
          const trips = (this.trips.get(p.id) ?? 0) + 1;
          this.trips.set(p.id, trips);
          s.breaker = "open";
          s.openUntil = now + Math.min(this.maxCooldown, this.baseCooldown * 2 ** (trips - 1));
        }
      }
    }
  }

  private recordSuccess(p: Provider, s: ProviderStats, ms: number) {
    s.successes++;
    s.consecutiveFailures = 0;
    s.breaker = "closed";
    s.openUntil = 0;
    s.lastOkAt = this.now();
    s.avgLatencyMs = s.avgLatencyMs ? s.avgLatencyMs * 0.8 + ms * 0.2 : ms;
    this.trips.delete(p.id);
  }

  private async waitReady(p: Provider): Promise<boolean> {
    const deadline = Date.now() + (p.readyWaitMs ?? 0);
    for (;;) {
      if (await p.ready!().catch(() => false)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  async chat(messages: ChatMessage[], options: { maxTokens?: number; temperature?: number } = {}): Promise<RouterResult> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const persianWanted = this.enforcePersian && wantsPersian(lastUser);
    const msgs = persianWanted ? withPersianInstruction(messages) : messages;
    const attempts: Attempt[] = [];
    let candidate: RouterResult | null = null;

    for (const p of this.providers) {
      const now = this.now();
      const s = this.stat(p.id);
      const skip = this.skipReason(p, s, now);
      if (skip) {
        attempts.push({ provider: p.id, outcome: "skipped", reason: skip });
        continue;
      }
      if (p.ready && !(await this.waitReady(p))) {
        attempts.push({ provider: p.id, outcome: "skipped", reason: "not_ready" });
        continue;
      }
      const halfOpen = s.breaker === "open" || s.breaker === "half_open"; // cooldown elapsed -> trial call
      if (halfOpen) {
        s.breaker = "half_open";
        this.halfOpenInFlight.add(p.id);
      }
      s.usedToday++; // reserve before the call: a call consumes free allowance whether or not it succeeds
      s.lastCallAt = now;
      const t0 = this.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new DOMException("timeout", "TimeoutError")), p.timeoutMs);
      try {
        const raw = await p.chat(msgs, { maxTokens: options.maxTokens ?? 512, temperature: options.temperature, signal: ac.signal });
        const text = cleanOutput(raw ?? "");
        if (!text) throw new ProviderError("empty response", "bad_response");
        const ms = this.now() - t0;
        this.recordSuccess(p, s, ms);
        const result: RouterResult = { text, provider: p.id, model: p.model, attempts };
        if (persianWanted && !isMostlyPersian(text)) {
          attempts.push({ provider: p.id, outcome: "non_persian", ms });
          this.opts.log?.(`[ai-router] ${p.id} answered but not in Persian; trying next provider`);
          candidate ??= result;
          continue;
        }
        attempts.push({ provider: p.id, outcome: "ok", ms });
        this.lastServed = { provider: p.id, model: p.model, at: this.now() };
        this.opts.log?.(`[ai-router] served by ${p.id} (${p.model}) in ${ms}ms; attempts=${JSON.stringify(attempts)}`);
        return result;
      } catch (e) {
        const err = ac.signal.aborted ? new ProviderError(`timeout after ${p.timeoutMs}ms`, "timeout") : classify(e);
        this.recordFailure(p, s, err);
        attempts.push({ provider: p.id, outcome: "failed", reason: `${err.kind}${err.status ? ` ${err.status}` : ""}: ${err.message.slice(0, 120)}`, ms: this.now() - t0 });
        this.opts.log?.(`[ai-router] ${p.id} failed: ${err.kind} ${err.status ?? ""} ${err.message.slice(0, 200)}`);
      } finally {
        clearTimeout(timer);
        this.halfOpenInFlight.delete(p.id);
        this.changed();
      }
    }

    if (candidate) {
      // Nobody produced Persian: better a correct answer in another language than none.
      this.lastServed = { provider: candidate.provider, model: candidate.model, at: this.now() };
      return { ...candidate, attempts };
    }
    throw new AllProvidersFailedError(attempts);
  }
}

export type { FailureKind };
