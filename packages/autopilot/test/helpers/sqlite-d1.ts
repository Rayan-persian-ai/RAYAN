/** Test adapter: exposes node:sqlite (Node >= 22.5) through the D1 prepared-statement API. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../../src/index.js";

const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

export function createSqliteD1(): D1DatabaseLike & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(fileURLToPath(new URL("../../sql/schema.sql", import.meta.url)), "utf8"));
  const prepare = (sql: string, params: unknown[] = []): D1PreparedStatementLike => ({
    bind: (...values: unknown[]) => prepare(sql, values.map(norm)),
    first: async <T>() => ((raw.prepare(sql).get(...(params as never[])) as T | undefined) ?? null),
    all: async <T>() => ({ results: raw.prepare(sql).all(...(params as never[])) as T[], success: true }),
    run: async () => {
      const r = raw.prepare(sql).run(...(params as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return { prepare: (sql: string) => prepare(sql), raw };
}
