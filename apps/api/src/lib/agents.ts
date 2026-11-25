import { AGENT_MANIFESTS } from "@rayan/shared";

export interface AgentRow {
  slug: string;
  name_fa: string;
  name_en: string;
  description: string;
  permissions: string;
  enabled: number;
  version: string;
  updated_at: number;
}

export function serializeAgent(r: AgentRow) {
  return { ...r, permissions: JSON.parse(r.permissions) as string[], enabled: r.enabled === 1 };
}

/** Upserts bundled manifests into the registry. Metadata is refreshed; the admin's enabled choice is preserved. */
export async function syncAgents(db: D1Database, now: number): Promise<number> {
  const stmts = AGENT_MANIFESTS.map((m) =>
    db
      .prepare(
        `INSERT INTO agents (slug, name_fa, name_en, description, permissions, enabled, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(slug) DO UPDATE SET name_fa = excluded.name_fa, name_en = excluded.name_en,
           description = excluded.description, permissions = excluded.permissions,
           version = excluded.version, updated_at = excluded.updated_at`,
      )
      .bind(m.slug, m.name_fa, m.name_en, m.description, JSON.stringify(m.permissions), m.enabled ? 1 : 0, m.version, now),
  );
  await db.batch(stmts);
  return stmts.length;
}
