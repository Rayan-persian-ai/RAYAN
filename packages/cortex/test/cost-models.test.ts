import { describe, expect, it } from 'vitest';
import { CostController, D1QuotaStore, QuotaExceededError } from '../src/cost.js';
import { ModelRouter } from '../src/models.js';
import { CortexError } from '../src/types.js';
import { createTestD1 } from './helpers/d1.js';

describe('CostController', () => {
  it('enforces daily quota with hard stop and resets next day', async () => {
    let now = Date.UTC(2026, 10, 25, 10);
    const cc = new CostController({ 'workers-ai': { daily: 3 } }, { clock: () => now });
    await cc.consume('workers-ai', 2);
    expect(await cc.canSpend('workers-ai', 1)).toBe(true);
    expect(await cc.canSpend('workers-ai', 2)).toBe(false);
    await cc.consume('workers-ai');
    await expect(cc.consume('workers-ai')).rejects.toBeInstanceOf(QuotaExceededError);
    // Rolled back: still exactly at limit, not over.
    expect((await cc.status('workers-ai')).used).toBe(3);
    now += 24 * 3600_000;
    expect((await cc.status('workers-ai')).used).toBe(0);
  });

  it('denies unknown services by default (zero budget)', async () => {
    const cc = new CostController();
    await expect(cc.consume('openai')).rejects.toThrow(/exhausted/);
    expect(await new CostController({}, { allowUnknown: true }).canSpend('x')).toBe(true);
  });

  it('respects reset offset (Asia/Tehran +03:30)', async () => {
    const now = Date.UTC(2026, 10, 25, 21, 0); // 00:30 next day in Tehran
    const cc = new CostController({ s: { daily: 1 } }, { clock: () => now, resetOffsetMinutes: 210 });
    expect((await cc.status('s')).day).toBe('2026-11-26');
  });

  it('concurrent consumers cannot overshoot', async () => {
    const cc = new CostController({ s: { daily: 5 } });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => cc.consume('s')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect((await cc.status('s')).used).toBe(5);
  });

  it('works with the D1 quota store (real SQL)', async () => {
    const cc = new CostController({ s: { daily: 2 } }, { store: new D1QuotaStore(createTestD1()) });
    await cc.consume('s');
    await cc.consume('s');
    await expect(cc.consume('s')).rejects.toBeInstanceOf(QuotaExceededError);
    expect((await cc.status('s')).used).toBe(2);
    await cc.refund('s');
    expect((await cc.status('s')).used).toBe(1);
  });
});

describe('ModelRouter', () => {
  const build = (cost?: CostController, clock?: () => number) =>
    new ModelRouter({ cost, clock, breakerThreshold: 2, cooldownMs: 1000 })
      .register({ id: 'fa-strong', provider: 'cf', free: true, capabilities: { persian: 0.9, coding: 0.4, speed: 0.5 }, quotaService: 'cf' })
      .register({ id: 'coder', provider: 'cf', free: true, capabilities: { persian: 0.3, coding: 0.95, speed: 0.6 } })
      .register({ id: 'paid-gpt', provider: 'x', free: false, capabilities: { persian: 1, coding: 1, speed: 1 } });

  it('chooses by capability and never a paid model by default', async () => {
    const r = build();
    expect((await r.choose({ needs: { persian: 1 } }))?.id).toBe('fa-strong');
    expect((await r.choose({ needs: { coding: 1 } }))?.id).toBe('coder');
    expect((await r.rank({ needs: { persian: 1 } })).map((x) => x.model.id)).not.toContain('paid-gpt');
    expect(await r.choose({ needs: {}, require: { persian: 0.95 } })).toBeUndefined();
  });

  it('falls back to next free model on error and records health', async () => {
    const r = build();
    const out = await r.run({ needs: { persian: 1 } }, async (m) => {
      if (m.id === 'fa-strong') throw new Error('503');
      return `ok from ${m.id}`;
    });
    expect(out.result).toBe('ok from coder');
    expect(out.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(r.getHealth('fa-strong')).toMatchObject({ errors: 1, consecutiveErrors: 1 });
  });

  it('circuit breaker cools down failing models', async () => {
    let now = 0;
    const r = build(undefined, () => now);
    r.record('fa-strong', { ok: false, latencyMs: 10 });
    r.record('fa-strong', { ok: false, latencyMs: 10 });
    expect((await r.choose({ needs: { persian: 1 } }))?.id).toBe('coder');
    now = 5000;
    expect((await r.choose({ needs: { persian: 1 } }))?.id).toBe('fa-strong');
  });

  it('skips models whose quota is exhausted', async () => {
    const cost = new CostController({ cf: { daily: 1 } });
    const r = build(cost);
    const a = await r.run({ needs: { persian: 1 } }, async (m) => m.id);
    expect(a.model).toBe('fa-strong');
    const b = await r.run({ needs: { persian: 1 } }, async (m) => m.id);
    expect(b.model).toBe('coder');
  });

  it('stops on non-retryable errors and throws when nothing succeeds', async () => {
    const r = build();
    await expect(r.run({ needs: { persian: 1 } }, async () => { throw new CortexError('cancelled', 'stop'); })).rejects.toThrow('stop');
    await expect(r.run({ needs: { persian: 1 } }, async () => { throw new Error('down'); })).rejects.toMatchObject({ code: 'no_model_available' });
  });

  it('validates capability ranges', () => {
    expect(() => new ModelRouter().register({ id: 'x', provider: 'p', free: true, capabilities: { persian: 2 } })).toThrow();
  });
});
