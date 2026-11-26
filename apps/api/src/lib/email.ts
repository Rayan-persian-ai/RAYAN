/**
 * Pluggable outgoing email. Default provider: Gmail API, sending as the owner's connected Gmail
 * (refresh token from GMAIL_REFRESH_TOKEN or the encrypted D1 copy written by /api/admin/gmail/connect).
 * Optional adapters: Brevo, Resend (only when their key exists and EMAIL_PROVIDER selects them).
 * "log" provider (non-production only) writes the message to the Worker log instead of sending.
 * Every send is metered by a D1 daily counter (EMAIL_DAILY_LIMIT, default 450 — under Gmail's ~500/day).
 */
import type { Env } from "../env";
import { intVar } from "../env";
import { b64url } from "./crypto";
import { reserveUsage } from "./cost";
import { getSecret } from "./secretbox";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
export interface EmailProvider {
  id: string;
  /** Sender address actually used (for display / logs). */
  from(env: Env): Promise<string | null>;
  configured(env: Env): Promise<boolean>;
  send(env: Env, m: EmailMessage): Promise<{ id: string }>;
}
export class EmailUnavailable extends Error {}
export class EmailCapReached extends Error {}

export const EMAIL_SERVICE = "email_out";
const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** RFC 2047 encoded-word for non-ASCII header values (Persian subjects / names). */
export function encodeHeader(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const bytes = new TextEncoder().encode(v);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}
function b64Lines(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return (btoa(bin).match(/.{1,76}/g) ?? []).join("\r\n");
}
const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** Builds an RFC 2822 MIME message (UTF-8, base64 bodies, multipart/alternative when html is given). */
export function buildMime(m: EmailMessage & { from: string; fromName?: string }, boundary = "rayan-" + crypto.randomUUID()): string {
  const from = m.fromName ? `${encodeHeader(clean(m.fromName))} <${clean(m.from)}>` : clean(m.from);
  const head = [`From: ${from}`, `To: ${clean(m.to)}`, `Subject: ${encodeHeader(clean(m.subject))}`, "MIME-Version: 1.0"];
  if (!m.html) {
    return [...head, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64Lines(m.text)].join("\r\n");
  }
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(m.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(m.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

let tokenCache: { token: string; exp: number; rt: string } | null = null;

export async function gmailRefreshToken(env: Env): Promise<string | null> {
  return env.GMAIL_REFRESH_TOKEN || (await getSecret(env, "gmail_refresh_token"));
}

export function gmailProvider(fetchFn: typeof fetch = fetch): EmailProvider {
  const access = async (env: Env): Promise<string> => {
    const rt = await gmailRefreshToken(env);
    if (!rt || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new EmailUnavailable("gmail not connected");
    if (tokenCache && tokenCache.rt === rt && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
    const r = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: "refresh_token" }),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) throw new Error(`gmail token refresh failed: ${j.error ?? r.status}`);
    tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, rt };
    return j.access_token;
  };
  return {
    id: "gmail",
    from: async (env) => (await getSecret(env, "gmail_sender")) ?? env.SENDER_EMAIL ?? null,
    configured: async (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && (await gmailRefreshToken(env))),
    async send(env, m) {
      const token = await access(env);
      const from = (await getSecret(env, "gmail_sender")) ?? env.SENDER_EMAIL ?? "me";
      const raw = b64url(new TextEncoder().encode(buildMime({ ...m, from, fromName: "رایان" })));
      const r = await fetchFn(GMAIL_SEND, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw }) });
      const j = (await r.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!r.ok || !j.id) throw new Error(`gmail send failed: ${j.error?.message ?? r.status}`);
      return { id: j.id };
    },
  };
}

export function brevoProvider(fetchFn: typeof fetch = fetch): EmailProvider {
  return {
    id: "brevo",
    from: async (env) => env.SENDER_EMAIL ?? null,
    configured: async (env) => !!(env.BREVO_API_KEY && env.SENDER_EMAIL),
    async send(env, m) {
      const r = await fetchFn("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": env.BREVO_API_KEY!, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sender: { email: env.SENDER_EMAIL, name: "رایان" }, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html }),
      });
      const j = (await r.json().catch(() => ({}))) as { messageId?: string; message?: string };
      if (!r.ok) throw new Error(`brevo send failed: ${j.message ?? r.status}`);
      return { id: j.messageId ?? "brevo" };
    },
  };
}

export function resendProvider(fetchFn: typeof fetch = fetch): EmailProvider {
  return {
    id: "resend",
    from: async (env) => env.SENDER_EMAIL ?? null,
    configured: async (env) => !!(env.RESEND_API_KEY && env.SENDER_EMAIL),
    async send(env, m) {
      const r = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: `Rayan <${env.SENDER_EMAIL}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      });
      const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!r.ok) throw new Error(`resend send failed: ${j.message ?? r.status}`);
      return { id: j.id ?? "resend" };
    },
  };
}

/** Dev/test only: never sends; the message goes to the Worker log. Disabled when ENVIRONMENT=production. */
export const logProvider: EmailProvider = {
  id: "log",
  from: async () => "log@localhost",
  configured: async (env) => env.ENVIRONMENT !== "production",
  async send(_env, m) {
    console.log(`[email:log] to=${m.to} subject=${m.subject}\n${m.text}`);
    return { id: "log-" + crypto.randomUUID() };
  },
};

export function selectProvider(env: Env, fetchFn?: typeof fetch): EmailProvider {
  switch ((env.EMAIL_PROVIDER ?? "gmail").toLowerCase()) {
    case "brevo":
      return brevoProvider(fetchFn);
    case "resend":
      return resendProvider(fetchFn);
    case "log":
      return logProvider;
    default:
      return gmailProvider(fetchFn);
  }
}

/** Sends with cap + log row. Throws EmailUnavailable / EmailCapReached / Error. */
export async function sendEmail(
  env: Env,
  provider: EmailProvider,
  m: EmailMessage,
  meta: { kind: string; userId: string | null; now: number },
): Promise<{ id: string; provider: string }> {
  if (!(await provider.configured(env))) throw new EmailUnavailable(provider.id);
  const cap = await reserveUsage(env.DB, EMAIL_SERVICE, intVar(env.EMAIL_DAILY_LIMIT, 450), meta.now);
  if (!cap.allowed) throw new EmailCapReached(`${cap.count}/${cap.limit}`);
  const logId = crypto.randomUUID();
  try {
    const r = await provider.send(env, m);
    await env.DB.prepare(
      "INSERT INTO email_log (id, to_email, subject, kind, provider, status, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
      .bind(logId, m.to, m.subject.slice(0, 200), meta.kind, provider.id, provider.id === "log" ? "logged" : "sent", meta.userId, meta.now)
      .run();
    return { id: r.id, provider: provider.id };
  } catch (e) {
    await env.DB.prepare(
      "INSERT INTO email_log (id, to_email, subject, kind, provider, status, error, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'failed', ?6, ?7, ?8)",
    )
      .bind(logId, m.to, m.subject.slice(0, 200), meta.kind, provider.id, String(e instanceof Error ? e.message : e).slice(0, 300), meta.userId, meta.now)
      .run();
    throw e;
  }
}
