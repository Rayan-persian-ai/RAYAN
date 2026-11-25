import { Hono } from "hono";
import type { AppEnv } from "../env";
import { AI_SERVICE, envAiLimit, getUsage } from "../lib/cost";
import { isFlagEnabled } from "../lib/flags";

/** Cron fires every 15 min; allow two missed runs plus slack before calling the scheduler stale. */
export const SCHEDULER_STALE_MS = 35 * 60_000;

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/", async (c) => {
  const now = c.var.deps.now();
  let dbOk = false;
  try {
    dbOk = (await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>())?.ok === 1;
  } catch {
    dbOk = false;
  }

  let ai: Record<string, unknown> = { status: "unknown" };
  let scheduler: Record<string, unknown> = { status: "unknown" };
  if (dbOk) {
    const enabled = await isFlagEnabled(c.env.DB, "ai_enabled", true);
    const usage = await getUsage(c.env.DB, AI_SERVICE, now, envAiLimit(c.env));
    const available = c.var.deps.ai.isAvailable(c.env);
    ai = {
      status: !available ? "unconfigured" : !enabled ? "disabled" : usage.count >= usage.limit ? "capped" : "ok",
      provider: c.var.deps.ai.name,
      used_today: usage.count,
      daily_limit: usage.limit,
    };
    const hb = await c.env.DB.prepare("SELECT last_run_at, last_status FROM scheduled_jobs WHERE name = 'heartbeat'").first<{
      last_run_at: number | null;
      last_status: string | null;
    }>();
    if (hb?.last_run_at) {
      const age = now - hb.last_run_at;
      scheduler = {
        status: age <= SCHEDULER_STALE_MS && hb.last_status === "ok" ? "ok" : "stale",
        last_heartbeat_at: hb.last_run_at,
        age_seconds: Math.round(age / 1000),
      };
    } else {
      scheduler = { status: "never_run" };
    }
  }

  const status = !dbOk ? "down" : ai.status === "ok" && scheduler.status === "ok" ? "ok" : "degraded";
  return c.json({ status, db: { status: dbOk ? "ok" : "down" }, ai, scheduler, time: now }, dbOk ? 200 : 503);
});
