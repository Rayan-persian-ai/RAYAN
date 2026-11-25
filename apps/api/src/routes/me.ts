import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../middleware/auth";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/", requireAuth, (c) => {
  const a = c.var.auth!;
  return c.json({ user: a.user, roles: a.roles, permissions: [...a.permissions].sort() });
});
