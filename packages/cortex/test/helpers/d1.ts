/**
 * Test-only D1 shim backed by node:sqlite, so the real SQL in src/ and sql/schema.sql is exercised.
 * (Node-only; never imported by src/.)
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../../src/d1.js';

export function createTestD1(): D1DatabaseLike & { raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string, params: unknown[] = []): D1PreparedStatementLike => {
    const norm = () => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as never[];
    return {
      bind: (...values: unknown[]) => prepare(sql, values),
      first: async <T,>(col?: string) => {
        const row = db.prepare(sql).get(...norm()) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (col ? row[col] : { ...row }) as T;
      },
      all: async <T,>() => ({ results: (db.prepare(sql).all(...norm()) as Record<string, unknown>[]).map((r) => ({ ...r })) as T[], success: true }),
      run: async <T,>() => {
        const r = db.prepare(sql).run(...norm());
        return { results: [] as T[], success: true, meta: { changes: Number(r.changes) } };
      },
    };
  };
  return { prepare: (sql: string) => prepare(sql), raw: db };
}
