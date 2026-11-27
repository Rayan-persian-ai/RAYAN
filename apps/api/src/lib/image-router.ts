/**
 * Image router (free only, no billing). Order by verified quality (side-by-side test 2026-11-26):
 *   standard: Workers AI FLUX.2 [klein] 9B → Leonardo Lucid Origin → FLUX.1 [schnell] → Pollinations flux
 *   hq:       Workers AI FLUX.2 [dev]      → FLUX.2 [klein] 9B → Lucid Origin → FLUX.1 [schnell] → Pollinations
 * Gemini image models were tested with the free key and answer 429 (free quota 0) → not used.
 * Workers AI image calls are metered by the D1 counter "images_workers_ai" (IMAGE_WA_DAILY_LIMIT, default 40/day;
 * they share the 10k-neuron free pool with chat). Pollinations output is downloaded and validated server-side
 * (HTTP 200, image/*, expected dimensions, ≥ 25 KB) so a "busy"/rate-limit placeholder is treated as a failure.
 */
import { intVar, type Env } from "../env";
import { reserveUsage } from "./cost";

export const WA_IMAGE_SERVICE = "images_workers_ai";
export const POLL_IMAGE_SERVICE = "images_pollinations";
export const IMAGE_ASPECTS = { square: [1024, 1024], wide: [1216, 832], tall: [832, 1216], landscape: [1344, 768], portrait: [768, 1344] } as const;
export type ImageAspect = keyof typeof IMAGE_ASPECTS;

export interface GenImage {
  provider: "workers-ai" | "pollinations";
  model: string;
  mime: string;
  /** base64 */
  data: string;
  width: number;
  height: number;
  seed: number;
}

type AiRun = { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };

interface WaModel {
  id: string;
  units: number;
  kind: "multipart" | "json" | "json-square";
}
export const WA_IMAGE_MODELS: Record<string, WaModel> = {
  "flux-2-dev": { id: "@cf/black-forest-labs/flux-2-dev", units: 2, kind: "multipart" },
  "flux-2-klein-9b": { id: "@cf/black-forest-labs/flux-2-klein-9b", units: 1, kind: "multipart" },
  "lucid-origin": { id: "@cf/leonardo/lucid-origin", units: 1, kind: "json" },
  "flux-1-schnell": { id: "@cf/black-forest-labs/flux-1-schnell", units: 1, kind: "json-square" },
};
export function imageOrder(quality: "standard" | "hq"): string[] {
  return quality === "hq" ? ["flux-2-dev", "flux-2-klein-9b", "lucid-origin", "flux-1-schnell"] : ["flux-2-klein-9b", "lucid-origin", "flux-1-schnell"];
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function streamBytes(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Width/height from a JPEG (SOF marker), PNG (IHDR) or WebP (VP8/VP8L/VP8X) header; null if unknown. */
export function imageDims(b: Uint8Array): { w: number; h: number; mime: string } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: (b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!, h: (b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!, mime: "image/png" };
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45) {
    const tag = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (tag === "VP8X") return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)), mime: "image/webp" };
    if (tag === "VP8 ") return { w: (b[26]! | (b[27]! << 8)) & 0x3fff, h: (b[28]! | (b[29]! << 8)) & 0x3fff, mime: "image/webp" };
    if (tag === "VP8L") {
      const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1, mime: "image/webp" };
    }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]!, mime: "image/jpeg" };
      i += 2 + len;
    }
  }
  return null;
}

/** Rejects placeholders: too small, wrong type, or dimensions far from what was asked. */
export function validImage(bytes: Uint8Array, w: number, h: number, minBytes = 25_000): { mime: string; w: number; h: number } | null {
  if (bytes.length < minBytes) return null;
  const d = imageDims(bytes);
  if (!d) return null;
  const ratioAsked = w / h;
  const ratioGot = d.w / d.h;
  if (Math.abs(ratioGot - ratioAsked) / ratioAsked > 0.12 || d.w < 256) return null;
  return { mime: d.mime, w: d.w, h: d.h };
}

