/** Fixed-window rate limiter persisted in D1 (`rate_limits`). One upsert per check. */
export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSec: number;
}

export async function hitRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSec: number,
  nowMs: number,
): Promise<RateLimitResult> {
  const nowSec = Math.floor(nowMs / 1000);
  const windowStart = nowSec - (nowSec % windowSec);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= limit, count, limit, retryAfterSec: windowStart + windowSec - nowSec };
}
