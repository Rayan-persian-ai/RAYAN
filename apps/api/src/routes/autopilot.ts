import { Hono, type Context } from "hono";
import { approvalPayload, formatJalali, isPromotionSuppressed, isValidCron, type Approver, type BusinessProfile, type CampaignDraft, type JobDefinition } from "@rayan/autopilot";
import { autopilotJobActionSchema, autopilotJobSchema, campaignDecisionSchema, campaignDraftSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { approvalGate, autopilotScheduler, campaignStore, draftForEvent, loadCalendar, SCAN_EVENTS_HANDLER, schedulerStore } from "../lib/autopilot";
import { newId } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/request";
import { requirePermission } from "../middleware/auth";

export const autopilotRoutes = new Hono<AppEnv>();

/** Upcoming events (built-in + custom), dates resolved in Asia/Tehran. */
autopilotRoutes.get("/events", requirePermission("autopilot:read"), async (c) => {
  const raw = c.req.query("days");
  const days = raw === undefined ? 60 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new ApiError(400, "invalid_input", { days: "1..366" });
  const now = new Date(c.var.deps.now());
  const cal = await loadCalendar(c.env);
  const events = cal.upcoming(now, days).map((e) => ({
    id: e.id,
    instance_id: e.instanceId,
    title: e.title,
    title_fa: e.titleFa,
    date: e.date,
    jalali: formatJalali(e.jalali, { persianDigits: true, monthName: true }),
    category: e.category,
    tags: e.tags,
    sensitivity: e.sensitivity,
    promotion_allowed: !isPromotionSuppressed(e),
    holiday: e.holiday,
    duration_days: e.durationDays,
    lead_days: e.leadDays,
    approximate: e.approximate,
  }));
  return c.json({ timezone: "Asia/Tehran", from: now.toISOString(), days, events });
});

function summarizeCampaign(d: CampaignDraft, full = false) {
  return {
    id: d.id,
    version: d.version,
    status: d.status,
    business_id: d.businessId,
    event: d.event,
    created_at: d.createdAt,
    relevance: d.relevance,
    idea: d.idea,
    copy: d.copy,
    discount: d.discount,
    schedule: d.schedule,
    generator: d.generator,
    warnings: d.warnings,
    banner_svg: d.assets.bannerSvg,
    ...(full ? { poster_svg: d.assets.posterSvg, landing_html: d.assets.landingHtml, audience: d.audience } : {}),
  };
}

autopilotRoutes.post("/campaigns/draft", requirePermission("autopilot:manage"), async (c) => {
  const input = await parseJson(c, campaignDraftSchema);
  const now = new Date(c.var.deps.now());
  const cal = await loadCalendar(c.env);
  const ev = cal.upcoming(now, 366).find((e) => e.id === input.event_id);
  if (!ev) throw new ApiError(404, "not_found", { event_id: "no occurrence in the next 366 days" });
  if (isPromotionSuppressed(ev)) throw new ApiError(409, "conflict", { reason: "mourning event — promotional campaigns are blocked" });
  const { result, draft } = await draftForEvent(c.env, c.var.deps, ev, input.business as BusinessProfile, { useLlm: input.use_llm });
  if (!result.created) throw new ApiError(409, "conflict", { reason: "a draft for this event instance already exists", id: result.id });
  await audit(c, { actor: c.var.auth!.user.id, action: "autopilot.campaign.draft", targetType: "campaign", targetId: result.id, metadata: { event: ev.instanceId, generator: draft!.generator } });
  return c.json({ campaign: summarizeCampaign(draft!, true) }, 201);
});

autopilotRoutes.get("/campaigns", requirePermission("autopilot:read"), async (c) => {
  const status = c.req.query("status");
  const allowed = ["pending_approval", "approved", "rejected", "published", "sent", "archived"];
  if (status && !allowed.includes(status)) throw new ApiError(400, "invalid_input");
  const list = await campaignStore(c.env).list(status ? { status: status as CampaignDraft["status"] } : {});
  return c.json({ campaigns: list.slice(0, 50).map((d) => summarizeCampaign(d)) });
});

autopilotRoutes.get("/campaigns/:id", requirePermission("autopilot:read"), async (c) => {
  const d = await campaignStore(c.env).get(c.req.param("id"));
  if (!d) throw new ApiError(404, "not_found");
  const { results } = await c.env.DB.prepare(
    `SELECT id, action, decision, approver_id, decided_at, expires_at, note FROM autopilot_approvals
     WHERE subject_type = 'campaign' AND subject_id = ?1 ORDER BY decided_at DESC`,
  )
    .bind(d.id)
    .all();
  return c.json({ campaign: summarizeCampaign(d, true), approvals: results });
});

function approverFor(c: Context<AppEnv>): Approver {
  const a = c.var.auth!;
  return { id: a.user.id, kind: "human", role: a.roles.includes("super_admin") ? "owner" : "admin", displayName: a.user.display_name ?? a.user.email };
}

/**
 * Human decision on a draft. Approval is recorded in the append-only autopilot_approvals (bound to the
 * content hash of the 'publish' payload) and moves the draft to 'approved'. It never publishes or sends:
 * there is no publish endpoint in this phase.
 */
async function decideCampaign(c: Context<AppEnv>, decision: "approved" | "rejected") {
  const { note } = await parseJson(c, campaignDecisionSchema);
  const id = c.req.param("id") ?? "";
  const store = campaignStore(c.env);
  const draft = await store.get(id);
  if (!draft) throw new ApiError(404, "not_found");
  const now = c.var.deps.now();
  // Atomic state transition first (only from pending_approval), then the append-only record.
  const claimed = await c.env.DB.prepare(
    `UPDATE autopilot_campaigns SET status = ?1, draft_json = json_set(draft_json, '$.status', ?1), updated_at = ?2
     WHERE id = ?3 AND status = 'pending_approval'`,
  )
    .bind(decision, now, id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) throw new ApiError(409, "conflict", { status: draft.status });
  const gate = approvalGate(c.env);
  const req = { subjectType: "campaign" as const, subjectId: id, action: "publish" as const, content: approvalPayload(draft, "publish"), approver: approverFor(c), note, now: new Date(now) };
  let record;
  try {
    record = decision === "approved" ? await gate.approve(req) : await gate.reject(req);
  } catch (e) {
    await c.env.DB.prepare(`UPDATE autopilot_campaigns SET status = 'pending_approval', draft_json = json_set(draft_json, '$.status', 'pending_approval') WHERE id = ?1`).bind(id).run();
    throw e;
  }
  await audit(c, { actor: c.var.auth!.user.id, action: `autopilot.campaign.${decision === "approved" ? "approve" : "reject"}`, targetType: "campaign", targetId: id, metadata: { content_hash: record.contentHash, note: note ?? null } });
  const check = await gate.check({ subjectType: "campaign", subjectId: id, action: "publish", content: approvalPayload(draft, "publish"), now: new Date(now) });
  return c.json({ campaign: { id, status: decision }, approval: { id: record.id, decision: record.decision, approver_id: record.approver.id, content_hash: record.contentHash, decided_at: record.decidedAt }, publish_gate: { ok: check.ok, reason: check.reason }, published: false });
}

autopilotRoutes.post("/campaigns/:id/approve", requirePermission("autopilot:approve"), (c) => decideCampaign(c, "approved"));
autopilotRoutes.post("/campaigns/:id/reject", requirePermission("autopilot:approve"), (c) => decideCampaign(c, "rejected"));

function serializeJob(j: JobDefinition) {
  return {
    id: j.id,
    name: j.name,
    cron: j.cron,
    handler: j.handler,
    payload: j.payload,
    status: j.status,
    utc_offset_minutes: j.utcOffsetMinutes,
    max_runs: j.maxRuns,
    run_count: j.runCount,
    failure_count: j.failureCount,
    next_run_at: j.nextRunAt,
    last_run_at: j.lastRunAt,
    last_error: j.lastError,
  };
}

autopilotRoutes.get("/jobs", requirePermission("autopilot:read"), async (c) => {
  const { results: jobs } = await c.env.DB.prepare(`SELECT id FROM autopilot_jobs ORDER BY created_at`).all<{ id: string }>();
  const store = schedulerStore(c.env);
  const out = [];
  for (const { id } of jobs) {
    const j = await store.getJob(id);
    if (!j) continue;
    const runs = await store.listRuns(id, 5);
    out.push({ ...serializeJob(j), recent_runs: runs.map((r) => ({ id: r.id, status: r.status, scheduled_for: r.scheduledFor, started_at: r.startedAt, finished_at: r.finishedAt, error: r.error, result: r.result })) });
  }
  return c.json({ jobs: out, handlers: [SCAN_EVENTS_HANDLER] });
});

autopilotRoutes.post("/jobs", requirePermission("autopilot:manage"), async (c) => {
  const input = await parseJson(c, autopilotJobSchema);
  if (!isValidCron(input.cron)) throw new ApiError(400, "invalid_input", { cron: "invalid cron expression" });
  const sched = autopilotScheduler(c.env, c.var.deps);
  let job: JobDefinition;
  try {
    job = await sched.createJob(
      {
        id: input.id,
        name: input.name,
        cron: input.cron,
        handler: input.handler,
        payload: input.payload ?? { horizonDays: 14, business: { id: "default", name: "رایان", industry: "general" }, useLlm: false },
        utcOffsetMinutes: input.utc_offset_minutes,
        paused: input.paused,
      },
      new Date(c.var.deps.now()),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already exists/.test(msg)) throw new ApiError(409, "conflict", { id: input.id });
    throw new ApiError(400, "invalid_input", { job: msg });
  }
  await audit(c, { actor: c.var.auth!.user.id, action: "autopilot.job.create", targetType: "autopilot_job", targetId: job.id, metadata: { cron: job.cron } });
  return c.json({ job: serializeJob(job) }, 201);
});

autopilotRoutes.post("/jobs/:id", requirePermission("autopilot:manage"), async (c) => {
  const { action } = await parseJson(c, autopilotJobActionSchema);
  const id = c.req.param("id") ?? "";
  const sched = autopilotScheduler(c.env, c.var.deps);
  const now = new Date(c.var.deps.now());
  const exists = await c.env.DB.prepare("SELECT id FROM autopilot_jobs WHERE id = ?1").bind(id).first();
  if (!exists) throw new ApiError(404, "not_found");
  let outcome: unknown = null;
  try {
    if (action === "pause") await sched.pauseJob(id, now);
    else if (action === "resume") await sched.resumeJob(id, now);
    else if (action === "delete") await sched.deleteJob(id);
    else outcome = await sched.runNow(id, `${newId()}`, now);
  } catch (e) {
    throw new ApiError(409, "conflict", { job: e instanceof Error ? e.message : String(e) });
  }
  await audit(c, { actor: c.var.auth!.user.id, action: `autopilot.job.${action}`, targetType: "autopilot_job", targetId: id });
  return c.json({ ok: true, action, outcome });
});

