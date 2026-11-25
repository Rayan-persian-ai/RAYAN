import type { Context } from "hono";
import type { AppEnv } from "../env";
import { clientIp, userAgent } from "./request";

export interface AuditEntry {
  actor: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export async function writeAudit(db: D1Database, entry: AuditEntry & { ip?: string | null; ua?: string | null; now: number }) {
  await db
    .prepare(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, ip, user_agent, metadata, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      entry.actor,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.ip ?? null,
      entry.ua ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.now,
    )
    .run();
}

/** Audit from a request context (captures IP and user agent). */
export function audit(c: Context<AppEnv>, entry: AuditEntry) {
  return writeAudit(c.env.DB, { ...entry, ip: clientIp(c), ua: userAgent(c), now: c.var.deps.now() });
}
