/**
 * Offline engine (ported from the old Space's local-llm.js): Gemma 3 1B IT (Q4_K_M GGUF, ~806 MB) running
 * inside the browser with wllama (llama.cpp → WebAssembly). The model is fetched only on request, in
 * ≤88 MB parts from the user's free model repo tm13911391/rayan-gguf, stored in Cache Storage and
 * re-joined into one Blob, so later loads (and offline use) come from disk. Nothing is sent to a server.
 */
export const MODEL_BASE = "https://huggingface.co/tm13911391/rayan-gguf/resolve/main/";
const WLLAMA_JS = "/vendor/wllama/index.js";
const WLLAMA_WASM = "/vendor/wllama/wllama.wasm";
export const MODEL_CACHE = "rayan-model-v8";

export interface Manifest {
  id: string;
  total: number;
  parts: { name: string; size: number }[];
}
export interface Progress {
  got: number;
  total: number;
  phase: "download" | "load";
}

const SYSTEM = `تو «رایان» هستی، دستیار هوش مصنوعی فارسی‌زبان که الان به‌صورت آفلاین در مرورگر کاربر اجرا می‌شوی.
- همیشه به فارسی معیار، روان و مؤدبانه پاسخ بده (اگر کاربر به زبان دیگری نوشت، به همان زبان).
- پاسخ را کوتاه، دقیق و مرتب بنویس؛ از تکرار پرهیز کن.
- اگر مطمئن نیستی، صادقانه بگو «مطمئن نیستم» و چیزی از خودت نساز؛ هرگز شعر یا نقل‌قول را از خودت نساز و به کسی نسبت نده.`;
const FEW_SHOT = [
  { role: "user", content: "سلام، خوبی؟" },
  { role: "assistant", content: "سلام! ممنونم. چه کمکی از دستم برمی‌آید؟" },
];

let wllama: any = null;
let loading: Promise<ModelInfo> | null = null;
export interface ModelInfo {
  id: string;
  sizeMB: number;
  threads: number;
}
let info: ModelInfo | null = null;

export const isReady = () => !!(wllama && wllama.isModelLoaded());
export const modelInfo = () => info;
export const supported = () => typeof WebAssembly === "object" && "caches" in globalThis;

export async function manifest(): Promise<Manifest> {
  const r = await fetch(MODEL_BASE + "manifest.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("manifest " + r.status);
  return (await r.json()) as Manifest;
}

/** Bytes of the model already in Cache Storage, and whether every part is there. */
export async function cacheStatus(): Promise<{ cached: boolean; bytes: number; total: number }> {
  try {
    const m = await manifest();
    const c = await caches.open(MODEL_CACHE);
    let bytes = 0;
    let all = true;
    for (const p of m.parts) {
      const hit = await c.match(MODEL_BASE + p.name);
      if (hit) bytes += p.size;
      else all = false;
    }
    return { cached: all, bytes, total: m.total };
  } catch {
    return { cached: false, bytes: 0, total: 0 };
  }
}

async function fetchPart(cache: Cache, url: string, size: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<Blob> {
  const hit = await cache.match(url);
  if (hit) {
    const b = await hit.blob();
    if (b.size === size) {
      onBytes(size);
      return b;
    }
    await cache.delete(url);
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let got = 0;
    try {
      const r = await fetch(url, { signal, cache: "no-store" });
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      const reader = r.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onBytes(value.length);
      }
      const blob = new Blob(chunks as BlobPart[]);
      if (blob.size !== size) throw new Error(`size mismatch ${blob.size}≠${size}`);
      await cache.put(url, new Response(blob, { headers: { "content-type": "application/octet-stream" } }));
      return blob;
    } catch (e) {
      onBytes(-got);
      lastErr = e;
      if (signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function allParts(onProgress: (p: Progress) => void, signal?: AbortSignal) {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* optional */
  }
  const m = await manifest();
  const cache = await caches.open(MODEL_CACHE);
  let got = 0;
  const tick = (n: number) => {
    got += n;
    onProgress({ got, total: m.total, phase: "download" });
  };
  const blobs: Blob[] = new Array(m.parts.length);
  let next = 0;
  const lane = async () => {
    while (next < m.parts.length) {
      const i = next++;
      const p = m.parts[i]!;
      blobs[i] = await fetchPart(cache, MODEL_BASE + p.name, p.size, tick, signal);
    }
  };
  await Promise.all([lane(), lane(), lane()]);
  return { m, blobs };
}

/** Downloads the model into Cache Storage (Settings → «دانلود برای استفادهٔ آفلاین»). */
export async function download(onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<number> {
  const { m } = await allParts(onProgress, signal);
  try {
    await fetch(WLLAMA_WASM); // warms the service-worker cache for offline use
    await fetch(WLLAMA_JS);
  } catch {
    /* optional */
  }
  return m.total;
}

export async function removeCached() {
  await caches.delete(MODEL_CACHE);
  wllama = null;
  info = null;
  loading = null;
}

export function load(onProgress: (p: Progress) => void = () => {}, signal?: AbortSignal): Promise<ModelInfo> {
  if (isReady() && info) return Promise.resolve(info);
  if (loading) return loading;
  loading = (async () => {
    const { m, blobs } = await allParts(onProgress, signal);
    onProgress({ got: m.total, total: m.total, phase: "load" });
    const mod: any = await import(/* @vite-ignore */ WLLAMA_JS);
    const w = new mod.Wllama({ default: WLLAMA_WASM }, { suppressNativeLog: true, logger: { debug() {}, log() {}, warn: console.warn, error: console.error } });
    const file = new File([new Blob(blobs)], "rayan.gguf");
    const hc = navigator.hardwareConcurrency || 2;
    await w.loadModel([file], { n_ctx: 2048, n_batch: 512, n_threads: Math.max(1, Math.min(8, hc <= 4 ? hc : hc - 1)) });
    wllama = w;
    info = { id: m.id, sizeMB: Math.round(m.total / 1e6), threads: w.getNumThreads?.() ?? 1 };
    return info;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Streams an answer from the in-browser model. onText receives the whole text so far. */
export async function chat(
  history: { role: "user" | "assistant"; content: string }[],
  opts: { onText: (t: string) => void; signal?: AbortSignal; maxTokens?: number },
): Promise<string> {
  if (!isReady()) await load();
  const msgs: { role: string; content: string }[] = [];
  let budget = 2400;
  for (const x of [...history].reverse()) {
    if (budget - x.content.length < 0 && msgs.length) break;
    budget -= x.content.length;
    msgs.unshift({ role: x.role, content: x.content.slice(-1800) });
  }
  while (msgs.length && msgs[0]!.role !== "user") msgs.shift();
  let text = "";
  const it = await wllama.createChatCompletion({
    messages: [{ role: "system", content: SYSTEM }, ...FEW_SHOT, ...msgs],
    stream: true,
    max_tokens: opts.maxTokens ?? 640,
    temperature: 0.5,
    top_k: 40,
    top_p: 0.9,
    repeat_penalty: 1.15,
    abortSignal: opts.signal,
  });
  try {
    for await (const ch of it) {
      const d = ch?.choices?.[0]?.delta?.content;
      if (typeof d === "string" && d) {
        text += d;
        opts.onText(text);
      }
    }
  } catch (e) {
    if (!opts.signal?.aborted) throw e;
  }
  return text.trim();
}
