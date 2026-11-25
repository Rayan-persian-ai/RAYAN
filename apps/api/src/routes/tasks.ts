import { Hono, type Context } from "hono";
import { cortexRunSchema, TASK_STATUSES, taskCreateSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { newId } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/request";
import { serializeTask, TASK_COLUMNS, type TaskRow } from "../lib/tasks";
import { requireAuth, requirePermission } from "../middleware/auth";

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.post("/", requirePermission("tasks:create"), async (c) => {
  const input = await parseJson(c, taskCreateSchema);
  if (!c.var.deps.taskHandlers[input.type]) {
    throw new ApiError(400, "invalid_input", { type: `unknown task type '${input.type}'` });
  }
  if (input.type === "cortex.run") {
    if (!c.var.auth!.permissions.has("cortex:run")) throw new ApiError(403, "forbidden");
    const p = cortexRunSchema.safeParse(input.payload);
    if (!p.success) throw new ApiError(400, "invalid_input", p.error.issues.map((i) => ({ path: `payload.${i.path.join(".")}`, message: i.message })));
    input.payload = p.data as Record<string, unknown>;
  }
  if (input.agent_slug) {
    const agent = await c.env.DB.prepare("SELECT enabled FROM agents WHERE slug = ?1")
      .bind(input.agent_slug)
      .first<{ enabled: number }>();
    if (!agent) throw new ApiError(400, "invalid_input", { agent_slug: "unknown agent" });
    if (agent.enabled !== 1) throw new ApiError(409, "conflict", { agent_slug: "agent is disabled" });
  }
  const now = c.var.deps.now();
  const id = newId();
  const row = await c.env.DB.prepare(
    `INSERT INTO tasks (id, type, status, payload, max_attempts, agent_slug, created_by, created_at, updated_at, next_run_at)
     VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?7, ?7) RETURNING ${TASK_COLUMNS}`,
  )
    .bind(id, input.type, JSON.stringify(input.payload), input.max_attempts, input.agent_slug ?? null, c.var.auth!.user.id, now)
    .first<TaskRow>();
  return c.json({ task: serializeTask(row!) }, 201);
});

taskRoutes.get("/", requireAuth, async (c) => {
  const auth = c.var.auth!;
  const scopeAll = c.req.query("scope") === "all";
  if (scopeAll && !auth.permissions.has("tasks:read:all")) throw new ApiError(403, "forbidden");
  if (!scopeAll && !auth.permissions.has("tasks:read:own")) throw new ApiError(403, "forbidden");
  const status = c.req.query("status");
  if (status && !(TASK_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "invalid_input");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!scopeAll) {
    binds.push(auth.user.id);
    where.push(`created_by = ?${binds.length}`);
  }
  if (status) {
    binds.push(status);
    where.push(`status = ?${binds.length}`);
  }
  binds.push(limit);
  const sql = `SELECT ${TASK_COLUMNS} FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC LIMIT ?${binds.length}`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<TaskRow>();
  return c.json({ tasks: results.map(serializeTask) });
});

async function loadVisibleTask(c: Context<AppEnv>, kind: "read" | "cancel") {
  const auth = c.var.auth!;
  const task = await c.env.DB.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?1`)
    .bind(c.req.param("id"))
    .first<TaskRow>();
  const own = task?.created_by === auth.user.id;
  const allowed = own ? auth.permissions.has(`tasks:${kind}:own`) || auth.permissions.has(`tasks:${kind}:all`) : auth.permissions.has(`tasks:${kind}:all`);
  // Hide existence of other users' tasks from callers who can't see them.
  if (!task || (!own && !auth.permissions.has("tasks:read:all"))) throw new ApiError(404, "not_found");
  if (!allowed) throw new ApiError(403, "forbidden");
  return task;
}

taskRoutes.get("/:id", requireAuth, async (c) => {
  const task = await loadVisibleTask(c, "read");
  return c.json({ task: serializeTask(task) });
});

taskRoutes.post("/:id/cancel", requireAuth, async (c) => {
  const task = await loadVisibleTask(c, "cancel");
  const now = c.var.deps.now();
  const row = await c.env.DB.prepare(
    `UPDATE tasks SET status = 'cancelled', finished_at = ?1, updated_at = ?1, locked_until = NULL
     WHERE id = ?2 AND status IN ('pending', 'running') RETURNING ${TASK_COLUMNS}`,
  )
    .bind(now, task.id)
    .first<TaskRow>();
  if (!row) throw new ApiError(409, "conflict", { status: task.status });
  await audit(c, { actor: c.var.auth!.user.id, action: "task.cancel", targetType: "task", targetId: task.id });
  return c.json({ task: serializeTask(row) });
});
