import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Permission, Role } from "@rayan/shared";
import { intVar, type AppEnv, type AuthContext } from "../env";
import { randomToken, sha256Hex } from "./crypto";
import { clientIp, userAgent } from "./request";

/** __Host- prefix: Secure, Path=/, no Domain — the cookie can't be set or scoped by subdomains. */
export const SESSION_COOKIE = "__Host-rayan_sid";

export async function createSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = c.var.deps.now();
  const ttlHours = intVar(c.env.SESSION_TTL_HOURS, 168);
  const expires = now + ttlHours * 3600_000;
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, userId, now, expires, clientIp(c), userAgent(c))
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: ttlHours * 3600,
  });
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const auth = c.var.auth;
  if (auth) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(auth.sessionId).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
}

/** Resolves the session cookie to an AuthContext (user + roles + effective permissions), or null. */
export async function loadAuth(c: Context<AppEnv>): Promise<AuthContext | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const id = await sha256Hex(token);
  const now = c.var.deps.now();
  const row = await c.env.DB.prepare(
    `SELECT s.id AS sid, s.expires_at, u.id, u.email, u.display_name, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?1`,
  )
    .bind(id)
    .first<{ sid: string; expires_at: number; id: string; email: string; display_name: string | null; status: string }>();
  if (!row || row.expires_at <= now || row.status !== "active") return null;
  const { roles, permissions } = await loadRolesAndPermissions(c.env.DB, row.id);
  return {
    user: { id: row.id, email: row.email, display_name: row.display_name },
    sessionId: row.sid,
    roles,
    permissions,
  };
}

export async function loadRolesAndPermissions(db: D1Database, userId: string) {
  const [roleRows, permRows] = await db.batch<{ role?: string; permission?: string }>([
    db.prepare("SELECT role FROM user_roles WHERE user_id = ?1 ORDER BY role").bind(userId),
    db
      .prepare(
        `SELECT DISTINCT rp.permission FROM user_roles ur
           JOIN role_permissions rp ON rp.role = ur.role WHERE ur.user_id = ?1`,
      )
      .bind(userId),
  ]);
  const roles = (roleRows?.results ?? []).map((r) => r.role as Role);
  const permissions = new Set((permRows?.results ?? []).map((r) => r.permission as Permission));
  return { roles, permissions };
}
