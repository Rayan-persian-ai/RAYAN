import { CortexError } from './types.js';

let counter = 0;
/** Short unique id. Uses Web Crypto when available (Workers + modern runtimes). */
export function newId(prefix = 'id'): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  counter = (counter + 1) % 1e9;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

/** Deterministic JSON stringify with sorted object keys. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) throw new CortexError('circular', 'Cannot stringify circular structure');
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = walk(val);
    }
    return out;
  };
  return JSON.stringify(walk(value)) ?? 'undefined';
}

/** FNV-1a 32-bit hash as hex — fast, sync, non-cryptographic fingerprint. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** SHA-256 hex via Web Crypto (available on Workers and Node >= 19). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function abortError(reason?: unknown): CortexError {
  if (reason instanceof CortexError) return reason;
  return new CortexError('cancelled', typeof reason === 'string' ? reason : 'Operation cancelled', { retryable: false });
}

/** Sleep that rejects early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal.reason));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run fn with a timeout. fn receives a signal that aborts on timeout or when the parent aborts.
 * The returned promise settles even if fn ignores its signal.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal,
  label = 'operation',
): Promise<T> {
  const ctrl = new AbortController();
  if (parent?.aborted) throw abortError(parent.reason);
  const onParent = () => ctrl.abort(parent?.reason ?? 'cancelled');
  parent?.addEventListener('abort', onParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      if (Number.isFinite(ms) && ms > 0) {
        timer = setTimeout(() => {
          const err = new CortexError('timeout', `${label} timed out after ${ms}ms`, { retryable: true });
          ctrl.abort(err);
          reject(err);
        }, ms);
      }
      ctrl.signal.addEventListener('abort', () => reject(abortError(ctrl.signal.reason)), { once: true });
      fn(ctrl.signal).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  }
}

/** Extract the first balanced JSON object from free-form LLM text. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** UTC day key YYYY-MM-DD, shifted by an offset in minutes (e.g. +210 for Asia/Tehran). */
export function dayKey(nowMs: number, offsetMinutes = 0): string {
  return new Date(nowMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

const SECRET_KEY_RE = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|private[-_]?key/i;
/** Deep-copy with values under secret-looking keys replaced by "[redacted]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
