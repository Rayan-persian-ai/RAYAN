import { z } from "zod";

/** Scopes an agent may be granted. Phase 1 only records them; enforcement comes with agent execution (phase 2+). */
export const AGENT_SCOPES = [
  "ai:chat",
  "tasks:create",
  "tasks:read",
  "repo:read",
  "repo:write",
  "ci:read",
  "ci:run",
  "db:read",
  "db:migrate",
  "web:research",
  "content:write",
  "media:generate",
  "analytics:read",
  "finance:read",
  "crm:read",
  "support:reply",
  "security:scan",
  "agents:delegate",
  "hr:read",
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const agentManifestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).max(64),
  name_fa: z.string().min(1).max(80),
  name_en: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  permissions: z.array(z.enum(AGENT_SCOPES)).min(1),
  enabled: z.boolean(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;