async function runWorkersAi(ai: AiRun, key: string, prompt: string, w: number, h: number, seed: number, negative?: string): Promise<GenImage> {
  const m = WA_IMAGE_MODELS[key]!;
  let out: unknown;
  if (m.kind === "multipart") {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(w));
    form.append("height", String(h));
    form.append("seed", String(seed));
    const fr = new Response(form);
    out = await ai.run(m.id, { multipart: { body: fr.body, contentType: fr.headers.get("content-type") } });
  } else if (m.kind === "json") {
    out = await ai.run(m.id, { prompt, width: w, height: h, seed, ...(negative ? { negative_prompt: negative } : {}) });
  } else {
    out = await ai.run(m.id, { prompt, steps: 8, seed });
  }
  let bytes: Uint8Array | null = null;
  if (out instanceof ReadableStream) bytes = await streamBytes(out);
  else if (out instanceof Uint8Array) bytes = out;
  else if (typeof (out as { image?: unknown })?.image === "string") bytes = Uint8Array.from(atob((out as { image: string }).image), (c) => c.charCodeAt(0));
  if (!bytes) throw new Error(`${key}: unexpected output`);
  const v = validImage(bytes, m.kind === "json-square" ? 1 : w, m.kind === "json-square" ? 1 : h, 10_000);
  if (!v) throw new Error(`${key}: invalid image`);
  return { provider: "workers-ai", model: key, mime: v.mime, data: toB64(bytes), width: v.w, height: v.h, seed };
}

export async function pollinationsImage(prompt: string, w: number, h: number, seed: number, fetchFn: typeof fetch = fetch): Promise<GenImage> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}?model=flux&width=${w}&height=${h}&seed=${seed}&nologo=true&safe=true&enhance=false`;
  const r = await fetchFn(url, { headers: { accept: "image/*" } });
  if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) throw new Error(`pollinations ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const v = validImage(bytes, w, h);
  if (!v) throw new Error("pollinations: placeholder/busy image rejected");
  return { provider: "pollinations", model: "flux", mime: v.mime, data: toB64(bytes), width: v.w, height: v.h, seed };
}

/** One image through the router. Throws with the list of attempts when every provider failed. */
export async function generateImage(
  env: Env,
  o: { prompt: string; aspect: ImageAspect; seed: number; quality: "standard" | "hq"; negative?: string; now: number; fetchFn?: typeof fetch; log?: (s: string) => void },
): Promise<GenImage> {
  const [w, h] = IMAGE_ASPECTS[o.aspect] ?? IMAGE_ASPECTS.square;
  const log = o.log ?? ((s: string) => console.log(s));
  const errors: string[] = [];
  const ai = env.AI as unknown as AiRun | undefined;
  if (ai) {
    for (const key of imageOrder(o.quality)) {
      if (WA_IMAGE_MODELS[key]!.kind === "json-square" && o.aspect !== "square") continue;
      let ok = true;
      for (let u = 0; u < WA_IMAGE_MODELS[key]!.units; u++) {
        const r = await reserveUsage(env.DB, WA_IMAGE_SERVICE, intVar((env as { IMAGE_WA_DAILY_LIMIT?: string }).IMAGE_WA_DAILY_LIMIT, 40), o.now);
        if (!r.allowed) ok = false;
      }
      if (!ok) {
        errors.push("workers-ai: daily image cap");
        break;
      }
      try {
        return await runWorkersAi(ai, key, o.prompt, w, h, o.seed, o.negative);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg.slice(0, 120));
        log(`image ${key} failed: ${msg}`);
      }
    }
  }
  const r = await reserveUsage(env.DB, POLL_IMAGE_SERVICE, 300, o.now);
  if (r.allowed) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await pollinationsImage(o.prompt, w, h, o.seed + attempt, o.fetchFn);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  } else errors.push("pollinations: daily cap");
  throw new ImageRouterError(errors);
}

export class ImageRouterError extends Error {
  constructor(readonly attempts: string[]) {
    super("all image providers failed: " + attempts.join(" | "));
  }
}

export const ENHANCE_PROMPT = [
  "You are an expert prompt engineer for photorealistic and artistic text-to-image models (FLUX).",
  "Rewrite the user's request (often Persian) as ONE rich English prompt, 40-90 words: main subject first, then setting, composition/camera, lighting, colours, mood, style and quality cues.",
  "Keep every concrete detail the user asked for (counts, colours, text, positions) and add nothing that contradicts it. Iranian/Persian cultural elements must stay authentic.",
  "If the user wants written text in the image, keep it short and put it in double quotes.",
  "Output only the prompt, no preface, no quotes around the whole prompt.",
].join(" ");
