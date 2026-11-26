/**
 * One-time provisioning of the Google OAuth client into D1 (encrypted), for setups where the credentials
 * can be injected into an HTTPS request header by a credential gateway but not typed into `wrangler secret put`.
 *   POST /api/admin/provision/google   headers: x-provision-token, x-google-client-id | x-google-client-secret
 * Disabled unless the PROVISION_TOKEN Worker secret exists; values are never echoed back.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { constantTimeEqual } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { resetGoogleCreds } from "../lib/google-creds";
import { putSecret } from "../lib/secretbox";

export const provisionRoutes = new Hono<AppEnv>();
const te = new TextEncoder();

provisionRoutes.post("/google", async (c) => {
  const expected = c.env.PROVISION_TOKEN;
  const got = c.req.header("x-provision-token") ?? "";
  if (!expected || expected.length < 24 || !constantTimeEqual(te.encode(got), te.encode(expected))) throw new ApiError(404, "not_found");
  if (!c.env.DATA_ENC_KEY) throw new ApiError(409, "conflict", { reason: "DATA_ENC_KEY secret missing" });
  const id = c.req.header("x-google-client-id")?.trim();
  const secret = c.req.header("x-google-client-secret")?.trim();
  const now = c.var.deps.now();
  const stored: string[] = [];
  if (id && /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) {
    await putSecret(c.env, "google_client_id", id, null, now);
    stored.push("google_client_id");
  }
  if (secret && secret.length >= 20 && secret.length <= 200 && !/\s/.test(secret)) {
    await putSecret(c.env, "google_client_secret", secret, null, now);
    stored.push("google_client_secret");
  }
  resetGoogleCreds();
  await audit(c, { actor: null, action: "provision.google", metadata: { stored } });
  return c.json({ stored });
});
