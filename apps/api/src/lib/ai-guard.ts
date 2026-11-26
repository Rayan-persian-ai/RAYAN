import type { AppDeps, ChatTurn } from "../deps";
import type { Env } from "../env";
import { withSystemPrompt } from "./ai";
import { AiCapError } from "./ai-chain";
import { AI_SERVICE, envAiLimit, getUsage, reserveUsage } from "./cost";
import { ApiError } from "./errors";
import { isFlagEnabled } from "./flags";

/**
 * Every AI call in the system goes through here: kill switch -> cost cap -> provider.
 * A self-metered provider (the multi-provider chain) reserves per provider inside the chain
 * (Workers AI against AI_DAILY_LIMIT, others against their own daily caps).
 */
export async function guardedChat(env: Env, deps: AppDeps, messages: ChatTurn[]) {
  if (!(await isFlagEnabled(env.DB, "ai_enabled", true)) || !deps.ai.isAvailable(env)) {
    throw new ApiError(503, "ai_disabled");
  }
  if (!deps.ai.selfMetered) {
    const r = await reserveUsage(env.DB, AI_SERVICE, envAiLimit(env), deps.now());
    if (!r.allowed) throw new ApiError(429, "daily_cap_reached", { used: r.count, limit: r.limit, day: r.day });
  }
  let reply: string;
  let provider = deps.ai.name;
  try {
    if (deps.ai.chatDetailed) {
      const out = await deps.ai.chatDetailed(env, withSystemPrompt(messages));
      reply = out.text;
      provider = out.provider;
    } else {
      reply = await deps.ai.chat(env, withSystemPrompt(messages));
    }
  } catch (e) {
    if (e instanceof AiCapError) {
      const u = await getUsage(env.DB, AI_SERVICE, deps.now(), envAiLimit(env));
      throw new ApiError(429, "daily_cap_reached", { used: u.count, limit: u.limit, day: u.day });
    }
    console.error("ai provider error", e);
    throw new ApiError(502, "ai_error");
  }
  const u = await getUsage(env.DB, AI_SERVICE, deps.now(), envAiLimit(env));
  return { reply, provider, usage: { used: u.count, limit: u.limit, day: u.day } };
}
