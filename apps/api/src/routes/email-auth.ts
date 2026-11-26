/**
 * Email codes (only when an email provider is configured — see /api/health auth.email_codes):
 *   POST /api/auth/email/send-code {email, purpose: verify|login|reset}  → always 200 (no account enumeration)
 *   POST /api/auth/email/verify    {email, code}                         → marks verified + signs in
 *   POST /api/auth/email/login     {email, code}                         → passwordless sign-in
 *   POST /api/auth/password/reset  {email, code, password}               → new password, all sessions revoked
 */
import { Hono, type Context } from "hono";
import { resetPasswordSchema, sendCodeSchema, verifyCodeSchema } from "@rayan/shared";
import { intVar, type AppEnv } from "../env";
import { audit } from "../lib/audit";
import { bootstrapOwner } from "../lib/bootstrap";
import { checkCode, codeEmail, issueCode, type CodePurpose } from "../lib/codes";
import { hashPassword, sha256Hex } from "../lib/crypto";
import { EmailCapReached, selectProvider, sendEmail } from "../lib/email";
import { ApiError, errorBody } from "../lib/errors";
import { hitRateLimit } from "../lib/ratelimit";
import { parseJson } from "../lib/request";
import { createSession } from "../lib/session";
import { authIpLimit } from "../middleware/auth";

export const emailAuthRoutes = new Hono<AppEnv>();

export const emailProviderOf = (c: Context<AppEnv>) => c.var.deps.email ?? selectProvider(c.env, c.var.deps.fetch);

type UserRow = { id: string; email: string; display_name: string | null; status: string; email_verified_at: number | null };
const findUser = (c: Context<AppEnv>, email: string) =>
  c.env.DB.prepare("SELECT id, email, display_name, status, email_verified_at FROM users WHERE email = ?1").bind(email).first<UserRow>();

/** Sends a code; returns false when the provider is not configured. Caller decides how to answer. */
export async function sendCode(c: Context<AppEnv>, email: string, purpose: CodePurpose, userId: string | null): Promise<boolean> {
  const provider = emailProviderOf(c);
  if (!(await provider.configured(c.env))) return false;
  const now = c.var.deps.now();
  const code = await issueCode(c.env, email, purpose, now);
  const m = codeEmail(purpose, code);
  await sendEmail(c.env, provider, { to: email, ...m }, { kind: `code.${purpose}`, userId, now });
  return true;
}

async function perEmailLimit(c: Context<AppEnv>, email: string, kind: string, limit: number) {
  const k = await sha256Hex(email);
  const r = await hitRateLimit(c.env.DB, `${kind}:${k}`, limit, 900, c.var.deps.now());
  if (!r.allowed) {
    c.header("Retry-After", String(r.retryAfterSec));
    throw new ApiError(429, "rate_limited");
  }
}

emailAuthRoutes.post("/email/send-code", authIpLimit, async (c) => {
  const { email, purpose } = await parseJson(c, sendCodeSchema);
  const provider = emailProviderOf(c);
  if (!(await provider.configured(c.env))) throw new ApiError(503, "email_unavailable");
  await perEmailLimit(c, email, "code-send", 3); // 3 codes / 15 min / email
  const user = await findUser(c, email);
  const eligible = !!user && user.status === "active" && (purpose !== "verify" || !user.email_verified_at);
  if (eligible) {
    try {
      await sendCode(c, email, purpose, user!.id);
    } catch (e) {
      if (e instanceof EmailCapReached) throw new ApiError(429, "rate_limited");
      console.error("send code failed", e);
      throw new ApiError(502, "email_unavailable");
    }
  }
  await audit(c, { actor: user?.id ?? null, action: `auth.code.${purpose}`, metadata: { sent: eligible } });
  return c.json({ ok: true, message: "اگر حسابی با این ایمیل وجود داشته باشد، کد به آن ارسال شد." });
});

async function signIn(c: Context<AppEnv>, user: UserRow, how: string) {
  const now = c.var.deps.now();
  await c.env.DB.prepare("UPDATE users SET last_login_at = ?1, email_verified_at = COALESCE(email_verified_at, ?1) WHERE id = ?2").bind(now, user.id).run();
  await createSession(c, user.id);
  await audit(c, { actor: user.id, action: `auth.login.${how}`, targetType: "user", targetId: user.id });
  await bootstrapOwner(c, user);
  return c.json({ user: { id: user.id, email: user.email, display_name: user.display_name } });
}

async function verifyWith(c: Context<AppEnv>, purpose: CodePurpose, email: string, code: string) {
  await perEmailLimit(c, email, `code-check-${purpose}`, intVar(c.env.RATE_LIMIT_LOGIN_PER_EMAIL_15MIN, 10));
  const user = await findUser(c, email);
  const ok = await checkCode(c.env, email, purpose, code, c.var.deps.now());
  if (!ok || !user || user.status !== "active") {
    await audit(c, { actor: user?.id ?? null, action: `auth.code.${purpose}.failure` });
    throw new ApiError(400, "invalid_code");
  }
  return user;
}

emailAuthRoutes.post("/email/verify", authIpLimit, async (c) => {
  const { email, code } = await parseJson(c, verifyCodeSchema);
  const user = await verifyWith(c, "verify", email, code);
  return signIn(c, user, "verify");
});

emailAuthRoutes.post("/email/login", authIpLimit, async (c) => {
  const { email, code } = await parseJson(c, verifyCodeSchema);
  const user = await verifyWith(c, "login", email, code);
  return signIn(c, user, "code");
});

emailAuthRoutes.post("/password/reset", authIpLimit, async (c) => {
  const { email, code, password } = await parseJson(c, resetPasswordSchema);
  const user = await verifyWith(c, "reset", email, code);
  const hash = await hashPassword(password, intVar(c.env.PBKDF2_ITERATIONS, 100_000));
  const now = c.var.deps.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?1, updated_at = ?2, email_verified_at = COALESCE(email_verified_at, ?2) WHERE id = ?3").bind(hash, now, user.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
  ]);
  await audit(c, { actor: user.id, action: "auth.password.reset", targetType: "user", targetId: user.id });
  return c.json({ ok: true });
});

export { errorBody };
