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
  /** Google OAuth client (Worker secrets) — used for "Sign in with Google" and the owner's Gmail connection. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional: Gmail refresh token as a secret (else the one stored encrypted in D1 by /api/admin/gmail/connect). */
  GMAIL_REFRESH_TOKEN?: string;
  /** From-address for outgoing mail (var). Gmail sends as the connected account. */
  SENDER_EMAIL?: string;
  /** gmail (default) | brevo | resend | log. */
  EMAIL_PROVIDER?: string;
  BREVO_API_KEY?: string;
  RESEND_API_KEY?: string;
  /** Daily cap for outgoing email (Gmail allows ~500/day for consumer accounts). */
  EMAIL_DAILY_LIMIT?: string;
  /** Secret used to encrypt app_secrets rows and to key email-code HMACs (falls back to GOOGLE_CLIENT_SECRET). */
  DATA_ENC_KEY?: string;
  /** One-time token that enables /api/admin/provision/google (delete the secret after use). */
  PROVISION_TOKEN?: string;
  /** Google AI Studio free key (secret) — else the encrypted D1 copy from /api/admin/provision/gemini. */
  GEMINI_API_KEY?: string;
  /** csv: Gemini models tried in order (default gemini-3.5-flash, gemini-3.8-flash, gemini-3.5-flash-lite). */
  GEMINI_MODELS?: string;
  GEMINI_DAILY_LIMIT?: string;
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
