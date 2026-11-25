import type { AppDeps, ChatTurn } from "../deps";
import type { Env } from "../env";
import { withSystemPrompt } from "./ai";
import { AI_SERVICE, envAiLimit, reserveUsage } from "./cost";
import { ApiError } from "./errors";
import { isFlagEnabled } from "./flags";

/** Every AI call in the system goes through here: kill switch -> cost cap -> provider. */
export async function guardedChat(env: Env, deps: AppDeps, messages: ChatTurn[]) {
  if (!(await isFlagEnabled(env.DB, "ai_enabled", true)) || !deps.ai.isAvailable(env)) {
    throw new ApiError(503, "ai_disabled");
  }
  const r = await reserveUsage(env.DB, AI_SERVICE, envAiLimit(env), deps.now());
  if (!r.allowed) throw new ApiError(429, "daily_cap_reached", { used: r.count, limit: r.limit, day: r.day });
  let reply: string;
  try {
    reply = await deps.ai.chat(env, withSystemPrompt(messages));
  } catch (e) {
    console.error("ai provider error", e);
    throw new ApiError(502, "ai_error");
  }
  return { reply, usage: { used: r.count, limit: r.limit, day: r.day } };
}
