import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ERRORS_FA } from "@rayan/shared";
import { runScheduled } from "../src/cron/scheduled";
import { grantRole, makeDeps, mockAi, registeredClient } from "./helpers";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// 2026-11-25 12:00 UTC = 15:30 Tehran.
const NOW = Date.parse("2026-11-25T12:00:00Z");
const BUSINESS = { id: "shop1", name: "کتاب‌سرای آفتاب", industry: "books", city: "تهران", tone: "friendly", maxDiscountPercent: 20 };

async function admin(over: Parameters<typeof makeDeps>[0] = {}) {
  const deps = makeDeps({ now: () => NOW, ...over });
  const a = await registeredClient({ deps });
  await grantRole(a.userId, "admin");
  return { ...a, deps };
}

describe("autopilot RBAC", () => {
  it("members get 403 on every autopilot endpoint", async () => {
    const { c } = await registeredClient({ deps: makeDeps({ now: () => NOW }) });
    for (const [m, p, b] of [
      ["GET", "/api/autopilot/events?days=60"],
      ["POST", "/api/autopilot/campaigns/draft", { event_id: "yalda", business: BUSINESS }],
      ["GET", "/api/autopilot/campaigns"],
      ["POST", "/api/autopilot/campaigns/x/approve", {}],
      ["POST", "/api/autopilot/campaigns/x/reject", {}],
      ["GET", "/api/autopilot/jobs"],
      ["POST", "/api/autopilot/jobs", { name: "x", cron: "@daily", handler: "autopilot.scan_events" }],
      ["POST", "/api/autopilot/jobs/autopilot.scan_events", { action: "run_now" }],
    ] as const) {
      const r = await c.json(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.error.message).toBe(ERRORS_FA.forbidden);
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM autopilot_campaigns").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("GET /api/autopilot/events", () => {
  it("lists upcoming events in Asia/Tehran with Jalali dates and validates days", async () => {
    const { c } = await admin();
    const r = await c.json("GET", "/api/autopilot/events?days=60");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ timezone: "Asia/Tehran", days: 60 });
    const yalda = r.body.events.find((e: any) => e.id === "yalda");
    expect(yalda).toMatchObject({ date: "2026-12-21", title_fa: "شب یلدا", promotion_allowed: true });
    expect(yalda.jalali).toContain("آذر");
    expect(r.body.events.find((e: any) => e.id === "black_friday")).toMatchObject({ date: "2026-11-27" });
    const dates = r.body.events.map((e: any) => e.date);
    expect([...dates].sort()).toEqual(dates);
    for (const bad of ["0", "367", "abc"]) expect((await c.json("GET", `/api/autopilot/events?days=${bad}`)).status).toBe(400);
  });
});

describe("campaign drafts and the human approval gate", () => {
  it("drafts are pending_approval with an RTL SVG banner; approve records the approver and never publishes", async () => {
    const { c, userId } = await admin();
    const d = await c.json("POST", "/api/autopilot/campaigns/draft", { event_id: "yalda", business: BUSINESS });
    expect(d.status).toBe(201);
    const cmp = d.body.campaign;
    expect(cmp).toMatchObject({ status: "pending_approval", business_id: "shop1", generator: "template", event: { id: "yalda", date: "2026-12-21" } });
    expect(cmp.banner_svg).toMatch(/^<svg|<\?xml/);
    expect(cmp.banner_svg).toContain('direction="rtl"');
    expect(cmp.copy.headline.length).toBeGreaterThan(0);
    expect((await c.json("POST", "/api/autopilot/campaigns/draft", { event_id: "yalda", business: BUSINESS })).status).toBe(409);
    expect((await c.json("POST", "/api/autopilot/campaigns/draft", { event_id: "no_such_event", business: BUSINESS })).status).toBe(404);

    const list = await c.json("GET", "/api/autopilot/campaigns?status=pending_approval");
    expect(list.body.campaigns.map((x: any) => x.id)).toEqual([cmp.id]);

    const ok = await c.json("POST", `/api/autopilot/campaigns/${cmp.id}/approve`, { note: "تأیید شد" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ campaign: { status: "approved" }, approval: { decision: "approved", approver_id: userId }, publish_gate: { ok: true }, published: false });
    expect((await c.json("POST", `/api/autopilot/campaigns/${cmp.id}/approve`, {})).status).toBe(409);
    expect((await c.json("POST", `/api/autopilot/campaigns/${cmp.id}/reject`, {})).status).toBe(409);

    const rec = await env.DB.prepare("SELECT approver_id, decision, action, subject_id FROM autopilot_approvals").all();
    expect(rec.results).toEqual([{ approver_id: userId, decision: "approved", action: "publish", subject_id: cmp.id }]);
    await expect(env.DB.prepare("DELETE FROM autopilot_approvals").run()).rejects.toThrow(/append-only/);
    const detail = await c.json("GET", `/api/autopilot/campaigns/${cmp.id}`);
    expect(detail.body.campaign.status).toBe("approved");
    expect(detail.body.campaign.landing_html).toContain('dir="rtl"');
    expect(detail.body.approvals).toHaveLength(1);
    // Nothing anywhere is published/sent.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM autopilot_campaigns WHERE status IN ('published','sent')").first<{ n: number }>())!.n).toBe(0);
  });

  it("reject records the decision; mourning events cannot get a campaign", async () => {
    const { c } = await admin();
    const d = await c.json("POST", "/api/autopilot/campaigns/draft", { event_id: "black_friday", business: BUSINESS });
    const r = await c.json("POST", `/api/autopilot/campaigns/${d.body.campaign.id}/reject`, { note: "مناسب برند نیست" });
    expect(r.status).toBe(200);
    expect(r.body.campaign.status).toBe("rejected");
    expect(r.body.publish_gate.ok).toBe(false);
    expect(await env.DB.prepare("SELECT decision, note FROM autopilot_approvals").first()).toEqual({ decision: "rejected", note: "مناسب برند نیست" });

    const year = await c.json("GET", "/api/autopilot/events?days=366");
    const mourning = year.body.events.find((e: any) => e.sensitivity === "mourning");
    expect(mourning).toBeTruthy();
    const m = await c.json("POST", "/api/autopilot/campaigns/draft", { event_id: mourning.id, business: BUSINESS });
    expect(m.status).toBe(409);
  });

  it("optional LLM copy goes through the shared AI cost cap (and falls back to templates when capped)", async () => {
    const ai = mockAi();
    const { c } = await admin({ ai: ai.provider });
    await env.DB.prepare(`INSERT INTO usage_counters (service, day, count, "limit", updated_at) VALUES ('workers_ai', '2026-11-25', 3, 3, 0)`).run();
    const d = await c.json("POST", "/api/autopilot/campaigns/draft", { event_id: "yalda", business: BUSINESS, use_llm: true });
    expect(d.status).toBe(201);
    expect(d.body.campaign.generator).toBe("template");
    expect(ai.calls).toHaveLength(0);
  });
});

describe("Autopilot scheduler in the existing cron", () => {
  it("the seeded daily job autopilot.scan_events runs from scheduled(), drafts relevant events in 14 days, once per slot", async () => {
    const { c } = await admin();
    const jobs = await c.json("GET", "/api/autopilot/jobs");
    expect(jobs.body.jobs.map((j: any) => [j.id, j.cron, j.status, j.utc_offset_minutes])).toEqual([["autopilot.scan_events", "0 9 * * *", "active", 210]]);
    // Make the seeded job due relative to the fixed test clock.
    await env.DB.prepare("UPDATE autopilot_jobs SET next_run_at = ?1").bind(NOW - 1000).run();

    const deps = makeDeps({ now: () => NOW });
    const results = await runScheduled(env, deps, "*/15 * * * *");
    const ap = results.find((r) => r.name === "autopilot")!;
    expect(ap.status).toBe("ok");
    expect((ap.output as any).outcomes).toMatchObject([{ jobId: "autopilot.scan_events", outcome: "succeeded" }]);

    const run = await env.DB.prepare("SELECT status, result_json FROM autopilot_job_runs").first<{ status: string; result_json: string }>();
    expect(run!.status).toBe("succeeded");
    const result = JSON.parse(run!.result_json);
    expect(result.horizonDays).toBe(14);
    expect(result.created.length).toBeGreaterThan(0);
    const { results: drafts } = await env.DB.prepare("SELECT status, event_instance_id FROM autopilot_campaigns ORDER BY event_instance_id").all<any>();
    expect(drafts.length).toBe(result.created.length);
    expect(drafts.every((d) => d.status === "pending_approval")).toBe(true);
    expect(drafts.some((d) => d.event_instance_id === "black_friday@2026-11-27")).toBe(true);
    expect(drafts.some((d) => d.event_instance_id.startsWith("yalda@"))).toBe(false); // 26 days away

    // Next slot: 09:00 Tehran tomorrow = 05:30 UTC.
    const job = await env.DB.prepare("SELECT next_run_at, run_count FROM autopilot_jobs").first<{ next_run_at: number; run_count: number }>();
    expect(job).toEqual({ next_run_at: Date.parse("2026-11-26T05:30:00Z"), run_count: 1 });

    // Same tick again: not due → no second run, no duplicate drafts.
    await runScheduled(env, deps, "*/15 * * * *");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM autopilot_job_runs").first<{ n: number }>())!.n).toBe(1);

    // Manual run_now is idempotent on content: drafts are deduped per event instance.
    const now = await c.json("POST", "/api/autopilot/jobs/autopilot.scan_events", { action: "run_now" });
    expect(now.body.outcome.outcome).toBe("succeeded");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM autopilot_campaigns").first<{ n: number }>())!.n).toBe(drafts.length);
    const health = await env.DB.prepare("SELECT last_status, run_count FROM scheduled_jobs WHERE name = 'autopilot'").first();
    expect(health).toEqual({ last_status: "ok", run_count: 2 });
  });

  it("jobs API: validates cron, creates, pauses, resumes and deletes", async () => {
    const { c } = await admin();
    expect((await c.json("POST", "/api/autopilot/jobs", { name: "bad", cron: "61 * * * *", handler: "autopilot.scan_events" })).status).toBe(400);
    expect((await c.json("POST", "/api/autopilot/jobs", { name: "bad", cron: "@daily", handler: "shell.exec" })).status).toBe(400);
    const created = await c.json("POST", "/api/autopilot/jobs", {
      id: "weekly-books",
      name: "پویش هفتگی",
      cron: "0 10 * * 6",
      handler: "autopilot.scan_events",
      payload: { horizonDays: 30, business: BUSINESS },
    });
    expect(created.status).toBe(201);
    expect(created.body.job).toMatchObject({ id: "weekly-books", status: "active", utc_offset_minutes: 210 });
    expect((await c.json("POST", "/api/autopilot/jobs", { id: "weekly-books", name: "x", cron: "@daily", handler: "autopilot.scan_events" })).status).toBe(409);
    expect((await c.json("POST", "/api/autopilot/jobs/weekly-books", { action: "pause" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM autopilot_jobs WHERE id = 'weekly-books'").first()).toEqual({ status: "paused" });
    expect((await c.json("POST", "/api/autopilot/jobs/weekly-books", { action: "resume" })).status).toBe(200);
    expect((await c.json("POST", "/api/autopilot/jobs/weekly-books", { action: "delete" })).status).toBe(200);
    expect((await c.json("POST", "/api/autopilot/jobs/weekly-books", { action: "pause" })).status).toBe(404);
    const audit = await env.DB.prepare("SELECT action FROM audit_logs WHERE action LIKE 'autopilot.job.%' ORDER BY id").all();
    expect(audit.results.map((r: any) => r.action)).toEqual(["autopilot.job.create", "autopilot.job.pause", "autopilot.job.resume", "autopilot.job.delete"]);
  });
});
