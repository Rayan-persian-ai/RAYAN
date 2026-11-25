import type { TaskHandler } from "../deps";
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
};
