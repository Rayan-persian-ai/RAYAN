/**
 * «ساخت تصویر» — free image generation through Pollinations (anonymous, no key), as in the old
 * Space. The Worker never downloads the image (no bandwidth/CPU cost): it translates the prompt to
 * English when needed and returns a deterministic Pollinations URL that the browser loads itself.
 */
export const POLLINATIONS_IMAGE = "https://image.pollinations.ai/prompt/";
export const IMAGE_SIZES = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344] } as const;
export type ImageSize = keyof typeof IMAGE_SIZES;

export const IMAGE_SERVICE = "images_pollinations";
export const IMAGE_DAILY_DEFAULT = 300;

export const TRANSLATE_PROMPT =
  "You are a translator. Translate the user's Persian (or other language) image request into English. Rewrite the user's request as one concise English prompt for an image generator (max 60 words, keep every visual detail, no quotes, no explanations). Output only the prompt.";

/** True when the prompt has non-ASCII text (Persian etc.) and should be translated first. */
export const needsTranslation = (p: string) => /[^\x00-\x7F]/.test(p);

/**
 * Cleans a model's translation: first non-empty line, quotes/labels removed, any stray Persian dropped.
 * Returns null when fewer than 2 English words remain (then the original prompt is used).
 */
export function cleanTranslation(out: string | null | undefined): string | null {
  const line =
    String(out ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /[A-Za-z]{2,}/.test(l) && !/:\s*$/.test(l)) ?? "";
  const s = line
    .replace(/^["'`*\s]+/, "")
    .replace(/^(english\s+)?(prompt|translation)\s*:\s*/i, "")
    .replace(/[\u0600-\u06FF\u200c]+/g, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/^["'`*\s]+|["'`*\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length > 600 || (s.match(/[A-Za-z]{2,}/g) ?? []).length < 1) return null;
  return s;
}

export function imageUrl(prompt: string, size: ImageSize, seed: number): string {
  const [w, h] = IMAGE_SIZES[size] ?? IMAGE_SIZES.square;
  return `${POLLINATIONS_IMAGE}${encodeURIComponent(prompt.slice(0, 600))}?model=flux&width=${w}&height=${h}&seed=${seed}&nologo=true&safe=true`;
}
