/**
 * Cost Controller — hard daily caps per paid-capable service (Workers AI today).
 * Counters live in D1 `usage_counters` keyed by (service, UTC day). The per-service
 * default cap is the row with day = 'default' (editable by super_admin), else the env default.
 * Reservation is a single atomic upsert, so concurrent requests cannot overshoot the cap.
 */
import { intVar, type Env } from "../env";

export const AI_SERVICE = "workers_ai";

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export async function getDailyLimit(db: D1Database, service: string, envDefault: number): Promise<number> {
  const row = await db
    .prepare(`SELECT "limit" AS l FROM usage_counters WHERE service = ?1 AND day = 'default'`)
    .bind(service)
    .first<{ l: number }>();
  return row?.l ?? envDefault;
}

export function envAiLimit(env: Env): number {
  return intVar(env.AI_DAILY_LIMIT, 60);
}

export interface Reservation {
  allowed: boolean;
  count: number;
  limit: number;
  day: string;
}

export async function reserveUsage(db: D1Database, service: string, envDefault: number, nowMs: number): Promise<Reservation> {
  const day = utcDay(nowMs);
  const limit = await getDailyLimit(db, service, envDefault);
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (service, day, count, "limit", updated_at)
       SELECT ?1, ?2, 1, ?3, ?4 WHERE ?3 > 0
       ON CONFLICT(service, day) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
         WHERE usage_counters.count < usage_counters."limit"
       RETURNING count, "limit" AS l`,
    )
    .bind(service, day, limit, nowMs)
    .first<{ count: number; l: number }>();
  if (!row) {
    const cur = await getUsage(db, service, nowMs, envDefault);
    return { allowed: false, count: cur.count, limit: cur.limit, day };
  }
  return { allowed: true, count: row.count, limit: row.l, day };
}

export async function getUsage(db: D1Database, service: string, nowMs: number, envDefault: number) {
  const day = utcDay(nowMs);
  const row = await db
    .prepare(`SELECT count, "limit" AS l FROM usage_counters WHERE service = ?1 AND day = ?2`)
    .bind(service, day)
    .first<{ count: number; l: number }>();
  if (row) return { day, count: row.count, limit: row.l };
  return { day, count: 0, limit: await getDailyLimit(db, service, envDefault) };
}

/** Sets the default cap and also today's cap for the service. */
export async function setDailyLimit(db: D1Database, service: string, limit: number, nowMs: number) {
  const day = utcDay(nowMs);
  await db.batch([
    db
      .prepare(
        `INSERT INTO usage_counters (service, day, count, "limit", updated_at) VALUES (?1, 'default', 0, ?2, ?3)
         ON CONFLICT(service, day) DO UPDATE SET "limit" = excluded."limit", updated_at = excluded.updated_at`,
      )
      .bind(service, limit, nowMs),
    db
      .prepare(
        `INSERT INTO usage_counters (service, day, count, "limit", updated_at) VALUES (?1, ?2, 0, ?3, ?4)
         ON CONFLICT(service, day) DO UPDATE SET "limit" = excluded."limit", updated_at = excluded.updated_at`,
      )
      .bind(service, day, limit, nowMs),
  ]);
}
