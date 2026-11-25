import { nextRun, parseCron } from "./cron.js";
import type { JobDefinition, JobRun, SchedulerStore } from "./store.js";
import { randomId } from "../util/hash.js";

export interface JobContext {
  job: JobDefinition;
  runId: string;
  idempotencyKey: string;
  scheduledFor: Date;
  now: Date;
  payload: unknown;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown> | unknown;

export interface SchedulerOptions {
  store: SchedulerStore;
  handlers: Record<string, JobHandler>;
  /** Lock lease; must exceed the longest handler runtime. Default 5 min. */
  lockTtlMs?: number;
  /** Max jobs processed per tick. Default 25. */
  maxJobsPerTick?: number;
  /** Identifies this invocation for locking. Default random. */
  owner?: string;
  /** Default utc offset for new jobs (Asia/Tehran = 210). */
  defaultUtcOffsetMinutes?: number;
}

export interface CreateJobInput {
  id?: string;
  name: string;
  cron: string;
  handler: string;
  payload?: unknown;
  maxRuns?: number | null;
  utcOffsetMinutes?: number;
  paused?: boolean;
}

export type TickOutcome =
  | { jobId: string; outcome: "succeeded"; runId: string; idempotencyKey: string }
  | { jobId: string; outcome: "failed"; runId: string; idempotencyKey: string; error: string }
  | { jobId: string; outcome: "skipped"; reason: "locked" | "duplicate" | "not_due" | "max_runs_reached" };

export interface TickReport {
  at: string;
  processed: number;
  outcomes: TickOutcome[];
}

const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export class Scheduler {
  private readonly store: SchedulerStore;
  private readonly handlers: Record<string, JobHandler>;
  private readonly lockTtlMs: number;
  private readonly maxJobsPerTick: number;
  private readonly owner: string;
  private readonly defaultOffset: number;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.handlers = opts.handlers;
    this.lockTtlMs = opts.lockTtlMs ?? 5 * 60_000;
    this.maxJobsPerTick = opts.maxJobsPerTick ?? 25;
    this.owner = opts.owner ?? randomId("tick_");
    this.defaultOffset = opts.defaultUtcOffsetMinutes ?? 0;
  }

