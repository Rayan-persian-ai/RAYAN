import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events.js';
import { ExecutionEngine, type StepExecutor } from '../src/execution.js';
import type { Plan, PlanStep } from '../src/planner.js';
import { CortexError } from '../src/types.js';

const user = { userId: 'u1' };
const step = (id: string, dependsOn: string[] = []): PlanStep => ({ id, title: id, capability: 'x.y', agentSlug: 'a', toolNames: [], dependsOn, intent: 'chat' });
const plan = (steps: PlanStep[]): Plan => ({ id: 'p1', goal: 'g', intent: 'chat', steps, source: 'template' });
const fast = { backoffMs: 1 };

describe('ExecutionEngine', () => {
  it('runs a DAG respecting dependencies and passes inputs', async () => {
    const seen: string[] = [];
    const exec: StepExecutor = async (s, ctx) => {
      seen.push(s.id);
      return { status: 'ok', output: `${s.id}(${Object.values(ctx.inputs).join(',')})` };
    };
    const r = await new ExecutionEngine().run(plan([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])]), exec, { user }, fast);
    expect(r.status).toBe('succeeded');
    expect(seen[0]).toBe('a');
    expect(seen[3]).toBe('d');
    expect(r.steps.d!.output).toBe('d(b(a()),c(a()))');
  });

  it('respects maxConcurrency', async () => {
    let active = 0;
    let peak = 0;
    const exec: StepExecutor = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { status: 'ok', output: 1 };
    };
    await new ExecutionEngine().run(plan(['a', 'b', 'c', 'd', 'e'].map((x) => step(x))), exec, { user }, { maxConcurrency: 2 });
    expect(peak).toBe(2);
  });

  it('retries retryable errors with a bound, then fails and skips dependents', async () => {
    let calls = 0;
    const exec: StepExecutor = async (s) => {
      if (s.id === 'a') {
        calls++;
        throw new Error('flaky');
      }
      return { status: 'ok', output: 1 };
    };
    const bus = new EventBus();
    const retries: unknown[] = [];
    bus.on('step.retry', (e) => void retries.push(e));
    const r = await new ExecutionEngine(bus).run(plan([step('a'), step('b', ['a']), step('c')]), exec, { user }, { ...fast, maxRetries: 2 });
    expect(calls).toBe(3);
    expect(retries).toHaveLength(2);
    expect(r.steps.a!.status).toBe('failed');
    expect(r.steps.b!.status).toBe('skipped');
    expect(r.steps.c!.status).toBe('succeeded');
    expect(r.status).toBe('partial');
  });

  it('succeeds after transient failure', async () => {
    let n = 0;
    const exec: StepExecutor = async () => {
      if (++n < 2) throw new Error('blip');
      return { status: 'ok', output: 'done' };
    };
    const r = await new ExecutionEngine().run(plan([step('a')]), exec, { user }, fast);
    expect(r.steps.a).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    const exec: StepExecutor = async () => {
      calls++;
      throw new CortexError('tool_denied', 'nope', { retryable: false });
    };
    const r = await new ExecutionEngine().run(plan([step('a')]), exec, { user }, { ...fast, maxRetries: 5 });
    expect(calls).toBe(1);
    expect(r.steps.a!.errorCode).toBe('tool_denied');
  });

  it('caps retries at the hard limit and enforces a global attempt budget', async () => {
    let calls = 0;
    const exec: StepExecutor = async () => {
      calls++;
      throw new Error('always');
    };
    await new ExecutionEngine().run(plan([step('a')]), exec, { user }, { ...fast, maxRetries: 1000 });
    expect(calls).toBe(6); // 1 + hard cap 5
    calls = 0;
    const r = await new ExecutionEngine().run(plan([step('a'), step('b'), step('c')]), exec, { user }, { ...fast, maxRetries: 3, maxTotalAttempts: 4, maxConcurrency: 1 });
    expect(calls).toBe(4);
    expect(Object.values(r.steps).some((s) => s.errorCode === 'attempt_budget')).toBe(true);
  });

  it('times out hung steps', async () => {
    const exec: StepExecutor = () => new Promise(() => {});
    const r = await new ExecutionEngine().run(plan([step('a')]), exec, { user }, { ...fast, stepTimeoutMs: 20, maxRetries: 1 });
    expect(r.steps.a).toMatchObject({ status: 'failed', errorCode: 'timeout', attempts: 2 });
  });

  it('supports cancellation via AbortSignal', async () => {
    const ctrl = new AbortController();
    const exec: StepExecutor = (s, ctx) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ status: 'ok', output: s.id }), 1000);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    setTimeout(() => ctrl.abort('user cancelled'), 20);
    const t0 = Date.now();
    const r = await new ExecutionEngine().run(plan([step('a'), step('b', ['a'])]), exec, { user, signal: ctrl.signal }, fast);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.status).toBe('cancelled');
    expect(r.steps.a!.status).toBe('cancelled');
    expect(r.steps.b!.status).toBe('cancelled');
  });

  it('enforces plan timeout', async () => {
    const exec: StepExecutor = async (_s, ctx) => {
      await new Promise((r, j) => { const t = setTimeout(r, 200); ctx.signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('x')); }); });
      return { status: 'ok', output: 1 };
    };
    const r = await new ExecutionEngine().run(plan([step('a'), step('b', ['a'])]), exec, { user }, { ...fast, planTimeoutMs: 50 });
    expect(r.status).toBe('cancelled');
  });

  it('marks approval-required steps and blocks dependents', async () => {
    const approval = { id: 'apr_1' } as never;
    const exec: StepExecutor = async (s) => (s.id === 'a' ? { status: 'approval_required', approvals: [approval] } : { status: 'ok', output: 1 });
    const r = await new ExecutionEngine().run(plan([step('a'), step('b', ['a'])]), exec, { user }, fast);
    expect(r.status).toBe('awaiting_approval');
    expect(r.steps.b!.status).toBe('skipped');
  });

  it('refuses invalid (cyclic) plans without running anything', async () => {
    let ran = false;
    const r = await new ExecutionEngine().run(plan([step('a', ['b']), step('b', ['a'])]), async () => { ran = true; return { status: 'ok', output: 1 }; }, { user });
    expect(ran).toBe(false);
    expect(r.status).toBe('failed');
  });

  it('emits lifecycle events', async () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.on('*', (e) => void types.push(e.type));
    await new ExecutionEngine(bus).run(plan([step('a')]), async () => ({ status: 'ok', output: 1 }), { user });
    expect(types).toEqual(['plan.started', 'step.started', 'step.succeeded', 'plan.completed']);
  });

  it('failFast stops scheduling after first failure', async () => {
    const exec: StepExecutor = async (s) => {
      if (s.id === 'a') throw new CortexError('x', 'boom');
      return { status: 'ok', output: 1 };
    };
    const r = await new ExecutionEngine().run(plan([step('a'), step('b')]), exec, { user }, { failFast: true, maxConcurrency: 1 });
    expect(r.steps.b!.status).toBe('skipped');
  });
});
