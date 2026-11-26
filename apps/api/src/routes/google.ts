/**
 * Sign in with Google (OAuth 2.0 code + PKCE) and the owner-only Gmail connection.
 *   GET  /api/auth/google/start        → 302 to Google (scopes: openid email profile)
 *   GET  /api/auth/google/callback     → session + 302 to /#/chat  (or /#/login?err=…)
 *   GET  /api/admin/gmail/connect      → owner only: 302 to Google with gmail.send, offline, consent
 *   GET  /api/admin/gmail/status       → {connected, sender, provider}
 *   POST /api/admin/gmail/disconnect   → removes the stored refresh token
 * Account linking: an existing user is linked only through Google's verified email; OWNER_EMAIL rule unchanged
 * (bootstrapOwner runs after the verified login, exactly as for password logins).
 */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { bootstrapOwner } from "../lib/bootstrap";
import { newId } from "../lib/crypto";
import { selectProvider } from "../lib/email";
import { ApiError, errorBody } from "../lib/errors";
import { createState, exchangeCode, googleConfigured, OAUTH_COOKIE, takeState } from "../lib/google";
import { deleteSecret, getSecret, putSecret } from "../lib/secretbox";
import { createSession } from "../lib/session";
import { authIpLimit, requireAuth } from "../middleware/auth";

export const googleRoutes = new Hono<AppEnv>();
export const gmailAdminRoutes = new Hono<AppEnv>();

const webBase = (c: Context<AppEnv>) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = new URL(c.req.url).origin;
  return allowed.includes(origin) ? origin : (allowed[0] ?? origin);
};
const back = (c: Context<AppEnv>, hash: string) => c.redirect(`${webBase(c)}/${hash}`, 302);
/** Final redirect of the callback: the one-time state cookie is cleared last (after any session cookie). */
const finish = (c: Context<AppEnv>, hash: string) => {
  deleteCookie(c, OAUTH_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  return back(c, hash);
};

function setStateCookie(c: Context<AppEnv>, state: string) {
  setCookie(c, OAUTH_COOKIE, state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
}

googleRoutes.get("/start", authIpLimit, async (c) => {
  if (!googleConfigured(c.env)) return back(c, "#/login?err=google_unavailable");
  const { state, url } = await createState(c, "login", null);
  setStateCookie(c, state);
  return c.redirect(url, 302);
});

googleRoutes.get("/callback", async (c) => {
  const q = c.req.query();
  const cookieState = getCookie(c, OAUTH_COOKIE);
  if (q.error) {
    // Consent screen in "Testing": Google refuses non-test users with access_denied.
    await audit(c, { actor: null, action: "auth.google.denied", metadata: { error: q.error.slice(0, 60) } });
    return finish(c, `#/login?err=${q.error === "access_denied" ? "google_denied" : "oauth_failed"}`);
  }
  if (!q.state || !q.code || !cookieState || cookieState !== q.state) return finish(c, "#/login?err=oauth_failed");
  const st = await takeState(c, q.state);
  if (!st || !googleConfigured(c.env)) return finish(c, "#/login?err=oauth_failed");
  let ex;
  try {
    ex = await exchangeCode(c, q.code, st);
  } catch (e) {
    console.error("google exchange", e);
    return finish(c, "#/login?err=oauth_failed");
  }
  const { claims } = ex;
  const email = claims.email?.trim().toLowerCase();
  if (!email || claims.email_verified !== true) return finish(c, "#/login?err=oauth_failed");
  const now = c.var.deps.now();

  if (st.purpose === "gmail") {
    // Owner-only: the account that consented must be OWNER_EMAIL and the request must come from the owner's session.
    const owner = c.env.OWNER_EMAIL?.trim().toLowerCase();
    const starter = st.user_id ? await c.env.DB.prepare("SELECT email FROM users WHERE id = ?1").bind(st.user_id).first<{ email: string }>() : null;
    if (!owner || email !== owner || starter?.email.toLowerCase() !== owner) return finish(c, "#/admin?gmail=wrong_account");
    if (!ex.refreshToken || !ex.scope.includes("gmail.send")) return finish(c, "#/admin?gmail=no_refresh_token");
    await putSecret(c.env, "gmail_refresh_token", ex.refreshToken, st.user_id, now);
    await putSecret(c.env, "gmail_sender", email, st.user_id, now);
    await audit(c, { actor: st.user_id, action: "gmail.connect", targetType: "app_secret", targetId: "gmail_refresh_token" });
    return finish(c, "#/admin?gmail=connected");
  }

  // purpose = login: find by google_sub, else link by verified email, else create
  let user = await c.env.DB.prepare("SELECT id, email, display_name, status FROM users WHERE google_sub = ?1")
    .bind(claims.sub)
    .first<{ id: string; email: string; display_name: string | null; status: string }>();
  if (!user) {
    user = await c.env.DB.prepare("SELECT id, email, display_name, status FROM users WHERE email = ?1")
      .bind(email)
      .first<{ id: string; email: string; display_name: string | null; status: string }>();
    if (user) {
      await c.env.DB.prepare("UPDATE users SET google_sub = ?1, email_verified_at = COALESCE(email_verified_at, ?2), updated_at = ?2 WHERE id = ?3")
        .bind(claims.sub, now, user.id)
        .run();
      await audit(c, { actor: user.id, action: "auth.google.link", targetType: "user", targetId: user.id });
    }
  }
  if (!user) {
    const id = newId();
    const name = (claims.name ?? "").slice(0, 80) || null;
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, display_name, google_sub, email_verified_at, created_at, updated_at) VALUES (?1, ?2, '!google', ?3, ?4, ?5, ?5, ?5)",
      ).bind(id, email, name, claims.sub, now),
      c.env.DB.prepare("INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?1, 'member', 'system:google', ?2)").bind(id, now),
    ]);
    user = { id, email, display_name: name, status: "active" };
    await audit(c, { actor: id, action: "auth.signup.google", targetType: "user", targetId: id });
  }
  if (user.status !== "active") return finish(c, "#/login?err=oauth_failed");
  await c.env.DB.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2").bind(now, user.id).run();
  await createSession(c, user.id);
  await audit(c, { actor: user.id, action: "auth.login.google", targetType: "user", targetId: user.id });
  await bootstrapOwner(c, user);
  return finish(c, "#/chat");
});

