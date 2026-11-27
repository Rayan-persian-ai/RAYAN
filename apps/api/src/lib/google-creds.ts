/**
 * Google OAuth client credentials: Worker secrets GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET when bound,
 * else the copies provisioned into D1 app_secrets (AES-GCM, key from the DATA_ENC_KEY Worker secret)
 * through the one-time, token-protected /api/admin/provision/google route. Loaded once per isolate.
 */
import type { Env } from "../env";
import { getSecret } from "./secretbox";

let cached: Promise<{ id: string | null; secret: string | null }> | null = null;

export function resetGoogleCreds() {
  cached = null;
}

/** Returns env with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET filled from D1 when they are not bound as secrets. */
export async function withGoogleCreds(env: Env): Promise<Env> {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return env;
  if (!env.DATA_ENC_KEY) return env; // D1 copies are only ever encrypted with DATA_ENC_KEY
  cached ??= (async () => ({ id: await getSecret(env, "google_client_id"), secret: await getSecret(env, "google_client_secret") }))().catch(() => ({ id: null, secret: null }));
  const c = await cached;
  if (!(c.id && c.secret)) {
    cached = null; // retry next request (e.g. right after provisioning)
    return env;
  }
  return { ...env, GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || c.id, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET || c.secret };
}
