import { Hono } from "hono";
import { agentToggleSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { serializeAgent, syncAgents, type AgentRow } from "../lib/agents";
import { audit } from "../lib/audit";
import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/request";
import { requirePermission } from "../middleware/auth";

export const agentRoutes = new Hono<AppEnv>();

agentRoutes.get("/", requirePermission("agents:read"), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT slug, name_fa, name_en, description, permissions, enabled, version, updated_at FROM agents ORDER BY slug",
  ).all<AgentRow>();
  return c.json({ agents: results.map(serializeAgent) });
});

agentRoutes.patch("/:slug", requirePermission("agents:manage"), async (c) => {
  const slug = c.req.param("slug");
  const { enabled } = await parseJson(c, agentToggleSchema);
  const row = await c.env.DB.prepare(
    `UPDATE agents SET enabled = ?1, updated_at = ?2 WHERE slug = ?3
     RETURNING slug, name_fa, name_en, description, permissions, enabled, version, updated_at`,
  )
    .bind(enabled ? 1 : 0, c.var.deps.now(), slug)
    .first<AgentRow>();
  if (!row) throw new ApiError(404, "not_found");
  await audit(c, {
    actor: c.var.auth!.user.id,
    action: enabled ? "admin.agent.enable" : "admin.agent.disable",
    targetType: "agent",
    targetId: slug,
  });
  return c.json({ agent: serializeAgent(row) });
});

agentRoutes.post("/sync", requirePermission("agents:manage"), async (c) => {
  const n = await syncAgents(c.env.DB, c.var.deps.now());
  await audit(c, { actor: c.var.auth!.user.id, action: "admin.agents.sync", metadata: { count: n } });
  return c.json({ synced: n });
});