/** Owner only = signed in AND the account email equals OWNER_EMAIL (not just any super_admin). */
async function requireOwner(c: Context<AppEnv>) {
  const owner = c.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!c.var.auth || !owner || c.var.auth.user.email.toLowerCase() !== owner) throw new ApiError(403, "forbidden");
}

gmailAdminRoutes.get("/connect", requireAuth, async (c) => {
  await requireOwner(c);
  if (!googleConfigured(c.env)) throw new ApiError(503, "google_unavailable");
  const { state, url } = await createState(c, "gmail", c.var.auth!.user.id);
  setStateCookie(c, state);
  return c.redirect(url, 302);
});

gmailAdminRoutes.get("/status", requireAuth, async (c) => {
  await requireOwner(c);
  const provider = c.var.deps.email ?? selectProvider(c.env, c.var.deps.fetch);
  const stored = !!(await getSecret(c.env, "gmail_refresh_token"));
  return c.json({
    provider: provider.id,
    configured: await provider.configured(c.env),
    gmail_connected: stored || !!c.env.GMAIL_REFRESH_TOKEN,
    sender: await provider.from(c.env),
    google_client: googleConfigured(c.env),
  });
});

gmailAdminRoutes.post("/disconnect", requireAuth, async (c) => {
  await requireOwner(c);
  await deleteSecret(c.env, "gmail_refresh_token");
  await deleteSecret(c.env, "gmail_sender");
  await audit(c, { actor: c.var.auth!.user.id, action: "gmail.disconnect" });
  return c.json({ ok: true });
});

export { errorBody };
