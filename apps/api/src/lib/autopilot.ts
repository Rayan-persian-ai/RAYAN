/**
 * Wiring of @rayan/autopilot into the API: D1-backed Scheduler (ticked by the existing cron), EventCalendar
 * (Asia/Tehran), CampaignPlanner (templates; optional Workers AI through the existing cost cap) and
 * ApprovalGate (append-only autopilot_approvals). Nothing here publishes or sends — drafts only.
 */
import {
  ApprovalGate,
  CampaignPlanner,
  D1ApprovalStore,
  D1CampaignStore,
  D1SchedulerStore,
  EventCalendar,
  Scheduler,
  type BusinessProfile,
  type CalendarEvent,
  type D1DatabaseLike as AutopilotD1,
  type EventDefinition,
  type JobContext,
  type LlmFn,
} from "@rayan/autopilot";
import type { AppDeps } from "../deps";
import type { Env } from "../env";
import { cappedLlm } from "./cortex";
import { isFlagEnabled } from "./flags";

export const TEHRAN_OFFSET_MINUTES = 210;
export const SCAN_EVENTS_HANDLER = "autopilot.scan_events";

const d1 = (env: Env) => env.DB as unknown as AutopilotD1;

interface CustomEventRow {
  id: string;
  title: string;
  title_fa: string;
  category: string;
  rule_json: string;
  tags_json: string;
  sensitivity: string;
  duration_days: number;
  lead_days: number;
}

/** Calendar with built-ins plus enabled global custom events from autopilot_events (invalid rows are skipped). */
export async function loadCalendar(env: Env): Promise<EventCalendar> {
  const cal = new EventCalendar({ timeZone: "Asia/Tehran" });
  const { results } = await env.DB.prepare(
    `SELECT id, title, title_fa, category, rule_json, tags_json, sensitivity, duration_days, lead_days
     FROM autopilot_events WHERE enabled = 1 AND business_id IS NULL`,
  ).all<CustomEventRow>();
  for (const r of results) {
    try {
      cal.addCustomEvent({
        id: r.id,
        title: r.title,
        titleFa: r.title_fa,
        category: r.category as EventDefinition["category"],
        rule: JSON.parse(r.rule_json) as EventDefinition["rule"],
        tags: JSON.parse(r.tags_json) as EventDefinition["tags"],
        sensitivity: r.sensitivity as EventDefinition["sensitivity"],
        durationDays: r.duration_days,
        leadDays: r.lead_days,
      });
    } catch (e) {
      console.error("skipping invalid custom event", r.id, e);
    }
  }
  return cal;
}

export function campaignStore(env: Env) {
  return new D1CampaignStore(d1(env));
}

export function approvalGate(env: Env) {
  // guarded = one human approval bound to the content hash; agents can never approve.
  return new ApprovalGate(new D1ApprovalStore(d1(env)), { level: "guarded", allowedRoles: ["owner", "admin"] });
}

/** LLM for campaign copy, only when asked and allowed; every call is charged to the shared AI cap. */
async function plannerLlm(env: Env, deps: AppDeps, useLlm: boolean): Promise<LlmFn | null> {
  if (!useLlm || !deps.ai.isAvailable(env) || !(await isFlagEnabled(env.DB, "ai_enabled", true))) return null;
  const llm = cappedLlm(env, deps);
  return ({ system, prompt }) => llm({ system, prompt, json: true });
}

export interface DraftResult {
  created: boolean;
  id: string;
  reason?: string;
}

export async function draftForEvent(env: Env, deps: AppDeps, ev: CalendarEvent, business: BusinessProfile, opts: { useLlm?: boolean; skipIrrelevant?: boolean } = {}) {
  const store = campaignStore(env);
  const now = new Date(deps.now());
  const exists = await env.DB.prepare("SELECT id FROM autopilot_campaigns WHERE business_id = ?1 AND event_instance_id = ?2 LIMIT 1")
    .bind(business.id, ev.instanceId)
    .first<{ id: string }>();
  if (exists) return { result: { created: false, id: exists.id, reason: "exists" } as DraftResult, draft: await store.get(exists.id) };
  const planner = new CampaignPlanner({ llmTimeoutMs: 15_000 });
  // Planner falls back to deterministic Persian templates on any LLM error (incl. the daily cap).
  const draft = await planner.plan(ev, business, { now, llm: await plannerLlm(env, deps, !!opts.useLlm), contacts: [] });
  if (opts.skipIrrelevant && draft.relevance.recommendation === "skip") {
    return { result: { created: false, id: draft.id, reason: "not_relevant" } as DraftResult, draft: null };
  }
  draft.status = "pending_approval"; // invariant: drafts are never born approved
  await store.save(draft);
  return { result: { created: true, id: draft.id } as DraftResult, draft };
}

interface ScanPayload {
  horizonDays?: number;
  business?: BusinessProfile;
  useLlm?: boolean;
}

/** The real scheduled job: drafts campaigns for relevant events in the next N (default 14) days. */
export function scanEventsHandler(env: Env, deps: AppDeps) {
  return async (ctx: JobContext) => {
    const p = (ctx.payload ?? {}) as ScanPayload;
    const horizon = Math.min(60, Math.max(1, Math.trunc(p.horizonDays ?? 14)));
    const business: BusinessProfile = p.business ?? { id: "default", name: "رایان", industry: "general" };
    const cal = await loadCalendar(env);
    const created: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const ev of cal.upcoming(ctx.now, horizon)) {
      if (ev.sensitivity === "mourning") {
        skipped.push({ id: ev.instanceId, reason: "mourning" });
        continue;
      }
      const { result } = await draftForEvent(env, deps, ev, business, { useLlm: !!p.useLlm, skipIrrelevant: true });
      if (result.created) created.push(result.id);
      else skipped.push({ id: ev.instanceId, reason: result.reason ?? "skipped" });
    }
    return { horizonDays: horizon, created, skipped };
  };
}

export function schedulerStore(env: Env) {
  return new D1SchedulerStore(d1(env));
}

export function autopilotScheduler(env: Env, deps: AppDeps) {
  return new Scheduler({
    store: schedulerStore(env),
    handlers: { [SCAN_EVENTS_HANDLER]: scanEventsHandler(env, deps) },
    defaultUtcOffsetMinutes: TEHRAN_OFFSET_MINUTES,
    maxJobsPerTick: 5,
    lockTtlMs: 5 * 60_000,
  });
}
