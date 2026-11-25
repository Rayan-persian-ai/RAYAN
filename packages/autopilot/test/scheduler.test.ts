import { describe, expect, it } from "vitest";
import {
  parseCron,
  nextRun,
  nextRuns,
  isValidCron,
  CronParseError,
  Scheduler,
  MemorySchedulerStore,
  D1SchedulerStore,
  type SchedulerStore,
} from "../src/index.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";

const iso = (d: Date | null) => d?.toISOString();

describe("cron parser", () => {
  it("parses fields, ranges, steps, lists, names and macros", () => {
    const s = parseCron("*/15 9-17 * jan,jul mon-fri");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...s.months]).toEqual([1, 7]);
    expect([...s.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 5-7").daysOfWeek].sort()).toEqual([0, 5, 6]);
    expect([...parseCron("10-40/10 * * * *").minutes]).toEqual([10, 20, 30, 40]);
    expect(parseCron("@daily").source).toBe("@daily");
    expect([...parseCron("@hourly").minutes]).toEqual([0]);
  });

  it("rejects invalid expressions", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "a * * * *", "5-1 * * * *", "@sometimes", "1,,2 * * * *"]) {
      expect(isValidCron(bad), bad).toBe(false);
    }
    expect(() => parseCron("* * *")).toThrow(CronParseError);
  });

  it("computes next runs in UTC", () => {
    const from = new Date("2026-11-25T10:07:30Z");
    expect(iso(nextRun("*/15 * * * *", from))).toBe("2026-11-25T10:15:00.000Z");
    expect(iso(nextRun("0 9 * * *", from))).toBe("2026-11-26T09:00:00.000Z");
    expect(iso(nextRun("0 0 1 * *", from))).toBe("2026-12-01T00:00:00.000Z");
    expect(iso(nextRun("30 8 * * mon", from))).toBe("2026-11-30T08:30:00.000Z");
    expect(iso(nextRun("@yearly", from))).toBe("2027-01-01T00:00:00.000Z");
    // strictly after
    expect(iso(nextRun("0 10 * * *", new Date("2026-11-25T10:00:00Z")))).toBe("2026-11-26T10:00:00.000Z");
  });

  it("uses Vixie OR semantics when both day fields are restricted", () => {
    // 13th of the month OR any Friday
    const runs = nextRuns("0 0 13 * fri", new Date("2026-11-25T00:00:00Z"), 3).map((d) => d.toISOString().slice(0, 10));
    expect(runs).toEqual(["2026-11-27", "2026-12-04", "2026-12-11"]);
    const runs2 = nextRuns("0 0 13 * fri", new Date("2026-12-11T01:00:00Z"), 2).map((d) => d.toISOString().slice(0, 10));
    expect(runs2).toEqual(["2026-12-13", "2026-12-18"]);
  });

  it("supports a fixed UTC offset (Asia/Tehran = +210)", () => {
    // 09:00 Tehran = 05:30 UTC
    expect(iso(nextRun("0 9 * * *", new Date("2026-11-25T06:00:00Z"), 210))).toBe("2026-11-26T05:30:00.000Z");
    // Saturday 08:00 Tehran
    expect(iso(nextRun("0 8 * * sat", new Date("2026-11-25T00:00:00Z"), 210))).toBe("2026-11-28T04:30:00.000Z");
  });

  it("handles leap days and impossible dates", () => {
    expect(iso(nextRun("0 0 29 2 *", new Date("2026-03-01T00:00:00Z")))).toBe("2028-02-29T00:00:00.000Z");
    expect(nextRun("0 0 31 2 *", new Date("2026-01-01T00:00:00Z"))).toBeNull();
  });
});

