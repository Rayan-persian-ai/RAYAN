import { cortexRunSchema, ROLES, type Role } from "@rayan/shared";
import type { TaskHandler } from "../deps";
import { runCortex, summarizeReport } from "../lib/cortex";
import { guardedChat } from "../lib/ai-guard";
import { ApiError } from "../lib/errors";
import { NonRetryableError } from "../lib/tasks";

/** Built-in task types for phase 1. Agents plug in more handlers in later phases. */
export const defaultTaskHandlers: Record<string, TaskHandler> = {
  /** Returns its payload — a safe smoke test for the whole queue/cron pipeline. */
  echo: async ({ task }) => ({ echo: task.payload }),

  /** One-shot prompt through the same guarded (cost-capped) AI path as /api/chat. */
  "ai.prompt": async ({ env, deps, task }) => {
    const prompt = task.payload.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
      throw new NonRetryableError("payload.prompt must be a non-empty string (max 4000 chars)");
    }
    try {
      const out = await guardedChat(env, deps, [{ role: "user", content: prompt }]);
      return { reply: out.reply };
    } catch (e) {
      // Disabled AI will not fix itself within the retry window; a cap might (new UTC day), so it stays retryable.
      if (e instanceof ApiError && e.code === "ai_disabled") throw new NonRetryableError(e.message);
      throw e;
    }
  },

  /**
   * Queued Cortex run (same pipeline as POST /api/cortex/run), executed as the task's creator with their
   * CURRENT roles/permissions. Guarded/restricted tool calls end the task as succeeded with
   * result.status = 'awaiting_approval' and approval ids; approve them and enqueue/re-run the goal.
   */
  "cortex.run": async ({ env, deps, task }) => {
    const parsed = cortexRunSchema.safeParse(task.payload);
    if (!parsed.success) throw new NonRetryableError("payload.goal must be a string of 2..2000 chars");
    if (!task.created_by) throw new NonRetryableError("cortex.run needs a creating user");
    const { results } = await env.DB.prepare(
      `SELECT ur.role AS role, EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = ur.role AND rp.permission = 'cortex:run') AS can
       FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.user_id = ?1 AND u.status = 'active'`,
    )
      .bind(task.created_by)
      .all<{ role: string; can: number }>();
    const roles = results.map((r) => r.role).filter((r): r is Role => (ROLES as readonly string[]).includes(r));
    if (!results.some((r) => r.can === 1)) throw new NonRetryableError("creator is not allowed to run cortex (cortex:run)");
    try {
      const out = await runCortex(env, deps, { id: task.created_by, roles }, parsed.data.goal, {
        toolInputs: parsed.data.tool_inputs,
        taskRef: task.id,
        runtime: deps.cortexRuntime,
      });
      // A cap hit mid-run is retryable on a later cron run (new UTC day); anything else is a final result.
      if (out.capReached && out.report.status === "failed") throw new Error("daily AI cap reached during cortex run");
      return { ...summarizeReport(out.report), approvals: out.approvals.map((a) => ({ id: a.id, action: a.action, level: a.level })) };
    } catch (e) {
      if (e instanceof ApiError && e.code === "ai_disabled") throw new NonRetryableError(e.message);
      throw e;
    }
  },
};
