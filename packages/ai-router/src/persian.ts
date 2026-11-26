/** Persian-output helpers: detection, cleanup of reasoning traces, and the system instruction. */

export const PERSIAN_INSTRUCTION =
  "پاسخ را فقط به زبان فارسی روان بنویس (مگر این‌که کاربر صریحاً زبان دیگری خواسته باشد). از حروف و نگارش فارسی استفاده کن.";

// Arabic-script block (Persian uses it, plus ZWNJ). Count letters only.
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN = /[A-Za-z]/g;

/** Share of letters that are Arabic-script (0..1). Digits, punctuation and whitespace are ignored. */
export function persianRatio(text: string): number {
  const fa = text.match(ARABIC_SCRIPT)?.length ?? 0;
  const la = text.match(LATIN)?.length ?? 0;
  const total = fa + la;
  return total === 0 ? 0 : fa / total;
}

export function isMostlyPersian(text: string, threshold = 0.5): boolean {
  return persianRatio(text) >= threshold;
}

/**
 * Should the answer be in Persian? Yes when the latest user turn is Persian (or has no letters),
 * unless the user explicitly asks for another language.
 */
export function wantsPersian(lastUserText: string): boolean {
  const t = lastUserText.toLowerCase();
  if (/(in english|answer in english|به انگلیسی|انگلیسی بنویس|انگلیسی جواب|in arabic|به عربی|auf deutsch|en français)/i.test(t)) return false;
  const fa = lastUserText.match(ARABIC_SCRIPT)?.length ?? 0;
  const la = lastUserText.match(LATIN)?.length ?? 0;
  if (fa === 0 && la === 0) return true;
  return fa >= la * 0.5; // Persian with some Latin terms (code, brand names) still counts as Persian
}

/** Removes <think>…</think> reasoning blocks some open models emit, and trims. */
export function cleanOutput(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*<think>[\s\S]*$/i, "") // unterminated think block = no answer
    .trim();
}

/** Ensures the conversation carries a Persian-output instruction exactly once. */
export function withPersianInstruction<T extends { role: string; content: string }>(messages: T[]): T[] {
  if (messages.some((m) => m.role === "system" && m.content.includes(PERSIAN_INSTRUCTION))) return messages;
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    const copy = messages.slice();
    const sys = copy[sysIdx]!;
    copy[sysIdx] = { ...sys, content: `${sys.content}\n${PERSIAN_INSTRUCTION}` };
    return copy;
  }
  return [{ role: "system", content: PERSIAN_INSTRUCTION } as T, ...messages];
}
