/**
 * Model catalogue for the chat model picker. Only models verified to answer on this account's FREE tiers
 * (probed 2026-11-26: Workers AI free plan + Google AI Studio free key) are listed. "auto" = strongest
 * available first, falling through on quota / rate / outage:
 *   Gemini (free key, if provisioned) → Workers AI gpt-oss-120b → Llama 4 Scout → Mistral Small → Pollinations/keyed chain.
 * `units` = how many AI_DAILY_LIMIT units one call reserves (≈ neuron cost relative to Llama 4 Scout).
 */
export interface ModelInfo {
  id: string;
  label: string;
  desc: string;
  provider: "auto" | "gemini" | "workers-ai";
  /** Upstream model id (Workers AI @cf/… or Gemini model name). */
  upstream?: string;
  vision: boolean;
  units: number;
}

export const WA_SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const WA_GPT_OSS = "@cf/openai/gpt-oss-120b";
export const WA_MISTRAL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
export const WA_LLAMA70 = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WA_CODER = "@cf/qwen/qwen2.5-coder-32b-instruct";

export const MODELS: ModelInfo[] = [
  { id: "auto", label: "رایان", desc: "شخصیت و قواعد رایان روی قوی‌ترین مدل رایگانِ در دسترس (Gemini → GPT-OSS 120B → Llama 4 → Mistral)؛ اگر سهمیهٔ یکی تمام شود بعدی پاسخ می‌دهد. مدل اختصاصیِ آموزش‌دیده نیست", provider: "auto", vision: true, units: 1 },
  { id: "gemini-flash", label: "Gemini Flash", desc: "قوی و سریع، فهم تصویر (سهمیهٔ رایگان Google)", provider: "gemini", upstream: "gemini-3.5-flash", vision: true, units: 0 },
  { id: "gemini-lite", label: "Gemini Flash-Lite", desc: "سریع‌ترین پاسخ (سهمیهٔ رایگان Google)", provider: "gemini", upstream: "gemini-3.5-flash-lite", vision: true, units: 0 },
  { id: "gpt-oss-120b", label: "GPT-OSS 120B", desc: "استدلال قوی، فارسی خوب (Workers AI)", provider: "workers-ai", upstream: WA_GPT_OSS, vision: false, units: 1 },
  { id: "llama-4-scout", label: "Llama 4 Scout", desc: "سریع، فهم تصویر (Workers AI)", provider: "workers-ai", upstream: WA_SCOUT, vision: true, units: 1 },
  { id: "llama-3.3-70b", label: "Llama 3.3 70B", desc: "مدل بزرگ؛ پرهزینه‌تر در سهمیهٔ روزانه (Workers AI)", provider: "workers-ai", upstream: WA_LLAMA70, vision: false, units: 3 },
  { id: "mistral-small", label: "Mistral Small 3.1", desc: "سبک، فهم تصویر (Workers AI)", provider: "workers-ai", upstream: WA_MISTRAL, vision: true, units: 1 },
  { id: "qwen-coder", label: "Qwen 2.5 Coder 32B", desc: "مخصوص برنامه‌نویسی (Workers AI)", provider: "workers-ai", upstream: WA_CODER, vision: false, units: 1 },
];

export function findModel(id: string | undefined | null): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

/** Gemini models tried in order for "auto" (overridable with the GEMINI_MODELS var, csv). */
export function geminiOrder(env: { GEMINI_MODELS?: string }): string[] {
  const v = (env.GEMINI_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return v.length ? v : ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite"];
}

/** Workers AI models tried in order for "auto" (text / with image). */
export const WA_AUTO_TEXT = [WA_GPT_OSS, WA_SCOUT, WA_MISTRAL];
export const WA_AUTO_VISION = [WA_SCOUT, WA_MISTRAL];
export const unitsFor = (upstream: string) => MODELS.find((m) => m.upstream === upstream)?.units ?? 1;