function suite(name: string, makeStore: () => SchedulerStore) {
  describe(`Scheduler (${name})`, () => {
    const t0 = new Date("2027-01-01T00:00:30Z");
    const at = (iso: string) => new Date(iso);

    it("creates jobs with computed nextRunAt and validates input", async () => {
      const store = makeStore();
      const s = new Scheduler({ store, handlers: { noop: () => "ok" } });
      const job = await s.createJob({ id: "j1", name: "every 5", cron: "*/5 * * * *", handler: "noop" }, t0);
      expect(new Date(job.nextRunAt!).toISOString()).toBe("2027-01-01T00:05:00.000Z");
      await expect(s.createJob({ id: "j1", name: "dup", cron: "* * * * *", handler: "noop" }, t0)).rejects.toThrow(/exists/);
      await expect(s.createJob({ name: "bad", cron: "61 * * * *", handler: "noop" }, t0)).rejects.toThrow();
      await expect(s.createJob({ name: "bad", cron: "* * * * *", handler: "missing" }, t0)).rejects.toThrow(/Unknown handler/);
      await expect(s.createJob({ name: "bad", cron: "* * * * *", handler: "noop", maxRuns: 0 }, t0)).rejects.toThrow();
    });

    it("runs due jobs once per slot and advances nextRunAt", async () => {
      const store = makeStore();
      const calls: string[] = [];
      const s = new Scheduler({ store, handlers: { rec: ({ idempotencyKey }) => void calls.push(idempotencyKey) } });
      await s.createJob({ id: "rec", name: "r", cron: "*/5 * * * *", handler: "rec" }, t0);
      expect((await s.tick(at("2027-01-01T00:04:00Z"))).processed).toBe(0);
      const r = await s.tick(at("2027-01-01T00:05:10Z"));
      expect(r.outcomes).toEqual([expect.objectContaining({ jobId: "rec", outcome: "succeeded", idempotencyKey: "rec@2027-01-01T00:05:00.000Z" })]);
      expect((await s.tick(at("2027-01-01T00:05:40Z"))).processed).toBe(0); // same slot again: not due
      const job = await store.getJob("rec");
      expect(new Date(job!.nextRunAt!).toISOString()).toBe("2027-01-01T00:10:00.000Z");
      expect(job!.runCount).toBe(1);
      expect(calls).toHaveLength(1);
    });

    it("skips missed slots (misfire policy: run once, then next future slot)", async () => {
      const store = makeStore();
      let n = 0;
      const s = new Scheduler({ store, handlers: { c: () => void n++ } });
      await s.createJob({ id: "m", name: "m", cron: "* * * * *", handler: "c" }, t0);
      await s.tick(at("2027-01-01T03:00:20Z"));
      expect(n).toBe(1);
      expect(new Date((await store.getJob("m"))!.nextRunAt!).toISOString()).toBe("2027-01-01T03:01:00.000Z");
    });

    it("never double-runs under concurrent ticks (lock + idempotency key)", async () => {
      const store = makeStore();
      let n = 0;
      const slow = async () => {
        n++;
        await new Promise((r) => setTimeout(r, 20));
      };
      const a = new Scheduler({ store, handlers: { slow }, owner: "A" });
      const b = new Scheduler({ store, handlers: { slow }, owner: "B" });
      await a.createJob({ id: "c1", name: "c", cron: "* * * * *", handler: "slow" }, t0);
      const now = at("2027-01-01T00:01:05Z");
      const [ra, rb] = await Promise.all([a.tick(now), b.tick(now)]);
      expect(n).toBe(1);
      const outcomes = [...ra.outcomes, ...rb.outcomes].map((o) => o.outcome).sort();
      expect(outcomes).toContain("succeeded");
      expect(outcomes.filter((o) => o === "succeeded")).toHaveLength(1);
    });

    it("an existing run for the slot is treated as duplicate (e.g. after lock expiry)", async () => {
      const store = makeStore();
      let n = 0;
      const s = new Scheduler({ store, handlers: { c: () => void n++ } });
      const job = await s.createJob({ id: "d", name: "d", cron: "* * * * *", handler: "c" }, t0);
      const key = `d@${new Date(job.nextRunAt!).toISOString()}`;
      await store.insertRun({ id: "r0", jobId: "d", idempotencyKey: key, scheduledFor: job.nextRunAt!, status: "succeeded", startedAt: job.nextRunAt!, finishedAt: job.nextRunAt!, error: null, result: null });
      const r = await s.tick(at("2027-01-01T00:01:10Z"));
      expect(r.outcomes[0]).toMatchObject({ outcome: "skipped", reason: "duplicate" });
      expect(n).toBe(0);
      expect((await store.getJob("d"))!.nextRunAt).toBeGreaterThan(job.nextRunAt!);
    });

    it("respects a lock held by another invocation", async () => {
      const store = makeStore();
      const s = new Scheduler({ store, handlers: { c: () => 1 }, owner: "me" });
      await s.createJob({ id: "l", name: "l", cron: "* * * * *", handler: "c" }, t0);
      const now = at("2027-01-01T00:01:10Z");
      expect(await store.acquireLock("l", "other", now.getTime(), 60_000)).toBe(true);
      expect((await s.tick(now)).outcomes[0]).toMatchObject({ outcome: "skipped", reason: "locked" });
      // expired lock is taken over
      expect((await s.tick(at("2027-01-01T00:02:20Z"))).outcomes[0]).toMatchObject({ outcome: "succeeded" });
    });

    it("stops after maxRuns", async () => {
      const store = makeStore();
      const s = new Scheduler({ store, handlers: { c: () => 1 } });
      await s.createJob({ id: "mx", name: "mx", cron: "* * * * *", handler: "c", maxRuns: 2 }, t0);
      await s.tick(at("2027-01-01T00:01:01Z"));
      await s.tick(at("2027-01-01T00:02:01Z"));
      const r = await s.tick(at("2027-01-01T00:03:01Z"));
      expect(r.processed).toBe(0);
      const job = await store.getJob("mx");
      expect(job).toMatchObject({ status: "completed", runCount: 2, nextRunAt: null });
      await expect(s.resumeJob("mx")).rejects.toThrow(/completed/);
    });

    it("records failures without counting them as runs", async () => {
      const store = makeStore();
      const s = new Scheduler({ store, handlers: { boom: () => { throw new Error("kaboom"); } } });
      await s.createJob({ id: "f", name: "f", cron: "* * * * *", handler: "boom", maxRuns: 1 }, t0);
      const r = await s.tick(at("2027-01-01T00:01:01Z"));
      expect(r.outcomes[0]).toMatchObject({ outcome: "failed", error: "kaboom" });
      const job = await store.getJob("f");
      expect(job).toMatchObject({ status: "active", runCount: 0, failureCount: 1, lastError: "kaboom" });
      const runs = await store.listRuns("f");
      expect(runs[0]).toMatchObject({ status: "failed", error: "kaboom" });
    });

    it("pause/resume and runNow with an idempotency key", async () => {
      const store = makeStore();
      let n = 0;
      const s = new Scheduler({ store, handlers: { c: ({ payload }) => { n++; return payload; } } });
      await s.createJob({ id: "p", name: "p", cron: "0 * * * *", handler: "c", payload: { a: 1 } }, t0);
      await s.pauseJob("p", t0);
      expect((await s.tick(at("2027-01-01T01:00:10Z"))).processed).toBe(0);
      expect(await s.runNow("p", "admin-click-1", at("2027-01-01T01:30:00Z"))).toMatchObject({ outcome: "succeeded" });
      expect(await s.runNow("p", "admin-click-1", at("2027-01-01T01:31:00Z"))).toMatchObject({ outcome: "skipped", reason: "duplicate" });
      expect(n).toBe(1);
      expect((await store.getRunByKey("p@manual:admin-click-1"))!.result).toEqual({ a: 1 });
      await s.resumeJob("p", at("2027-01-01T01:30:00Z"));
      expect(new Date((await store.getJob("p"))!.nextRunAt!).toISOString()).toBe("2027-01-01T02:00:00.000Z");
      expect(await s.deleteJob("p")).toBe(true);
    });

    it("evaluates jobs in Tehran time", async () => {
      const store = makeStore();
      const s = new Scheduler({ store, handlers: { c: () => 1 }, defaultUtcOffsetMinutes: 210 });
      const job = await s.createJob({ id: "tz", name: "9am Tehran", cron: "0 9 * * *", handler: "c" }, t0);
      expect(new Date(job.nextRunAt!).toISOString()).toBe("2027-01-01T05:30:00.000Z");
    });
  });
}

suite("memory store", () => new MemorySchedulerStore());
suite("D1 store on SQLite", () => new D1SchedulerStore(createSqliteD1()));
