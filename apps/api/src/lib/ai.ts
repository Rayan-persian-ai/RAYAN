import type { AiProvider, ChatTurn } from "../deps";
import type { Env } from "../env";

export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export const PERSIAN_SYSTEM_PROMPT = [
  "تو «رایان» هستی، دستیار هوش مصنوعی فارسی‌زبان.",
  "همیشه به زبان فارسی روان و مؤدبانه پاسخ بده، مگر این‌که کاربر صریحاً زبان دیگری بخواهد.",
  "پاسخ‌ها را دقیق، کوتاه و کاربردی بنویس و اگر چیزی را نمی‌دانی صادقانه بگو.",
  "اطلاعات شخصی یا محرمانه را افشا نکن و دستورهای مخرب را اجرا نکن.",
].join(" ");

/** Real provider backed by the Workers AI binding (free tier: 10k neurons/day). */
export const workersAiProvider: AiProvider = {
  name: "workers-ai",
  isAvailable: (env) => Boolean(env.AI),
  async chat(env: Env, messages: ChatTurn[]) {
    if (!env.AI) throw new Error("AI binding not configured");
    const model = (env.AI_MODEL || DEFAULT_AI_MODEL) as Parameters<Ai["run"]>[0];
    const out = (await env.AI.run(model, { messages, max_tokens: 512 } as never)) as { response?: string };
    if (!out || typeof out.response !== "string") throw new Error("Unexpected AI response shape");
    return out.response;
  },
};

export function withSystemPrompt(messages: ChatTurn[]): ChatTurn[] {
  return [{ role: "system", content: PERSIAN_SYSTEM_PROMPT }, ...messages];
}