  async createJob(input: CreateJobInput, now = new Date()): Promise<JobDefinition> {
    const schedule = parseCron(input.cron); // throws CronParseError
    if (!this.handlers[input.handler]) throw new Error(`Unknown handler "${input.handler}"`);
    if (input.maxRuns !== undefined && input.maxRuns !== null && (!Number.isInteger(input.maxRuns) || input.maxRuns < 1))
      throw new Error("maxRuns must be a positive integer or null");
    const id = input.id ?? randomId("job_");
    if (!JOB_ID_RE.test(id)) throw new Error(`Invalid job id "${id}"`);
    if (await this.store.getJob(id)) throw new Error(`Job "${id}" already exists`);
    const offset = input.utcOffsetMinutes ?? this.defaultOffset;
    const next = nextRun(schedule, now, offset);
    const job: JobDefinition = {
      id,
      name: input.name,
      cron: schedule.source,
      handler: input.handler,
      payload: input.payload ?? null,
      status: input.paused ? "paused" : "active",
      utcOffsetMinutes: offset,
      maxRuns: input.maxRuns ?? null,
      runCount: 0,
      failureCount: 0,
      nextRunAt: next ? next.getTime() : null,
      lastRunAt: null,
      lastError: null,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
    await this.store.saveJob(job);
    return job;
  }

  async pauseJob(id: string, now = new Date()): Promise<void> {
    const job = await this.mustGet(id);
    job.status = "paused";
    job.updatedAt = now.getTime();
    await this.store.saveJob(job);
  }

  /** Resumes and recomputes nextRunAt from now (missed slots are not replayed). */
  async resumeJob(id: string, now = new Date()): Promise<void> {
    const job = await this.mustGet(id);
    if (job.status === "completed") throw new Error("Job has completed its maxRuns");
    job.status = "active";
    job.nextRunAt = nextRun(job.cron, now, job.utcOffsetMinutes)?.getTime() ?? null;
    job.updatedAt = now.getTime();
    await this.store.saveJob(job);
  }

  async deleteJob(id: string): Promise<boolean> {
    return this.store.deleteJob(id);
  }

  /**
   * Run all due jobs. Call this from a Cloudflare Cron Trigger `scheduled()` handler.
   * Safe to call concurrently / repeatedly: per-job lease locks + slot idempotency keys
   * (`<jobId>@<scheduledFor ISO>`) guarantee at most one successful execution per slot.
   * Misfire policy: if several slots were missed, the job runs once and skips ahead.
   */
  async tick(now = new Date()): Promise<TickReport> {
    const due = await this.store.listDueJobs(now.getTime(), this.maxJobsPerTick);
    const outcomes: TickOutcome[] = [];
    for (const candidate of due) outcomes.push(await this.processJob(candidate.id, now));
    return { at: now.toISOString(), processed: due.length, outcomes };
  }

  /** Manual trigger with a caller-supplied idempotency key (e.g. an admin "run now" button). */
  async runNow(jobId: string, idempotencyKey: string, now = new Date()): Promise<TickOutcome> {
    return this.processJob(jobId, now, { idempotencyKey, manual: true });
  }

  private async processJob(jobId: string, now: Date, manual?: { idempotencyKey: string; manual: true }): Promise<TickOutcome> {
    const nowMs = now.getTime();
    if (!(await this.store.acquireLock(jobId, this.owner, nowMs, this.lockTtlMs))) {
      return { jobId, outcome: "skipped", reason: "locked" };
    }
    try {
      const job = await this.store.getJob(jobId);
      if (!job) return { jobId, outcome: "skipped", reason: "not_due" };
      if (job.maxRuns !== null && job.runCount >= job.maxRuns) {
        if (job.status !== "completed") {
          job.status = "completed";
          job.nextRunAt = null;
          await this.store.saveJob(job);
        }
        return { jobId, outcome: "skipped", reason: "max_runs_reached" };
      }
      if (!manual && (job.status !== "active" || job.nextRunAt === null || job.nextRunAt > nowMs)) {
        return { jobId, outcome: "skipped", reason: "not_due" };
      }
      const scheduledFor = manual ? nowMs : job.nextRunAt!;
      const idempotencyKey = manual ? `${job.id}@manual:${manual.idempotencyKey}` : `${job.id}@${new Date(scheduledFor).toISOString()}`;
      const run: JobRun = {
        id: randomId("run_"),
        jobId: job.id,
        idempotencyKey,
        scheduledFor,
        status: "running",
        startedAt: nowMs,
        finishedAt: null,
        error: null,
        result: null,
      };
      if (!(await this.store.insertRun(run))) {
        // Slot already executed (e.g. lock expired mid-run and another tick retried). Repair nextRunAt.
        if (!manual) await this.advance(job, now, false, null);
        return { jobId, outcome: "skipped", reason: "duplicate" };
      }
      const handler = this.handlers[job.handler];
      let ok = false;
      let error: string | null = null;
      try {
        if (!handler) throw new Error(`No handler registered for "${job.handler}"`);
        run.result = (await handler({ job, runId: run.id, idempotencyKey, scheduledFor: new Date(scheduledFor), now, payload: job.payload })) ?? null;
        ok = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      run.status = ok ? "succeeded" : "failed";
      run.error = error;
      run.finishedAt = Math.max(nowMs, Date.now());
      await this.store.updateRun(run);
      await this.advance(job, now, ok, error, Boolean(manual));
      return ok
        ? { jobId, outcome: "succeeded", runId: run.id, idempotencyKey }
        : { jobId, outcome: "failed", runId: run.id, idempotencyKey, error: error ?? "unknown error" };
    } finally {
      await this.store.releaseLock(jobId, this.owner);
    }
  }

  private async advance(job: JobDefinition, now: Date, ok: boolean, error: string | null, manual = false): Promise<void> {
    const nowMs = now.getTime();
    if (ok) {
      job.runCount += 1;
      job.lastRunAt = nowMs;
      job.lastError = null;
    } else if (error !== null) {
      job.failureCount += 1;
      job.lastError = error.slice(0, 1000);
      job.lastRunAt = nowMs;
    }
    if (!manual) {
      const base = Math.max(nowMs, job.nextRunAt ?? nowMs);
      job.nextRunAt = nextRun(job.cron, new Date(base), job.utcOffsetMinutes)?.getTime() ?? null;
    }
    if (job.maxRuns !== null && job.runCount >= job.maxRuns) {
      job.status = "completed";
      job.nextRunAt = null;
    }
    job.updatedAt = nowMs;
    await this.store.saveJob(job);
  }

  private async mustGet(id: string): Promise<JobDefinition> {
    const j = await this.store.getJob(id);
    if (!j) throw new Error(`Job "${id}" not found`);
    return j;
  }
}
