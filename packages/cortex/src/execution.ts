import type { EventBus } from './events.js';
import { validatePlan, type Plan, type PlanStep } from './planner.js';
import type { ApprovalRequest } from './permissions.js';
import { CortexError, isRetryable, type UserContext } from './types.js';
import { abortError, sleep, withTimeout } from './util.js';

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'awaiting_approval';

export interface StepState {
  id: string;
  status: StepStatus;
  attempts: number;
  output?: unknown;
  error?: string;
  errorCode?: string;
  approvals?: ApprovalRequest[];
  startedAt?: number;
  endedAt?: number;
}

/** What a step executor returns. Throw for errors (retryable unless CortexError says otherwise). */
export type StepOutcome = { status: 'ok'; output: unknown } | { status: 'approval_required'; approvals: ApprovalRequest[]; partialOutput?: unknown };

export type StepExecutor = (
  step: PlanStep,
  ctx: { user: UserContext; signal: AbortSignal; attempt: number; inputs: Record<string, unknown>; planId: string; traceId?: string },
) => Promise<StepOutcome>;

export type ExecutionStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'awaiting_approval';

export interface ExecutionResult {
  planId: string;
  status: ExecutionStatus;
  steps: Record<string, StepState>;
  order: string[];
  durationMs: number;
  totalAttempts: number;
}

export interface ExecutionOptions {
  /** Retries per step after the first attempt (default 2, hard-capped at 5). */
  maxRetries?: number;
  stepTimeoutMs?: number;
  /** Wall-clock budget for the whole plan (default 120s). */
  planTimeoutMs?: number;
  maxConcurrency?: number;
  /** Base backoff in ms; doubles per retry with jitter (default 200). */
  backoffMs?: number;
  /** Global attempt budget across all steps — the infinite-loop guard (default steps*(retries+1), cap 200). */
  maxTotalAttempts?: number;
  /** Stop scheduling new steps after the first failure (default false: independent branches continue). */
  failFast?: boolean;
}

const HARD_MAX_RETRIES = 5;
const HARD_MAX_ATTEMPTS = 200;

export class ExecutionEngine {
  constructor(private readonly bus?: EventBus, private readonly defaults: ExecutionOptions = {}) {}

