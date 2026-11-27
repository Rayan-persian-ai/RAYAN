/** Google OAuth 2.0 (authorization code + PKCE + nonce), server-side in the Worker. */
import type { Context } from "hono";
import type { AppEnv, Env } from "../env";
import { b64url, fromB64url, randomToken, sha256Hex } from "./crypto";

export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const CALLBACK_PATH = "/api/auth/google/callback";
export const OAUTH_COOKIE = "__Host-rayan_oauth";
const STATE_TTL_MS = 10 * 60_000;

export const googleConfigured = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/** Redirect URI on the origin the browser used, when that origin is ours (pages.dev or workers.dev). */
export function redirectUri(c: Context<AppEnv>): string {
  const origin = new URL(c.req.url).origin;
  const allowed = (c.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^https:\/\/rayan-api\.[a-z0-9-]+\.workers\.dev$/.test(origin) || c.env.ENVIRONMENT === "test";
  return (ok ? origin : allowed[0] ?? origin) + CALLBACK_PATH;
}

export async function pkcePair() {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

export async function createState(
  c: Context<AppEnv>,
  purpose: "login" | "gmail",
  userId: string | null,
): Promise<{ state: string; url: string }> {
  const state = randomToken(32);
  const nonce = randomToken(16);
  const { verifier, challenge } = await pkcePair();
  const now = c.var.deps.now();
  const redirect = redirectUri(c);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?1").bind(now),
    c.env.DB.prepare(
      "INSERT INTO oauth_states (id, purpose, verifier, nonce, user_id, redirect_uri, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).bind(await sha256Hex(state), purpose, verifier, nonce, userId, redirect, now, now + STATE_TTL_MS),
  ]);
  const p = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirect,
    response_type: "code",
    scope: purpose === "gmail" ? `openid email ${GMAIL_SCOPE}` : "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (purpose === "gmail") {
    p.set("access_type", "offline");
    p.set("prompt", "consent");
    if (c.env.OWNER_EMAIL) p.set("login_hint", c.env.OWNER_EMAIL);
  } else p.set("prompt", "select_account");
  return { state, url: `${GOOGLE_AUTH}?${p}` };
}

/** Consumes a state exactly once. */
export async function takeState(c: Context<AppEnv>, state: string) {
  const id = await sha256Hex(state);
  const row = await c.env.DB.prepare("DELETE FROM oauth_states WHERE id = ?1 RETURNING purpose, verifier, nonce, user_id, redirect_uri, expires_at")
    .bind(id)
    .first<{ purpose: "login" | "gmail"; verifier: string; nonce: string; user_id: string | null; redirect_uri: string; expires_at: number }>();
  if (!row || row.expires_at < c.var.deps.now()) return null;
  return row;
}

export interface IdClaims {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nonce?: string;
  exp: number;
}

/**
 * Exchanges the code (with the PKCE verifier) at Google's token endpoint. The ID token comes straight
 * from Google over TLS in this back-channel response, so per OIDC Core §3.1.3.7 its claims are validated
 * (iss, aud, exp, nonce) without fetching signing keys.
 */
export async function exchangeCode(
  c: Context<AppEnv>,
  code: string,
  st: { verifier: string; nonce: string; redirect_uri: string },
): Promise<{ claims: IdClaims; refreshToken: string | null; scope: string }> {
  const f = c.var.deps.fetch ?? fetch;
  const r = await f(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: st.redirect_uri,
      grant_type: "authorization_code",
      code_verifier: st.verifier,
    }),
  });
  const j = (await r.json().catch(() => ({}))) as { id_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!r.ok || !j.id_token) throw new Error(`token exchange failed: ${j.error ?? r.status}`);
  const parts = j.id_token.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as IdClaims;
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("bad iss");
  if (claims.aud !== c.env.GOOGLE_CLIENT_ID) throw new Error("bad aud");
  if (!claims.exp || claims.exp * 1000 < c.var.deps.now() - 60_000) throw new Error("expired id_token");
  if (claims.nonce !== st.nonce) throw new Error("bad nonce");
  return { claims, refreshToken: j.refresh_token ?? null, scope: j.scope ?? "" };
}
