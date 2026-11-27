import { Hono } from "hono";
import { prefsSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { parseJson } from "../lib/request";
import { requireAuth } from "../middleware/auth";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/", requireAuth, (c) => {
  const a = c.var.auth!;
  return c.json({ user: a.user, roles: a.roles, permissions: [...a.permissions].sort() });
});

/** Personalisation (old site: «شخصی‌سازی رایان» + profile prefs): name, answer style, about, theme. */
meRoutes.get("/prefs", requireAuth, async (c) => {
  const row = await c.env.DB.prepare("SELECT data FROM user_prefs WHERE user_id = ?1").bind(c.var.auth!.user.id).first<{ data: string }>();
  return c.json({ prefs: row ? JSON.parse(row.data) : {} });
});

meRoutes.put("/prefs", requireAuth, async (c) => {
  const prefs = await parseJson(c, prefsSchema);
  await c.env.DB.prepare(
    `INSERT INTO user_prefs (user_id, data, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(c.var.auth!.user.id, JSON.stringify(prefs), c.var.deps.now())
    .run();
  return c.json({ prefs });
});

/** «مصرف من»: own usage numbers for the settings page. */
meRoutes.get("/stats", requireAuth, async (c) => {
  const id = c.var.auth!.user.id;
  const r = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM conversations WHERE user_id = ?1) AS conversations,
            (SELECT COUNT(*) FROM messages WHERE user_id = ?1 AND role = 'user') AS messages,
            (SELECT COUNT(*) FROM messages WHERE user_id = ?1 AND role = 'assistant') AS answers,
            (SELECT COUNT(*) FROM messages WHERE user_id = ?1 AND rating IS NOT NULL) AS feedback,
            (SELECT created_at FROM users WHERE id = ?1) AS since`,
  )
    .bind(id)
    .first();
  return c.json({ stats: r });
});
