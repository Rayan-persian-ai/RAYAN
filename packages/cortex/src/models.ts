import type { CostController } from './cost.js';
import type { EventBus } from './events.js';
import { CortexError, isRetryable } from './types.js';
import { systemClock, type Clock } from './util.js';

export type ModelCapability = 'persian' | 'coding' | 'reasoning' | 'speed' | 'vision' | 'longContext';

export interface ModelSpec {
  id: string;
  provider: string;
  /** 0..1 strength per capability. */
  capabilities: Partial<Record<ModelCapability, number>>;
  /** True for free-tier models. ModelRouter is free-only by default (zero-budget). */
  free: boolean;
  /** CostController service consumed once per call (e.g. 'workers-ai'). */
  quotaService?: string;
  enabled?: boolean;
}

export interface ModelTask {
  /** Weight per capability, e.g. { persian: 1, coding: 0.5 }. */
  needs: Partial<Record<ModelCapability, number>>;
  /** Hard requirement: capability strengths that must be >= the given value. */
  require?: Partial<Record<ModelCapability, number>>;
  exclude?: string[];
}

export interface ModelHealth {
  calls: number;
  successes: number;
  errors: number;
  consecutiveErrors: number;
  /** Exponentially-weighted moving average latency (ms). */
  latencyEwma: number;
  cooldownUntil: number;
  lastError?: string;
}

export interface ModelRouterOptions {
  cost?: CostController;
  bus?: EventBus;
  clock?: Clock;
  freeOnly?: boolean;
  /** Consecutive errors before a model is put in cooldown (circuit breaker). Default 3. */
  breakerThreshold?: number;
  cooldownMs?: number;
  /** Max models tried per run() (default 4). */
  maxAttempts?: number;
}

export interface RankedModel {
  model: ModelSpec;
  score: number;
}

export class ModelRouter {
  private readonly models = new Map<string, ModelSpec>();
  private readonly health = new Map<string, ModelHealth>();
  private readonly clock: Clock;
  constructor(private readonly opts: ModelRouterOptions = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  register(spec: ModelSpec): this {
    if (!spec.id) throw new Error('model id required');
    for (const [k, v] of Object.entries(spec.capabilities)) if (typeof v !== 'number' || v < 0 || v > 1) throw new Error(`capability ${k} must be in [0,1]`);
    this.models.set(spec.id, { enabled: true, ...spec });
    if (!this.health.has(spec.id)) this.health.set(spec.id, { calls: 0, successes: 0, errors: 0, consecutiveErrors: 0, latencyEwma: 0, cooldownUntil: 0 });
    return this;
  }

  getHealth(id: string): ModelHealth | undefined {
    const h = this.health.get(id);
    return h ? { ...h } : undefined;
  }

  record(id: string, outcome: { ok: boolean; latencyMs: number; error?: string }) {
    const h = this.health.get(id);
    if (!h) return;
    h.calls++;
    h.latencyEwma = h.latencyEwma === 0 ? outcome.latencyMs : h.latencyEwma * 0.7 + outcome.latencyMs * 0.3;
    if (outcome.ok) {
      h.successes++;
      h.consecutiveErrors = 0;
    } else {
      h.errors++;
      h.consecutiveErrors++;
      h.lastError = outcome.error;
      if (h.consecutiveErrors >= (this.opts.breakerThreshold ?? 3)) {
        // Exponential cooldown capped at 16x.
        const factor = Math.min(16, 2 ** (h.consecutiveErrors - (this.opts.breakerThreshold ?? 3)));
        h.cooldownUntil = this.clock() + (this.opts.cooldownMs ?? 60_000) * factor;
        this.opts.bus?.emit('model.cooldown', { model: id, until: h.cooldownUntil, error: outcome.error });
      }
    }
  }

  /** Rank eligible models for a task (best first). Skips disabled, paid (when freeOnly), cooled-down and quota-exhausted models. */
  async rank(task: ModelTask): Promise<RankedModel[]> {
    const now = this.clock();
    const out: RankedModel[] = [];
    for (const m of this.models.values()) {
      if (m.enabled === false) continue;
      if ((this.opts.freeOnly ?? true) && !m.free) continue;
      if (task.exclude?.includes(m.id)) continue;
      const h = this.health.get(m.id)!;
      if (h.cooldownUntil > now) continue;
      if (task.require && Object.entries(task.require).some(([k, v]) => (m.capabilities[k as ModelCapability] ?? 0) < (v ?? 0))) continue;
      if (m.quotaService && this.opts.cost && !(await this.opts.cost.canSpend(m.quotaService))) continue;
      out.push({ model: m, score: this.score(m, h, task) });
    }
    return out.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
  }

  async choose(task: ModelTask): Promise<ModelSpec | undefined> {
    return (await this.rank(task))[0]?.model;
  }

  /**
   * Call fn with the best model; on failure record it and fall back to the next eligible model.
   * Non-retryable errors (e.g. cancellation) stop immediately.
   */
  async run<T>(task: ModelTask, fn: (model: ModelSpec) => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<{ result: T; model: string; attempts: { model: string; ok: boolean; error?: string; latencyMs: number }[] }> {
    const attempts: { model: string; ok: boolean; error?: string; latencyMs: number }[] = [];
    const tried = new Set(task.exclude ?? []);
    const max = this.opts.maxAttempts ?? 4;
    while (attempts.length < max) {
      if (opts.signal?.aborted) throw new CortexError('cancelled', 'model run cancelled');
      const next = (await this.rank({ ...task, exclude: [...tried] }))[0]?.model;
      if (!next) break;
      tried.add(next.id);
      if (next.quotaService && this.opts.cost) {
        try {
          await this.opts.cost.consume(next.quotaService);
        } catch {
          continue; // quota raced to exhaustion; try next
        }
      }
      const t0 = this.clock();
      try {
        const result = await fn(next);
        const latencyMs = this.clock() - t0;
        this.record(next.id, { ok: true, latencyMs });
        attempts.push({ model: next.id, ok: true, latencyMs });
        return { result, model: next.id, attempts };
      } catch (e) {
        const latencyMs = this.clock() - t0;
        const msg = e instanceof Error ? e.message : String(e);
        this.record(next.id, { ok: false, latencyMs, error: msg });
        attempts.push({ model: next.id, ok: false, error: msg, latencyMs });
        this.opts.bus?.emit('model.fallback', { from: next.id, error: msg });
        if (!isRetryable(e)) throw e;
      }
    }
    throw new CortexError('no_model_available', `No model succeeded (${attempts.map((a) => `${a.model}: ${a.error}`).join('; ') || 'no eligible free model'})`, {
      retryable: false,
      details: attempts,
    });
  }

  private score(m: ModelSpec, h: ModelHealth, task: ModelTask): number {
    let fit = 0;
    let wsum = 0;
    for (const [cap, w] of Object.entries(task.needs)) {
      fit += (m.capabilities[cap as ModelCapability] ?? 0) * (w ?? 0);
      wsum += w ?? 0;
    }
    const capFit = wsum > 0 ? fit / wsum : 0.5;
    const reliability = (h.successes + 1) / (h.calls + 2);
    // Latency penalty: 0 at <=500ms, approaching 0.2 for very slow models.
    const latencyPenalty = h.latencyEwma > 500 ? Math.min(0.2, (h.latencyEwma - 500) / 20_000) : 0;
    return capFit * 0.6 + reliability * 0.4 - latencyPenalty - h.consecutiveErrors * 0.05;
  }
}
