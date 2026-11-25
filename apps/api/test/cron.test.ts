import { applyD1Migrations, createExecutionContext, createScheduledController, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { processPendingTasks } from "../src/cron/processor";
import { runScheduled } from "../src/cron/scheduled";
import type { TaskHandler } from "../src/deps";
import { NonRetryableError } from "../src/lib/tasks";
import { defaultTaskHandlers } from "../src/cron/handlers";
import { client, makeDeps, mockAi } from "./helpers";

// Each test starts from a freshly migrated, empty database.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function insertTask(fields: { type: string; payload?: unknown; max_attempts?: number; status?: string; attempts?: number; locked_until?: number | null; created_at?: number }) {
  const id = crypto.randomUUID();
  const now = fields.created_at ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO tasks (id, type, status, payload, attempts, max_attempts, created_at, updated_at, next_run_at, locked_until)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7, ?8)`,
  )
    .bind(id, fields.type, fields.status ?? "pending", JSON.stringify(fields.payload ?? {}), fields.attempts ?? 0, fields.max_attempts ?? 3, now, fields.locked_until ?? null)
    .run();
  return id;
}

const getTask = (id: string) => env.DB.prepare("SELECT * FROM tasks WHERE id = ?1").bind(id).first<Record<string, any>>();

describe("cron task processor", () => {
  it("runs a pending echo task to success", async () => {
    const id = await insertTask({ type: "echo", payload: { hi: "سلام" } });
    const report = await processPendingTasks(env, makeDeps());
    expect(report).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    const t = await getTask(id);
    expect(t).toMatchObject({ status: "succeeded", attempts: 1, error: null, locked_until: null });
    expect(JSON.parse(t!.result)).toEqual({ echo: { hi: "سلام" } });
    expect(t!.started_at).toBeTypeOf("number");
    expect(t!.finished_at).toBeTypeOf("number");
  });

  it("retries with backoff, then fails permanently at max_attempts — no infinite loop", async () => {
    let calls = 0;
    const boom: TaskHandler = async () => {
      calls++;
      throw new Error("transient boom");
    };
    let now = Date.now();
    const deps = makeDeps({ taskHandlers: { boom }, now: () => now });
    const id = await insertTask({ type: "boom", max_attempts: 2, created_at: now });

    expect(await processPendingTasks(env, deps)).toMatchObject({ claimed: 1, retried: 1 });
    let t = await getTask(id);
    expect(t).toMatchObject({ status: "pending", attempts: 1, error: "transient boom" });
    expect(t!.next_run_at).toBeGreaterThan(now);

    // Not due yet: same instant -> untouched.
    expect(await processPendingTasks(env, deps)).toMatchObject({ claimed: 0 });

    now += 16 * 60_000; // next cron tick
    expect(await processPendingTasks(env, deps)).toMatchObject({ claimed: 1, failed: 1 });
    t = await getTask(id);
    expect(t).toMatchObject({ status: "failed", attempts: 2 });

    // Any number of further runs never touch it again.
    for (let i = 0; i < 5; i++) {
      now += 16 * 60_000;
      expect(await processPendingTasks(env, deps)).toMatchObject({ claimed: 0 });
    }
    expect(calls).toBe(2);
  });

  it("non-retryable errors and unknown types fail after a single attempt", async () => {
    const fatal: TaskHandler = async () => {
      throw new NonRetryableError("bad payload");
    };
    const a = await insertTask({ type: "fatal", max_attempts: 5 });
    const b = await insertTask({ type: "does-not-exist", max_attempts: 5 });
    await processPendingTasks(env, makeDeps({ taskHandlers: { fatal } }));
    expect(await getTask(a)).toMatchObject({ status: "failed", attempts: 1, error: "bad payload" });
    expect(await getTask(b)).toMatchObject({ status: "failed", attempts: 1, error: "unknown task type 'does-not-exist'" });
  });

  it("recovers tasks whose lease expired, and fails them if attempts are exhausted", async () => {
    const now = Date.now();
    const retryable = await insertTask({ type: "echo", status: "running", attempts: 1, max_attempts: 3, locked_until: now - 1 });
    const exhausted = await insertTask({ type: "echo", status: "running", attempts: 3, max_attempts: 3, locked_until: now - 1 });
    const healthy = await insertTask({ type: "echo", status: "running", attempts: 1, max_attempts: 3, locked_until: now + 60_000 });
    const report = await processPendingTasks(env, makeDeps({ now: () => now }));
    expect(report.recovered).toBe(2);
    expect(await getTask(retryable)).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(await getTask(exhausted)).toMatchObject({ status: "failed", attempts: 3, error: "lease expired" });
    expect(await getTask(healthy)).toMatchObject({ status: "running", attempts: 1 });
  });

  it("never processes cancelled tasks and a cancel during execution wins", async () => {
    const cancelled = await insertTask({ type: "echo", status: "cancelled" });
    let target = "";
    const slow: TaskHandler = async ({ task }) => {
      await env.DB.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?1").bind(task.id).run();
      return { done: true };
    };
    target = await insertTask({ type: "slow" });
    await processPendingTasks(env, makeDeps({ taskHandlers: { slow, echo: defaultTaskHandlers.echo! } }));
    expect(await getTask(cancelled)).toMatchObject({ status: "cancelled", attempts: 0 });
    expect(await getTask(target)).toMatchObject({ status: "cancelled", result: null });
  });

  it("processes a bounded batch per run in FIFO order", async () => {
    const base = Date.now() - 100_000;
    const ids = [];
    for (let i = 0; i < 13; i++) ids.push(await insertTask({ type: "echo", created_at: base + i }));
    expect(await processPendingTasks(env, makeDeps(), { batchSize: 10 })).toMatchObject({ claimed: 10, succeeded: 10 });
    expect((await getTask(ids[12]!))!.status).toBe("pending");
    expect(await processPendingTasks(env, makeDeps(), { batchSize: 10 })).toMatchObject({ claimed: 3 });
  });

  it("ai.prompt tasks go through the cost controller", async () => {
    const ai = mockAi();
    const id = await insertTask({ type: "ai.prompt", payload: { prompt: "یک جمله دربارهٔ تهران" }, max_attempts: 1 });
    const bad = await insertTask({ type: "ai.prompt", payload: {}, max_attempts: 3 });
    await processPendingTasks(env, makeDeps({ ai: ai.provider }));
    expect(JSON.parse((await getTask(id))!.result)).toEqual({ reply: "پاسخ آزمایشی: یک جمله دربارهٔ تهران" });
    expect(await getTask(bad)).toMatchObject({ status: "failed", attempts: 1 });
    const usage = await env.DB.prepare("SELECT SUM(count) AS n FROM usage_counters WHERE service = 'workers_ai'").first<{ n: number }>();
    expect(usage!.n).toBe(1);
  });
});

describe("scheduler heartbeat and /api/health", () => {
  it("health reports never_run before the first cron, ok after, stale when cron stops", async () => {
    let now = Date.now();
    const deps = makeDeps({ now: () => now });
    const c = client({ deps });
    let h = await c.json("GET", "/api/health");
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ db: { status: "ok" }, ai: { status: "ok", provider: "mock" }, scheduler: { status: "never_run" }, status: "degraded" });

    const results = await runScheduled(env, deps, "*/15 * * * *");
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["task_processor", "ok"],
      ["maintenance", "ok"],
      ["autopilot", "ok"],
      ["heartbeat", "ok"],
    ]);
    h = await c.json("GET", "/api/health");
    expect(h.body).toMatchObject({ status: "ok", scheduler: { status: "ok" } });

    now += 40 * 60_000;
    h = await c.json("GET", "/api/health");
    expect(h.body).toMatchObject({ status: "degraded", scheduler: { status: "stale" } });
  });

  it("the Worker's scheduled() export processes tasks and records every job", async () => {
    const id = await insertTask({ type: "echo", payload: { n: 1 } });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/15 * * * *", scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await getTask(id))!.status).toBe("succeeded");
    const { results } = await env.DB.prepare("SELECT name, last_status, run_count FROM scheduled_jobs ORDER BY name").all();
    expect(results).toEqual([
      { name: "autopilot", last_status: "ok", run_count: 1 },
      { name: "heartbeat", last_status: "ok", run_count: 1 },
      { name: "maintenance", last_status: "ok", run_count: 1 },
      { name: "task_processor", last_status: "ok", run_count: 1 },
    ]);
  });

  it("reports ai unconfigured when no AI binding exists (production provider)", async () => {
    const { workersAiProvider } = await import("../src/lib/ai");
    const c = client({ deps: makeDeps({ ai: workersAiProvider }) });
    const h = await c.json("GET", "/api/health");
    expect(h.body.ai.status).toBe("unconfigured");
  });

  it("maintenance purges expired sessions and old rate-limit windows", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('u1', 'm@rayan.test', 'x', ?1, ?1)").bind(now).run();
    await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('old', 'u1', 0, 1), ('new', 'u1', ?1, ?2)").bind(now, now + 1e6).run();
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('k', 1, 1)").run();
    await runScheduled(env, makeDeps(), null);
    const s = await env.DB.prepare("SELECT id FROM sessions").all();
    expect(s.results).toEqual([{ id: "new" }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())!.n).toBe(0);
  });
});
