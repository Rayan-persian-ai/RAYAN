import type { AppDeps } from "../deps";
import type { Env } from "../env";
import { NonRetryableError, type TaskRow } from "../lib/tasks";

export interface ProcessOptions {
  batchSize?: number;
  /** Lease on a claimed task; an expired lease means the worker died and the task is recovered. */
  leaseMs?: number;
  /** Stop claiming new tasks after this much wall time in one cron run. */
  timeBudgetMs?: number;
  /** Delay before a failed attempt becomes eligible again (multiplied by attempt number). */
  retryBackoffMs?: number;
}

export interface ProcessReport {
  recovered: number;
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
}

const MAX_ERROR_LEN = 1000;
const MAX_RESULT_LEN = 64_000;

/**
 * Processes due pending tasks once. Guarantees termination:
 *  - a bounded batch is selected up front and each task is attempted at most once per run;
 *  - attempts are incremented atomically when claiming, and a task is never claimed once attempts >= max_attempts;
 *  - the time budget stops new claims.
 */
export async function processPendingTasks(env: Env, deps: AppDeps, opts: ProcessOptions = {}): Promise<ProcessReport> {
  const batchSize = opts.batchSize ?? 10;
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  const budget = opts.timeBudgetMs ?? 25_000;
  const backoff = opts.retryBackoffMs ?? 60_000;
  const db = env.DB;
  const started = Date.now();
  const report: ProcessReport = { recovered: 0, claimed: 0, succeeded: 0, retried: 0, failed: 0 };
  let now = deps.now();

  // 1) Recover tasks whose lease expired (worker crashed / exceeded limits mid-run).
  const rec = await db
    .prepare(
      `UPDATE tasks SET
         status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
         finished_at = CASE WHEN attempts >= max_attempts THEN ?1 ELSE NULL END,
         error = COALESCE(error, 'lease expired'), locked_until = NULL, next_run_at = ?1, updated_at = ?1
       WHERE status = 'running' AND locked_until IS NOT NULL AND locked_until < ?1`,
    )
    .bind(now)
    .run();
  report.recovered = rec.meta.changes ?? 0;

  // 2) Safety net: a pending task that somehow exhausted its attempts is failed, never retried.
  await db
    .prepare(
      `UPDATE tasks SET status = 'failed', finished_at = ?1, updated_at = ?1, error = COALESCE(error, 'max attempts exhausted')
       WHERE status = 'pending' AND attempts >= max_attempts`,
    )
    .bind(now)
    .run();

  // 3) Snapshot a bounded batch of due tasks.
  const { results: due } = await db
    .prepare(
      `SELECT id FROM tasks WHERE status = 'pending' AND attempts < max_attempts
         AND (next_run_at IS NULL OR next_run_at <= ?1) ORDER BY created_at LIMIT ?2`,
    )
    .bind(now, batchSize)
    .all<{ id: string }>();

  for (const { id } of due) {
    if (Date.now() - started > budget) break;
    now = deps.now();
    const task = await db
      .prepare(
        `UPDATE tasks SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?1),
           locked_until = ?2, updated_at = ?1
         WHERE id = ?3 AND status = 'pending' AND attempts < max_attempts
         RETURNING id, type, payload, attempts, max_attempts, created_by`,
      )
      .bind(now, now + leaseMs, id)
      .first<Pick<TaskRow, "id" | "type" | "payload" | "attempts" | "max_attempts" | "created_by">>();
    if (!task) continue; // claimed or cancelled by someone else
    report.claimed++;

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(task.payload) as Record<string, unknown>;
    } catch {
      /* handled below as non-retryable */
    }

    try {
      const handler = deps.taskHandlers[task.type];
      if (!handler) throw new NonRetryableError(`unknown task type '${task.type}'`);
      const result = await handler({
        env,
        deps,
        task: { id: task.id, type: task.type, payload, attempts: task.attempts, created_by: task.created_by },
      });
      const done = deps.now();
      // Only finish if still running (a concurrent cancel wins).
      await db
        .prepare(
          `UPDATE tasks SET status = 'succeeded', result = ?1, error = NULL, finished_at = ?2, updated_at = ?2, locked_until = NULL
           WHERE id = ?3 AND status = 'running'`,
        )
        .bind(JSON.stringify(result ?? null).slice(0, MAX_RESULT_LEN), done, task.id)
        .run();
      report.succeeded++;
    } catch (e) {
      const done = deps.now();
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_LEN);
      const final = e instanceof NonRetryableError || task.attempts >= task.max_attempts;
      if (final) {
        await db
          .prepare(
            `UPDATE tasks SET status = 'failed', error = ?1, finished_at = ?2, updated_at = ?2, locked_until = NULL
             WHERE id = ?3 AND status = 'running'`,
          )
          .bind(msg, done, task.id)
          .run();
        report.failed++;
      } else {
        await db
          .prepare(
            `UPDATE tasks SET status = 'pending', error = ?1, next_run_at = ?2, updated_at = ?3, locked_until = NULL
             WHERE id = ?4 AND status = 'running'`,
          )
          .bind(msg, done + backoff * task.attempts, done, task.id)
          .run();
        report.retried++;
      }
    }
  }
  return report;
}
