import type { AppDeps } from "../deps";
import type { Env } from "../env";
import { autopilotScheduler } from "../lib/autopilot";
import { processPendingTasks, type ProcessOptions } from "./processor";

/** Runs one job and records its health in scheduled_jobs. Never throws. */
export async function runJob(env: Env, deps: AppDeps, name: string, cron: string | null, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  let status: "ok" | "error" = "ok";
  let error: string | null = null;
  let output: unknown;
  try {
    output = await fn();
  } catch (e) {
    status = "error";
    error = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    console.error(`scheduled job ${name} failed`, e);
  }
  const now = deps.now();
  await env.DB.prepare(
    `INSERT INTO scheduled_jobs (name, cron, last_run_at, last_status, last_error, last_duration_ms, run_count, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?3)
     ON CONFLICT(name) DO UPDATE SET cron = COALESCE(excluded.cron, cron), last_run_at = excluded.last_run_at,
       last_status = excluded.last_status, last_error = excluded.last_error,
       last_duration_ms = excluded.last_duration_ms, run_count = run_count + 1, updated_at = excluded.updated_at`,
  )
    .bind(name, cron, now, status, error, Date.now() - t0)
    .run();
  return { name, status, error, output };
}

export async function maintenance(env: Env, now: number) {
  const day = 24 * 3600_000;
  const res = await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(Math.floor((now - day) / 1000)),
    env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?1").bind(now - 180 * day),
  ]);
  return { sessions: res[0]?.meta.changes, rate_limits: res[1]?.meta.changes, audit_logs: res[2]?.meta.changes };
}

/** Entry point for the Cron Trigger (every 15 minutes). Heartbeat runs last so it reflects a completed cycle. */
export async function runScheduled(env: Env, deps: AppDeps, cron: string | null, opts?: ProcessOptions) {
  const results = [];
  results.push(await runJob(env, deps, "task_processor", cron, () => processPendingTasks(env, deps, opts)));
  results.push(await runJob(env, deps, "maintenance", cron, () => maintenance(env, deps.now())));
  // Autopilot jobs (D1 locks + per-slot idempotency keys, so overlapping cron invocations are safe).
  results.push(await runJob(env, deps, "autopilot", cron, () => autopilotScheduler(env, deps).tick(new Date(deps.now()))));
  results.push(await runJob(env, deps, "heartbeat", cron, async () => ({ at: deps.now() })));
  return results;
}
