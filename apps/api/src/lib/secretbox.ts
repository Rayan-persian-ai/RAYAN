/** AES-GCM encryption for secrets the app stores itself (app_secrets), keyed by HKDF from a Worker secret. */
import type { Env } from "../env";
import { b64url, fromB64url } from "./crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

function masterSecret(env: Env): string | null {
  return env.DATA_ENC_KEY || env.GOOGLE_CLIENT_SECRET || null;
}
/** The Google client credentials themselves must never be encrypted with a key derived from themselves. */
const needsDedicatedKey = (name: string) => name.startsWith("google_client_");

async function keyFor(env: Env, purpose: string): Promise<CryptoKey> {
  const m = needsDedicatedKey(purpose.replace(/^app-secret:/, "")) ? (env.DATA_ENC_KEY ?? null) : masterSecret(env);
  if (!m) throw new Error("no encryption secret configured (DATA_ENC_KEY / GOOGLE_CLIENT_SECRET)");
  const base = await crypto.subtle.importKey("raw", enc.encode(m), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("rayan/v1"), info: enc.encode(purpose) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function putSecret(env: Env, name: string, value: string, userId: string | null, now: number) {
  const key = await keyFor(env, `app-secret:${name}`);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(value));
  await env.DB.prepare(
    `INSERT INTO app_secrets (name, ciphertext, iv, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(name, b64url(ct), b64url(iv), userId, now)
    .run();
}

export async function getSecret(env: Env, name: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT ciphertext, iv FROM app_secrets WHERE name = ?1").bind(name).first<{ ciphertext: string; iv: string }>();
  if (!row || !masterSecret(env)) return null;
  try {
    const key = await keyFor(env, `app-secret:${name}`);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(row.iv) }, key, fromB64url(row.ciphertext));
    return dec.decode(pt);
  } catch {
    return null; // key rotated / tampered
  }
}

export async function deleteSecret(env: Env, name: string) {
  await env.DB.prepare("DELETE FROM app_secrets WHERE name = ?1").bind(name).run();
}

/** HMAC-SHA256 (hex) keyed by the master secret — used for one-time email codes. */
export async function hmacHex(env: Env, data: string): Promise<string> {
  const m = masterSecret(env) ?? "rayan-dev-only-key";
  const k = await crypto.subtle.importKey("raw", enc.encode(m), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
