/** Password hashing (PBKDF2-SHA256 via WebCrypto) and token helpers. No plaintext is ever stored. */
const enc = new TextEncoder();

/** workerd rejects PBKDF2 with more than 100k iterations. */
export const MAX_PBKDF2_ITERATIONS = 100_000;
const MIN_PBKDF2_ITERATIONS = 10_000;

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export function clampIterations(n: number): number {
  return Math.min(MAX_PBKDF2_ITERATIONS, Math.max(MIN_PBKDF2_ITERATIONS, Math.floor(n)));
}

/** Format: pbkdf2_sha256$<iterations>$<salt b64url>$<hash b64url> */
export async function hashPassword(password: string, iterations = MAX_PBKDF2_ITERATIONS): Promise<string> {
  const it = clampIterations(iterations);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, it);
  return `pbkdf2_sha256$${it}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const it = Number(parts[1]);
  if (!Number.isInteger(it) || it < MIN_PBKDF2_ITERATIONS || it > MAX_PBKDF2_ITERATIONS) return false;
  const expected = fromB64url(parts[3]!);
  const actual = await derive(password, fromB64url(parts[2]!), it);
  return constantTimeEqual(actual, expected);
}

/** Iteration count recorded in a stored hash, or null when the hash is malformed. */
export function storedIterations(stored: string): number | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return null;
  const it = Number(parts[1]);
  return Number.isInteger(it) ? it : null;
}

/** True when a stored hash uses fewer iterations than the configured count and should be upgraded on login. */
export function needsRehash(stored: string, configuredIterations: number): boolean {
  const it = storedIterations(stored);
  return it !== null && it < clampIterations(configuredIterations);
}

/**
 * A fixed, valid hash used to keep login timing uniform when the email does not exist.
 * It uses the configured iteration count so an unknown email costs the same CPU as a real one.
 */
export function dummyHash(iterations: number): string {
  return `pbkdf2_sha256$${clampIterations(iterations)}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
}

/** @deprecated use dummyHash(configured) — kept for callers that do not know the configured count. */
export const DUMMY_HASH = dummyHash(MAX_PBKDF2_ITERATIONS);

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newId(): string {
  return crypto.randomUUID();
}
