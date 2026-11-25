/**
 * Minimal structural types for Cloudflare D1 so this package does not depend on
 * @cloudflare/workers-types. A real `D1Database` binding satisfies these.
 */
export interface D1ResultLike<T = unknown> {
  results?: T[];
  success?: boolean;
  meta?: { changes?: number; [k: string]: unknown };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export function changes(r: D1ResultLike): number {
  return Number(r.meta?.changes ?? 0);
}
