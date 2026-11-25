import type { Context } from "hono";
import type { AppEnv } from "../env";
import { audit } from "./audit";

/**
 * Super Admin bootstrap. The ONLY way super_admin is ever granted:
 * after a successful, password-verified login, if the account email equals the
 * server-side OWNER_EMAIL (Wrangler secret/var), the account is promoted.
 * Nothing in the request can influence this beyond proving the password.
 */
export async function bootstrapOwner(c: Context<AppEnv>, user: { id: string; email: string }): Promise<boolean> {
  const owner = c.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!owner || user.email.toLowerCase() !== owner) return false;
  const res = await c.env.DB.prepare(
    `INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?1, 'super_admin', 'system:bootstrap', ?2)
     ON CONFLICT(user_id, role) DO NOTHING`,
  )
    .bind(user.id, c.var.deps.now())
    .run();
  if (res.meta.changes > 0) {
    await audit(c, { actor: user.id, action: "auth.bootstrap.super_admin", targetType: "user", targetId: user.id });
    return true;
  }
  return false;
}
