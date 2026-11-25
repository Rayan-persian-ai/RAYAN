import type { D1DatabaseLike } from './d1.js';
import { CortexError } from './types.js';
import { dayKey, systemClock, type Clock } from './util.js';

/** Storage for usage counters. Implementations must make increment atomic per key. */
export interface QuotaStore {
  get(key: string): Promise<number>;
  /** Atomically add `amount` (may be negative) and return the new total. */
  increment(key: string, amount: number): Promise<number>;
}

export class InMemoryQuotaStore implements QuotaStore {
  private readonly m = new Map<string, number>();
  async get(key: string) {
    return this.m.get(key) ?? 0;
  }
  async increment(key: string, amount: number) {
    const v = (this.m.get(key) ?? 0) + amount;
    this.m.set(key, v);
    return v;
  }
}

/** D1-backed quota counters (table cortex_quota_usage). Uses a single UPSERT ... RETURNING for atomicity. */
export class D1QuotaStore implements QuotaStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async get(key: string) {
    const row = await this.db.prepare('SELECT used FROM cortex_quota_usage WHERE key = ?1').bind(key).first<{ used: number }>();
    return row ? Number(row.used) : 0;
  }
  async increment(key: string, amount: number) {
    const row = await this.db
      .prepare(
        'INSERT INTO cortex_quota_usage (key, used, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at RETURNING used',
      )
      .bind(key, amount, Date.now())
      .first<{ used: number }>();
    return row ? Number(row.used) : amount;
  }
}

export interface QuotaConfig {
  /** Maximum units per day (requests, tokens, neurons…). 0 means disabled. */
  daily: number;
  unit?: string;
}

export interface QuotaStatus {
  service: string;
  limit: number;
  used: number;
  remaining: number;
  allowed: boolean;
  day: string;
}

export class QuotaExceededError extends CortexError {
  constructor(readonly status: QuotaStatus) {
    super('quota_exceeded', `Daily quota for "${status.service}" exhausted (${status.used}/${status.limit})`, { retryable: false, details: status });
    this.name = 'QuotaExceededError';
  }
}

export interface CostControllerOptions {
  store?: QuotaStore;
  clock?: Clock;
  /** Offset from UTC in minutes for the daily reset (e.g. 210 for Asia/Tehran). Default 0 (UTC). */
  resetOffsetMinutes?: number;
  /** Unknown services are denied unless this is true (zero-budget default: deny). */
  allowUnknown?: boolean;
}

/**
 * Per-service daily quotas with a hard stop. consume() reserves first and rolls back on overflow,
 * so concurrent callers cannot overshoot the limit on an atomic store.
 */
export class CostController {
  private readonly quotas = new Map<string, QuotaConfig>();
  private readonly store: QuotaStore;
  private readonly clock: Clock;
  constructor(quotas: Record<string, QuotaConfig> = {}, private readonly opts: CostControllerOptions = {}) {
    this.store = opts.store ?? new InMemoryQuotaStore();
    this.clock = opts.clock ?? systemClock;
    for (const [k, v] of Object.entries(quotas)) this.setQuota(k, v);
  }

  setQuota(service: string, cfg: QuotaConfig) {
    if (!Number.isFinite(cfg.daily) || cfg.daily < 0) throw new Error(`invalid daily quota for ${service}`);
    this.quotas.set(service, cfg);
  }

  hasService(service: string) {
    return this.quotas.has(service);
  }

  private key(service: string) {
    const day = dayKey(this.clock(), this.opts.resetOffsetMinutes ?? 0);
    return { key: `${service}:${day}`, day };
  }

  async status(service: string, amount = 1): Promise<QuotaStatus> {
    const { key, day } = this.key(service);
    const cfg = this.quotas.get(service);
    if (!cfg) {
      const allowed = !!this.opts.allowUnknown;
      return { service, limit: allowed ? Infinity : 0, used: 0, remaining: allowed ? Infinity : 0, allowed, day };
    }
    const used = await this.store.get(key);
    return { service, limit: cfg.daily, used, remaining: Math.max(0, cfg.daily - used), allowed: used + amount <= cfg.daily, day };
  }

  /** True when the next `amount` units would fit. */
  async canSpend(service: string, amount = 1) {
    return (await this.status(service, amount)).allowed;
  }

  /** Reserve units; throws QuotaExceededError (non-retryable) when it would exceed the limit. */
  async consume(service: string, amount = 1): Promise<QuotaStatus> {
    if (!(amount > 0)) throw new Error('amount must be > 0');
    const cfg = this.quotas.get(service);
    const { key, day } = this.key(service);
    if (!cfg) {
      if (this.opts.allowUnknown) return { service, limit: Infinity, used: 0, remaining: Infinity, allowed: true, day };
      throw new QuotaExceededError({ service, limit: 0, used: 0, remaining: 0, allowed: false, day });
    }
    const used = await this.store.increment(key, amount);
    if (used > cfg.daily) {
      const rolled = await this.store.increment(key, -amount);
      throw new QuotaExceededError({ service, limit: cfg.daily, used: rolled, remaining: Math.max(0, cfg.daily - rolled), allowed: false, day });
    }
    return { service, limit: cfg.daily, used, remaining: cfg.daily - used, allowed: true, day };
  }

  /** Give back units reserved for work that did not happen (e.g. call failed before reaching provider). */
  async refund(service: string, amount = 1) {
    if (!this.quotas.has(service)) return;
    const { key } = this.key(service);
    const v = await this.store.increment(key, -amount);
    if (v < 0) await this.store.increment(key, -v);
  }

  async report(): Promise<QuotaStatus[]> {
    return Promise.all([...this.quotas.keys()].map((s) => this.status(s)));
  }
}
