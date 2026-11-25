import type { Permission, Role } from "@rayan/shared";

/** Worker bindings. Non-secret vars live in wrangler.toml [vars]; secrets via `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  /** Workers AI binding. Optional so the app degrades gracefully (and tests run fully offline). */
  AI?: Ai;
  /** Email that is promoted to super_admin after a verified login. Set as a Wrangler secret, never in code. */
  OWNER_EMAIL?: string;
  /** Comma-separated list of exact origins allowed for CORS / state-changing requests. */
  ALLOWED_ORIGINS?: string;
  ENVIRONMENT?: string;
  AI_MODEL?: string;
  AI_DAILY_LIMIT?: string;
  RATE_LIMIT_API_PER_MIN?: string;
  RATE_LIMIT_AUTH_PER_MIN?: string;
  RATE_LIMIT_LOGIN_PER_EMAIL_15MIN?: string;
  RATE_LIMIT_CHAT_PER_MIN?: string;
  PBKDF2_ITERATIONS?: string;
  SESSION_TTL_HOURS?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  display_name: string | null;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  roles: Role[];
  permissions: Set<Permission>;
}

export type Variables = {
  auth: AuthContext | null;
  deps: import("./deps").AppDeps;
};

export type AppEnv = { Bindings: Env; Variables: Variables };

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
