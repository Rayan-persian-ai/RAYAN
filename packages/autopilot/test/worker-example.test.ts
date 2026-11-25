import { describe, expect, it } from "vitest";
import worker, { buildScheduler } from "../examples/worker.js";
import { D1CampaignStore, D1SchedulerStore } from "../src/index.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";

describe("Cloudflare scheduled() example", () => {
  it("a cron tick drafts campaigns for upcoming events, idempotently", async () => {
    const DB = createSqliteD1();
    const env = { DB };
    const created = new Date("2026-11-25T00:00:00Z");
    await buildScheduler(env).createJob(
      {
        id: "daily_drafts",
        name: "Draft campaigns for the next 30 days",
        cron: "0 9 * * *", // 09:00 Tehran
        handler: "campaigns.draft_upcoming",
        payload: { business: { id: "biz_anar", name: "قنادی انار", industry: "food" }, horizonDays: 30 },
      },
      created,
    );
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    const fire = new Date("2026-11-25T05:30:00Z").getTime(); // 09:00 Tehran
    await worker.scheduled({ scheduledTime: fire, cron: "* * * * *" }, env, ctx);
    await worker.scheduled({ scheduledTime: fire + 20_000, cron: "* * * * *" }, env, ctx); // duplicate trigger
    await Promise.all(pending);
    const drafts = await new D1CampaignStore(DB).list();
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.status === "pending_approval")).toBe(true);
    expect(drafts.map((d) => d.event.id)).toContain("yalda");
    const runs = await new D1SchedulerStore(DB).listRuns("daily_drafts");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
  });
});
