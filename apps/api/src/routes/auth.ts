import { Hono } from "hono";
import { loginSchema, signupSchema } from "@rayan/shared";
import { intVar, type AppEnv } from "../env";
import { audit } from "../lib/audit";
import { DUMMY_HASH, hashPassword, newId, sha256Hex, verifyPassword } from "../lib/crypto";
import { ApiError, errorBody } from "../lib/errors";
import { isFlagEnabled } from "../lib/flags";
import { hitRateLimit } from "../lib/ratelimit";
import { parseJson } from "../lib/request";
import { createSession, destroySession } from "../lib/session";
import { authIpLimit, requireAuth } from "../middleware/auth";
import { bootstrapOwner } from "../lib/bootstrap";

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/signup", authIpLimit, async (c) => {
  const input = await parseJson(c, signupSchema);
  if (!(await isFlagEnabled(c.env.DB, "signup_enabled", true))) throw new ApiError(403, "signup_disabled");

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(input.email).first();
  if (existing) throw new ApiError(409, "email_taken");

  const now = c.var.deps.now();
  const id = newId();
  const hash = await hashPassword(input.password, intVar(c.env.PBKDF2_ITERATIONS, 100_000));
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      ).bind(id, input.email, hash, input.display_name ?? null, now),
      c.env.DB.prepare(
        `INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?1, 'member', 'system:signup', ?2)`,
      ).bind(id, now),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ApiError(409, "email_taken");
    throw e;
  }
  await audit(c, { actor: id, action: "auth.signup", targetType: "user", targetId: id });
  // No session here on purpose: the account is used only after a verified login (which also runs the owner bootstrap).
  return c.json({ user: { id, email: input.email, display_name: input.display_name ?? null } }, 201);
});

authRoutes.post("/login", authIpLimit, async (c) => {
  const input = await parseJson(c, loginSchema);
  const now = c.var.deps.now();

  // Per-account brute-force guard (in addition to the per-IP limit).
  const emailKey = await sha256Hex(input.email);
  const rl = await hitRateLimit(
    c.env.DB,
    `login-email:${emailKey}`,
    intVar(c.env.RATE_LIMIT_LOGIN_PER_EMAIL_15MIN, 10),
    900,
    now,
  );
  if (!rl.allowed) {
    c.header("Retry-After", String(rl.retryAfterSec));
    return c.json(errorBody("rate_limited"), 429);
  }

  const user = await c.env.DB.prepare(
    "SELECT id, email, display_name, password_hash, status FROM users WHERE email = ?1",
  )
    .bind(input.email)
    .first<{ id: string; email: string; display_name: string | null; password_hash: string; status: string }>();

  const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || user.status !== "active") {
    await audit(c, {
      actor: user?.id ?? null,
      action: "auth.login.failure",
      targetType: "user",
      targetId: user?.id,
      metadata: { reason: !user ? "unknown_email" : !ok ? "bad_password" : "disabled" },
    });
    throw new ApiError(401, "invalid_credentials");
  }

  await c.env.DB.prepare("UPDATE users SET last_login_at = ?1 WHERE id = ?2").bind(now, user.id).run();
  await createSession(c, user.id);
  await audit(c, { actor: user.id, action: "auth.login.success", targetType: "user", targetId: user.id });
  await bootstrapOwner(c, user);
  return c.json({ user: { id: user.id, email: user.email, display_name: user.display_name } });
});

authRoutes.post("/logout", requireAuth, async (c) => {
  const uid = c.var.auth!.user.id;
  await destroySession(c);
  await audit(c, { actor: uid, action: "auth.logout", targetType: "user", targetId: uid });
  return c.json({ ok: true });
});
