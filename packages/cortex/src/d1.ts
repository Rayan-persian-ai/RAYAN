/**
 * Minimal structural subset of Cloudflare's D1Database API, so this package does not depend on
 * @cloudflare/workers-types. A real `env.DB` binding satisfies it.
 */
export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success?: boolean;
  meta?: { changes?: number; [k: string]: unknown };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}