  async run(
    plan: Plan,
    executor: StepExecutor,
    ctx: { user: UserContext; signal?: AbortSignal; traceId?: string },
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult> {
    const o = { ...this.defaults, ...options };
    const maxRetries = Math.min(Math.max(0, o.maxRetries ?? 2), HARD_MAX_RETRIES);
    const maxConc = Math.max(1, o.maxConcurrency ?? 4);
    const maxTotal = Math.min(o.maxTotalAttempts ?? plan.steps.length * (maxRetries + 1), HARD_MAX_ATTEMPTS);
    const started = Date.now();
    const meta = { traceId: ctx.traceId, userId: ctx.user.userId };
    const emit = (type: string, data: Record<string, unknown>) => this.bus?.emit(type, { planId: plan.id, ...data }, meta);

    const v = validatePlan(plan.steps, { maxSteps: Math.max(plan.steps.length, 1), maxDepth: Number.MAX_SAFE_INTEGER });
    const states: Record<string, StepState> = {};
    for (const st of plan.steps) states[st.id] = { id: st.id, status: 'pending', attempts: 0 };
    if (!v.ok) {
      for (const st of plan.steps) Object.assign(states[st.id]!, { status: 'skipped', error: 'invalid plan' });
      emit('plan.invalid', { errors: v.errors });
      return { planId: plan.id, status: 'failed', steps: states, order: [], durationMs: 0, totalAttempts: 0 };
    }

    // Plan-level cancellation: external signal OR plan timeout.
    const planCtrl = new AbortController();
    const onExternal = () => planCtrl.abort(abortError(ctx.signal?.reason));
    if (ctx.signal?.aborted) planCtrl.abort(abortError(ctx.signal.reason));
    ctx.signal?.addEventListener('abort', onExternal, { once: true });
    const planTimer = setTimeout(
      () => planCtrl.abort(new CortexError('timeout', `plan timed out after ${o.planTimeoutMs ?? 120_000}ms`)),
      o.planTimeoutMs ?? 120_000,
    );

    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    let totalAttempts = 0;
    let stopScheduling = false;
    emit('plan.started', { steps: plan.steps.length });

    const runStep = async (step: PlanStep) => {
      const state = states[step.id]!;
      state.status = 'running';
      state.startedAt = Date.now();
      emit('step.started', { stepId: step.id, agent: step.agentSlug });
      const inputs: Record<string, unknown> = {};
      for (const d of step.dependsOn) inputs[d] = states[d]!.output;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        if (planCtrl.signal.aborted) {
          state.status = 'cancelled';
          break;
        }
        if (totalAttempts >= maxTotal) {
          state.status = 'failed';
          state.error = `global attempt budget (${maxTotal}) exhausted`;
          state.errorCode = 'attempt_budget';
          break;
        }
        totalAttempts++;
        state.attempts = attempt;
        try {
          const outcome = await withTimeout(
            (signal) => executor(step, { user: ctx.user, signal, attempt, inputs, planId: plan.id, traceId: ctx.traceId }),
            o.stepTimeoutMs ?? 30_000,
            planCtrl.signal,
            `step ${step.id}`,
          );
          if (outcome.status === 'approval_required') {
            state.status = 'awaiting_approval';
            state.approvals = outcome.approvals;
            state.output = outcome.partialOutput;
            emit('step.awaiting_approval', { stepId: step.id, approvals: outcome.approvals.map((a) => a.id) });
          } else {
            state.status = 'succeeded';
            state.output = outcome.output;
            emit('step.succeeded', { stepId: step.id, attempt });
          }
          break;
        } catch (e) {
          const err = e instanceof CortexError ? e : new CortexError('step_error', e instanceof Error ? e.message : String(e), { retryable: isRetryable(e) });
          state.error = err.message;
          state.errorCode = err.code;
          if (planCtrl.signal.aborted) {
            state.status = 'cancelled';
            break;
          }
          const canRetry = err.retryable && attempt <= maxRetries;
          if (!canRetry) {
            state.status = 'failed';
            emit('step.failed', { stepId: step.id, attempt, error: err.message, code: err.code });
            break;
          }
          emit('step.retry', { stepId: step.id, attempt, error: err.message });
          const backoff = (o.backoffMs ?? 200) * 2 ** (attempt - 1);
          try {
            await sleep(backoff / 2 + Math.random() * (backoff / 2), planCtrl.signal);
          } catch {
            state.status = 'cancelled';
            break;
          }
        }
      }
      if (state.status === 'running') state.status = 'failed'; // defensive: never leave running
      state.endedAt = Date.now();
      if (state.status === 'failed' && o.failFast) stopScheduling = true;
    };

    // Scheduler: launch ready steps up to the concurrency limit.
    const running = new Map<string, Promise<void>>();
    const done = new Set<string>();
    const settle = () => {
      // Propagate blocking upstream outcomes to dependents.
      let changed = true;
      while (changed) {
        changed = false;
        for (const st of plan.steps) {
          const s = states[st.id]!;
          if (s.status !== 'pending') continue;
          const bad = st.dependsOn.find((d) => ['failed', 'skipped', 'cancelled', 'awaiting_approval'].includes(states[d]!.status));
          if (bad) {
            const upstream = states[bad]!.status;
            s.status = upstream === 'cancelled' ? 'cancelled' : 'skipped';
            s.error = `blocked by "${bad}" (${upstream})`;
            done.add(st.id);
            emit('step.skipped', { stepId: st.id, blockedBy: bad, reason: upstream });
            changed = true;
          }
        }
      }
    };
    try {
      while (true) {
        settle();
        if (planCtrl.signal.aborted || stopScheduling) {
          for (const s of Object.values(states)) if (s.status === 'pending') {
            s.status = planCtrl.signal.aborted ? 'cancelled' : 'skipped';
            s.error = planCtrl.signal.aborted ? 'plan cancelled' : 'fail-fast';
          }
        }
        const ready = plan.steps.filter(
          (st) => states[st.id]!.status === 'pending' && !running.has(st.id) && st.dependsOn.every((d) => states[d]!.status === 'succeeded'),
        );
        for (const st of ready) {
          if (running.size >= maxConc) break;
          const p = runStep(byId.get(st.id)!).finally(() => {
            running.delete(st.id);
            done.add(st.id);
          });
          running.set(st.id, p);
        }
        if (running.size === 0) break; // nothing running and nothing ready → finished
        await Promise.race(running.values());
      }
    } finally {
      clearTimeout(planTimer);
      ctx.signal?.removeEventListener('abort', onExternal);
    }

    const statuses = Object.values(states).map((s) => s.status);
    let status: ExecutionStatus;
    if (planCtrl.signal.aborted && statuses.includes('cancelled')) status = 'cancelled';
    else if (statuses.every((x) => x === 'succeeded')) status = 'succeeded';
    else if (statuses.includes('awaiting_approval')) status = 'awaiting_approval';
    else if (statuses.includes('succeeded')) status = 'partial';
    else status = 'failed';
    const result: ExecutionResult = { planId: plan.id, status, steps: states, order: v.order, durationMs: Date.now() - started, totalAttempts };
    emit('plan.completed', { status, durationMs: result.durationMs, totalAttempts });
    return result;
  }
}
