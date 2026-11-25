import { changes, type D1DatabaseLike } from "../util/d1.js";

export type JobStatus = "active" | "paused" | "completed";

export interface JobDefinition {
  id: string;
  name: string;
  cron: string;
  /** Key into the scheduler's handler registry. */
  handler: string;
  payload: unknown;
  status: JobStatus;
  /** Fixed offset for cron evaluation (Asia/Tehran = 210). */
  utcOffsetMinutes: number;
  /** null = unlimited. Counts successful runs. */
  maxRuns: number | null;
  runCount: number;
  failureCount: number;
  /** epoch ms; null when completed/no further slot */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = "running" | "succeeded" | "failed";

export interface JobRun {
  id: string;
  jobId: string;
  idempotencyKey: string;
  scheduledFor: number;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result: unknown;
}

/** Persistence for the scheduler. All methods must be safe under concurrent Workers invocations. */
export interface SchedulerStore {
  getJob(id: string): Promise<JobDefinition | null>;
  /** Insert or replace job fields. MUST NOT clobber lock state. */
  saveJob(job: JobDefinition): Promise<void>;
  deleteJob(id: string): Promise<boolean>;
  listJobs(): Promise<JobDefinition[]>;
  /** Active jobs with nextRunAt <= now, ordered by nextRunAt. */
  listDueJobs(now: number, limit: number): Promise<JobDefinition[]>;
  /** Atomic: take the lock if free or expired. */
  acquireLock(jobId: string, owner: string, now: number, ttlMs: number): Promise<boolean>;
  releaseLock(jobId: string, owner: string): Promise<void>;
  /** Atomic insert; returns false if a run with the same idempotencyKey exists. */
  insertRun(run: JobRun): Promise<boolean>;
  updateRun(run: JobRun): Promise<void>;
  getRunByKey(idempotencyKey: string): Promise<JobRun | null>;
  listRuns(jobId: string, limit?: number): Promise<JobRun[]>;
}

export class MemorySchedulerStore implements SchedulerStore {
  private jobs = new Map<string, JobDefinition>();
  private locks = new Map<string, { owner: string; expiresAt: number }>();
  private runs = new Map<string, JobRun>(); // by idempotencyKey

  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }
  async saveJob(job: JobDefinition) {
    this.jobs.set(job.id, structuredClone(job));
  }
  async deleteJob(id: string) {
    this.locks.delete(id);
    return this.jobs.delete(id);
  }
  async listJobs() {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }
  async listDueJobs(now: number, limit: number) {
    return [...this.jobs.values()]
      .filter((j) => j.status === "active" && j.nextRunAt !== null && j.nextRunAt <= now)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }
  async acquireLock(jobId: string, owner: string, now: number, ttlMs: number) {
    const cur = this.locks.get(jobId);
    if (cur && cur.expiresAt > now && cur.owner !== owner) return false;
    this.locks.set(jobId, { owner, expiresAt: now + ttlMs });
    return true;
  }
  async releaseLock(jobId: string, owner: string) {
    if (this.locks.get(jobId)?.owner === owner) this.locks.delete(jobId);
  }
  async insertRun(run: JobRun) {
    if (this.runs.has(run.idempotencyKey)) return false;
    this.runs.set(run.idempotencyKey, structuredClone(run));
    return true;
  }
  async updateRun(run: JobRun) {
    this.runs.set(run.idempotencyKey, structuredClone(run));
  }
  async getRunByKey(key: string) {
    const r = this.runs.get(key);
    return r ? structuredClone(r) : null;
  }
  async listRuns(jobId: string, limit = 50) {
    return [...this.runs.values()]
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}

interface JobRow {
  id: string;
  name: string;
  cron: string;
  handler: string;
  payload_json: string;
  status: JobStatus;
  utc_offset_minutes: number;
  max_runs: number | null;
  run_count: number;
  failure_count: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  job_id: string;
  idempotency_key: string;
  scheduled_for: number;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  result_json: string | null;
}

const rowToJob = (r: JobRow): JobDefinition => ({
  id: r.id,
  name: r.name,
  cron: r.cron,
  handler: r.handler,
  payload: JSON.parse(r.payload_json),
  status: r.status,
  utcOffsetMinutes: Number(r.utc_offset_minutes),
  maxRuns: r.max_runs === null ? null : Number(r.max_runs),
  runCount: Number(r.run_count),
  failureCount: Number(r.failure_count),
  nextRunAt: r.next_run_at === null ? null : Number(r.next_run_at),
  lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
  lastError: r.last_error,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const rowToRun = (r: RunRow): JobRun => ({
  id: r.id,
  jobId: r.job_id,
  idempotencyKey: r.idempotency_key,
  scheduledFor: Number(r.scheduled_for),
  status: r.status,
  startedAt: Number(r.started_at),
  finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  error: r.error,
  result: r.result_json === null ? null : JSON.parse(r.result_json),
});

/** D1-backed store. Uses tables `autopilot_jobs` and `autopilot_job_runs` from sql/schema.sql. */
export class D1SchedulerStore implements SchedulerStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getJob(id: string) {
    const r = await this.db.prepare("SELECT * FROM autopilot_jobs WHERE id = ?").bind(id).first<JobRow>();
    return r ? rowToJob(r) : null;
  }
  async saveJob(j: JobDefinition) {
    await this.db
      .prepare(
        `INSERT INTO autopilot_jobs (id, name, cron, handler, payload_json, status, utc_offset_minutes, max_runs, run_count, failure_count, next_run_at, last_run_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, cron = excluded.cron, handler = excluded.handler,
           payload_json = excluded.payload_json, status = excluded.status, utc_offset_minutes = excluded.utc_offset_minutes,
           max_runs = excluded.max_runs, run_count = excluded.run_count, failure_count = excluded.failure_count,
           next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at, last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .bind(j.id, j.name, j.cron, j.handler, JSON.stringify(j.payload ?? null), j.status, j.utcOffsetMinutes, j.maxRuns, j.runCount, j.failureCount, j.nextRunAt, j.lastRunAt, j.lastError, j.createdAt, j.updatedAt)
      .run();
  }
  async deleteJob(id: string) {
    return changes(await this.db.prepare("DELETE FROM autopilot_jobs WHERE id = ?").bind(id).run()) > 0;
  }
  async listJobs() {
    const r = await this.db.prepare("SELECT * FROM autopilot_jobs ORDER BY created_at").all<JobRow>();
    return (r.results ?? []).map(rowToJob);
  }
  async listDueJobs(now: number, limit: number) {
    const r = await this.db
      .prepare("SELECT * FROM autopilot_jobs WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?")
      .bind(now, limit)
      .all<JobRow>();
    return (r.results ?? []).map(rowToJob);
  }
  async acquireLock(jobId: string, owner: string, now: number, ttlMs: number) {
    const res = await this.db
      .prepare(
        "UPDATE autopilot_jobs SET lock_owner = ?, lock_expires_at = ? WHERE id = ? AND (lock_owner IS NULL OR lock_owner = ? OR lock_expires_at <= ?)",
      )
      .bind(owner, now + ttlMs, jobId, owner, now)
      .run();
    return changes(res) === 1;
  }
  async releaseLock(jobId: string, owner: string) {
    await this.db
      .prepare("UPDATE autopilot_jobs SET lock_owner = NULL, lock_expires_at = NULL WHERE id = ? AND lock_owner = ?")
      .bind(jobId, owner)
      .run();
  }
  async insertRun(run: JobRun) {
    const res = await this.db
      .prepare(
        `INSERT INTO autopilot_job_runs (id, job_id, idempotency_key, scheduled_for, status, started_at, finished_at, error, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .bind(run.id, run.jobId, run.idempotencyKey, run.scheduledFor, run.status, run.startedAt, run.finishedAt, run.error, run.result === undefined ? null : JSON.stringify(run.result))
      .run();
    return changes(res) === 1;
  }
  async updateRun(run: JobRun) {
    await this.db
      .prepare("UPDATE autopilot_job_runs SET status = ?, finished_at = ?, error = ?, result_json = ? WHERE idempotency_key = ?")
      .bind(run.status, run.finishedAt, run.error, run.result === undefined ? null : JSON.stringify(run.result ?? null), run.idempotencyKey)
      .run();
  }
  async getRunByKey(key: string) {
    const r = await this.db.prepare("SELECT * FROM autopilot_job_runs WHERE idempotency_key = ?").bind(key).first<RunRow>();
    return r ? rowToRun(r) : null;
  }
  async listRuns(jobId: string, limit = 50) {
    const r = await this.db
      .prepare("SELECT * FROM autopilot_job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?")
      .bind(jobId, limit)
      .all<RunRow>();
    return (r.results ?? []).map(rowToRun);
  }
}
