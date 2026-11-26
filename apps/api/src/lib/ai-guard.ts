import type { AppDeps, ChatTurn } from "../deps";
import type { Env } from "../env";
import { PERSIAN_SYSTEM_PROMPT, withSystemPrompt } from "./ai";
import { AiCapError } from "./ai-chain";
import { AI_SERVICE, envAiLimit, getUsage, reserveUsage } from "./cost";
import { ApiError } from "./errors";
import { isFlagEnabled } from "./flags";

export interface GuardOptions {
  /** System prompt to prepend (default: the Persian identity prompt). */
  system?: string;
  maxTokens?: number;
}

async function preflight(env: Env, deps: AppDeps) {
  if (!(await isFlagEnabled(env.DB, "ai_enabled", true)) || !deps.ai.isAvailable(env)) {
    throw new ApiError(503, "ai_disabled");
  }
  if (!deps.ai.selfMetered) {
    const r = await reserveUsage(env.DB, AI_SERVICE, envAiLimit(env), deps.now());
    if (!r.allowed) throw new ApiError(429, "daily_cap_reached", { used: r.count, limit: r.limit, day: r.day });
  }
}

async function capError(env: Env, deps: AppDeps) {
  const u = await getUsage(env.DB, AI_SERVICE, deps.now(), envAiLimit(env));
  return new ApiError(429, "daily_cap_reached", { used: u.count, limit: u.limit, day: u.day });
}

/**
 * Every AI call in the system goes through here: kill switch -> cost cap -> provider.
 * A self-metered provider (the multi-provider chain) reserves per provider inside the chain
 * (Workers AI against AI_DAILY_LIMIT, others against their own daily caps).
 */
export async function guardedChat(env: Env, deps: AppDeps, messages: ChatTurn[], opts: GuardOptions = {}) {
  await preflight(env, deps);
  const full = withSystemPrompt(messages, opts.system ?? PERSIAN_SYSTEM_PROMPT);
  const call = { maxTokens: opts.maxTokens };
  let reply: string;
  let provider = deps.ai.name;
  try {
    if (deps.ai.chatDetailed) {
      const out = await deps.ai.chatDetailed(env, full, call);
      reply = out.text;
      provider = out.provider;
    } else {
      reply = await deps.ai.chat(env, full, call);
    }
  } catch (e) {
    if (e instanceof AiCapError) throw await capError(env, deps);
    console.error("ai provider error", e);
    throw new ApiError(502, "ai_error");
  }
  const u = await getUsage(env.DB, AI_SERVICE, deps.now(), envAiLimit(env));
  return { reply, provider, usage: { used: u.count, limit: u.limit, day: u.day } };
}

/**
 * Same guards as guardedChat, but returns a token stream. Providers without chatStream (e.g. test
 * mocks) are adapted by yielding their whole answer as one chunk. Errors before the first token
 * become ApiErrors (so the route can still answer with a normal JSON error).
 */
export async function guardedStream(env: Env, deps: AppDeps, messages: ChatTurn[], opts: GuardOptions = {}) {
  await preflight(env, deps);
  const full = withSystemPrompt(messages, opts.system ?? PERSIAN_SYSTEM_PROMPT);
  const call = { maxTokens: opts.maxTokens };
  try {
    if (deps.ai.chatStream) return await deps.ai.chatStream(env, full, call);
    const text = deps.ai.chatDetailed ? await deps.ai.chatDetailed(env, full, call) : { text: await deps.ai.chat(env, full, call), provider: deps.ai.name, model: "" };
    return {
      provider: text.provider,
      model: text.model,
      stream: (async function* () {
        yield text.text;
      })(),
    };
  } catch (e) {
    if (e instanceof AiCapError) throw await capError(env, deps);
    if (e instanceof ApiError) throw e;
    console.error("ai provider error", e);
    throw new ApiError(502, "ai_error");
  }
}
