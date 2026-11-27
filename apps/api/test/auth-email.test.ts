import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { b64url, fromB64url } from "../src/lib/crypto";
import { buildMime, encodeHeader, gmailProvider, logProvider, selectProvider, type EmailMessage, type EmailProvider } from "../src/lib/email";
import { getSecret, putSecret } from "../src/lib/secretbox";
import { client, makeDeps as baseDeps, PASSWORD, registeredClient, uniqueEmail } from "./helpers";

const GOOGLE = { GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-secret-value" };
let dayN = 0;
const makeDeps: typeof baseDeps = (over = {}) => {
  const now = Date.UTC(2041, 0, 1 + ++dayN * 2, 10);
  return baseDeps({ now: () => now, ...over });
};

/** Captures outgoing mail instead of sending it. */
function inbox(configured = true) {
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = {
    id: "test",
    from: async () => "rayan@test",
    configured: async () => configured,
    async send(_e, m) {
      sent.push(m);
      return { id: "m" + sent.length };
    },
  };
  const lastCode = () => sent.at(-1)!.subject.match(/(\d{6})$/)![1]!;
  return { provider, sent, lastCode };
}

/** Signs up while a provider is configured, verifies with the emailed code; returns the signed-in client. */
async function verifiedUser(deps: ReturnType<typeof makeDeps>, mail: ReturnType<typeof inbox>) {
  const c = client({ deps });
  const email = uniqueEmail("v");
  expect((await c.json("POST", "/api/auth/signup", { email, password: PASSWORD })).status).toBe(201);
  expect((await c.json("POST", "/api/auth/email/verify", { email, code: mail.lastCode() })).status).toBe(200);
  mail.sent.length = 0;
  return { c, email };
}

describe("email codes: verify on signup, passwordless login, reset", () => {
  it("requires the emailed code after signup when a provider is configured", async () => {
    const mail = inbox();
    const c = client({ deps: makeDeps({ email: mail.provider }) });
    const email = uniqueEmail("verify");
    const s = await c.json("POST", "/api/auth/signup", { email, password: PASSWORD });
    expect(s.status).toBe(201);
    expect(s.body.verification_required).toBe(true);
    expect(mail.sent[0]!.to).toBe(email);
    expect(mail.sent[0]!.text).toContain("۱۰ دقیقه");
    const row = await env.DB.prepare("SELECT code_hash FROM email_codes WHERE email = ?1").bind(email).first<{ code_hash: string }>();
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.code_hash).not.toContain(mail.lastCode()); // only an HMAC is stored

    const blocked = await c.json("POST", "/api/auth/login", { email, password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("email_unverified");

    expect((await c.json("POST", "/api/auth/email/verify", { email, code: "000000" === mail.lastCode() ? "111111" : "000000" })).status).toBe(400);
    const persian = mail.lastCode().replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
    const v = await c.json("POST", "/api/auth/email/verify", { email, code: persian }); // Persian digits accepted
    expect(v.status).toBe(200);
    expect(c.cookie).toBeTruthy();
    expect((await c.json("GET", "/api/me")).status).toBe(200);
    expect((await c.json("POST", "/api/auth/email/verify", { email, code: mail.lastCode() })).status).toBe(400); // single use
    const ok = await client({ deps: makeDeps({ email: mail.provider }) }).json("POST", "/api/auth/login", { email, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it("signs in with a one-time login code and never reveals whether an account exists", async () => {
    const mail = inbox();
    const deps = makeDeps({ email: mail.provider });
    const { email } = await verifiedUser(deps, mail);
    const c = client({ deps });
    const unknown = await c.json("POST", "/api/auth/email/send-code", { email: uniqueEmail("nobody"), purpose: "login" });
    expect(unknown.status).toBe(200);
    expect(mail.sent).toHaveLength(0);
    const r = await c.json("POST", "/api/auth/email/send-code", { email, purpose: "login" });
    expect(r.body.message).toBe(unknown.body.message);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.subject).toContain("کد ورود");
    const login = await c.json("POST", "/api/auth/email/login", { email, code: mail.lastCode() });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);
  });

  it("expires codes after 10 minutes and burns them after 5 wrong attempts", async () => {
    const mail = inbox();
    let now = Date.UTC(2041, 6, 1, 10);
    const deps = baseDeps({ email: mail.provider, now: () => now });
    const { email } = await verifiedUser(deps, mail);
    const c = client({ deps });
    await c.json("POST", "/api/auth/email/send-code", { email, purpose: "login" });
    const code = mail.lastCode();
    now += 10 * 60_000 + 1;
    expect((await c.json("POST", "/api/auth/email/login", { email, code })).status).toBe(400);
    await c.json("POST", "/api/auth/email/send-code", { email, purpose: "login" });
    const code2 = mail.lastCode();
    for (let i = 0; i < 5; i++) await c.json("POST", "/api/auth/email/login", { email, code: code2 === "123456" ? "654321" : "123456" });
    expect((await c.json("POST", "/api/auth/email/login", { email, code: code2 })).status).toBe(400);
  });

  it("resets the password with a code and revokes existing sessions", async () => {
    const mail = inbox();
    const deps = makeDeps({ email: mail.provider });
    const { c: old, email } = await verifiedUser(deps, mail);
    const c = client({ deps });
    await c.json("POST", "/api/auth/email/send-code", { email, purpose: "reset" });
    const np = "brand-new-password-42";
    expect((await c.json("POST", "/api/auth/password/reset", { email, code: mail.lastCode(), password: "short" })).status).toBe(400);
    const r = await c.json("POST", "/api/auth/password/reset", { email, code: mail.lastCode(), password: np });
    expect(r.status).toBe(200);
    expect((await old.json("GET", "/api/me")).status).toBe(401);
    expect((await client({ deps }).json("POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(401);
    expect((await client({ deps }).json("POST", "/api/auth/login", { email, password: np })).status).toBe(200);
  });

  it("is hidden (503 + health flag false) when no provider is configured, and signup still works", async () => {
    const mail = inbox(false);
    const deps = makeDeps({ email: mail.provider });
    const c = client({ deps });
    expect((await c.json("POST", "/api/auth/email/send-code", { email: uniqueEmail(), purpose: "login" })).status).toBe(503);
    const h = await c.json("GET", "/api/health");
    expect(h.body.auth).toMatchObject({ email_codes: false, google: false });
    const { email } = await registeredClient({ deps });
    expect(email).toBeTruthy(); // login without verification is allowed while email is unavailable
    const h2 = await client({ deps: makeDeps({ email: inbox(true).provider }), env: GOOGLE }).json("GET", "/api/health");
    expect(h2.body.auth).toMatchObject({ email_codes: true, google: true });
  });

  it("rate limits code requests per email", async () => {
    const mail = inbox();
    const deps = makeDeps({ email: mail.provider });
    const { email } = await verifiedUser(deps, mail);
    const c = client({ deps });
    for (let i = 0; i < 3; i++) expect((await c.json("POST", "/api/auth/email/send-code", { email, purpose: "login" })).status).toBe(200);
    expect((await c.json("POST", "/api/auth/email/send-code", { email, purpose: "login" })).status).toBe(429);
  });
});

describe("Gmail provider", () => {
  it("builds an RFC 2822 message with an encoded Persian subject", () => {
    expect(encodeHeader("Hello")).toBe("Hello");
    const enc = encodeHeader("کد ورود");
    expect(enc).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const mime = buildMime({ from: "a@b.c", fromName: "رایان", to: "x@y.z", subject: "سلام\r\nBcc: evil@x", text: "متن", html: "<p>متن</p>" }, "B");
    expect(mime).toContain("To: x@y.z\r\n");
    expect(mime).not.toMatch(/\r\nBcc:/); // header injection neutralised
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="B"');
    const body = mime.split("\r\n\r\n")[2]!.split("\r\n--B")[0]!.replace(/\r\n/g, "");
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0)))).toBe("متن");
  });

  it("refreshes an access token and sends base64url raw mail via users.messages.send", async () => {
    const calls: { url: string; body: string }[] = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push({ url: String(u), body: String(init.body) });
      if (String(u).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at-1", expires_in: 3600 });
      return Response.json({ id: "gm-1" });
    }) as unknown as typeof fetch;
    const e = { ...env, ...GOOGLE, GMAIL_REFRESH_TOKEN: "rt-xyz", SENDER_EMAIL: "owner@rayan.test" } as any;
    const p = gmailProvider(f);
    expect(await p.configured(e)).toBe(true);
    const r = await p.send(e, { to: "u@x.y", subject: "کد ورود", text: "سلام" });
    expect(r.id).toBe("gm-1");
    expect(calls[0]!.body).toContain("grant_type=refresh_token");
    expect(calls[0]!.body).toContain("refresh_token=rt-xyz");
    expect(calls[1]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const raw = JSON.parse(calls[1]!.body).raw as string;
    expect(raw).not.toMatch(/[+/=]/); // base64url
    const mime = new TextDecoder().decode(fromB64url(raw));
    expect(mime).toContain("To: u@x.y");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(await gmailProvider(f).configured({ ...env } as any)).toBe(false);
    expect(selectProvider({ EMAIL_PROVIDER: "brevo" } as any).id).toBe("brevo");
    expect(selectProvider({} as any).id).toBe("gmail");
    expect(await logProvider.configured({ ENVIRONMENT: "production" } as any)).toBe(false);
  });

  it("stores app secrets encrypted (AES-GCM) and reads them back", async () => {
    const e = { ...env, ...GOOGLE } as any;
    await putSecret(e, "t_secret", "refresh-token-plain", null, 1);
    const row = await env.DB.prepare("SELECT ciphertext FROM app_secrets WHERE name = 't_secret'").first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain("refresh-token-plain");
    expect(await getSecret(e, "t_secret")).toBe("refresh-token-plain");
    expect(await getSecret({ ...e, GOOGLE_CLIENT_SECRET: "other" }, "t_secret")).toBeNull(); // wrong key cannot decrypt
  });
});

function idToken(claims: Record<string, unknown>) {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

describe("Sign in with Google (OAuth code + PKCE)", () => {
  async function start(c: ReturnType<typeof client>) {
    const r = await c.request("GET", "/api/auth/google/start");
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    return { loc, cookie, state: loc.searchParams.get("state")!, nonce: loc.searchParams.get("nonce")! };
  }
  const tokenFetch = (claims: (n: string) => Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    let nonce = "";
    const f = (async (u: string, init: RequestInit) => {
      const b = new URLSearchParams(String(init.body));
      f.lastBody = b;
      return Response.json({ id_token: idToken({ ...claims(nonce), nonce: f.nonce }), ...extra });
    }) as any;
    f.setNonce = (n: string) => (f.nonce = n);
    return f;
  };

  it("redirects to Google with PKCE S256, state, nonce and the openid email profile scopes", async () => {
    const c = client({ env: GOOGLE });
    const { loc, cookie } = await start(c);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://api.rayan.test/api/auth/google/callback");
    expect(cookie).toMatch(/^__Host-rayan_oauth=/);
    const none = await client().request("GET", "/api/auth/google/start");
    expect(none.headers.get("location")).toContain("err=google_unavailable");
  });

  it("creates a verified account, links an existing password account by verified email, and bootstraps the owner", async () => {
    const f = tokenFetch(() => ({}));
    const deps = makeDeps({ fetch: f });
    // 1) new user
    const c = client({ env: GOOGLE, deps });
    const s = await start(c);
    const email = uniqueEmail("google");
    f.setNonce(s.nonce);
    const claims = { iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, sub: "g-" + Date.now(), email, email_verified: true, name: "کاربر گوگل", exp: 9999999999 };
    const fx = (async (u: string, init: RequestInit) => {
      f.lastBody = new URLSearchParams(String(init.body));
      return Response.json({ id_token: idToken({ ...claims, nonce: s.nonce }) });
    }) as any;
    const c1 = client({ env: GOOGLE, deps: baseDeps({ fetch: fx }) });
    c1.cookie = s.cookie;
    // the state lives in D1, so a second client with the same cookie can complete it
    const cb = await c1.request("GET", `/api/auth/google/callback?state=${s.state}&code=abc`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toMatch(/#\/chat$/);
    expect(f.lastBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(f.lastBody.get("grant_type")).toBe("authorization_code");
    expect((await c1.json("GET", "/api/me")).body.user).toMatchObject({ email, display_name: "کاربر گوگل" });
    // replaying the same state fails (single use)
    c1.cookie = s.cookie;
    expect((await c1.request("GET", `/api/auth/google/callback?state=${s.state}&code=abc`)).headers.get("location")).toContain("err=oauth_failed");

    // 2) link existing password account
    const existing = await registeredClient();
    const c2 = client({ env: GOOGLE });
    const s2 = await start(c2);
    const f2 = (async () => Response.json({ id_token: idToken({ ...claims, sub: "g2-" + Date.now(), email: existing.email, nonce: s2.nonce }) })) as any;
    const c2b = client({ env: GOOGLE, deps: baseDeps({ fetch: f2 }) });
    c2b.cookie = s2.cookie;
    await c2b.request("GET", `/api/auth/google/callback?state=${s2.state}&code=x`);
    expect((await c2b.json("GET", "/api/me")).body.user.id).toBe(existing.userId);

    // 3) owner email → super_admin (same rule as password login)
    const c3 = client({ env: GOOGLE });
    const s3 = await start(c3);
    const f3 = (async () => Response.json({ id_token: idToken({ ...claims, sub: "owner-" + Date.now(), email: "owner@rayan.test", nonce: s3.nonce }) })) as any;
    const c3b = client({ env: GOOGLE, deps: baseDeps({ fetch: f3 }) });
    c3b.cookie = s3.cookie;
    await c3b.request("GET", `/api/auth/google/callback?state=${s3.state}&code=x`);
    expect((await c3b.json("GET", "/api/me")).body.roles).toContain("super_admin");
  });

  it("rejects bad nonce, unverified email, missing state cookie, and maps access_denied to a Persian hint", async () => {
    const c = client({ env: GOOGLE });
    const s = await start(c);
    const bad = (async () => Response.json({ id_token: idToken({ iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, sub: "x", email: uniqueEmail(), email_verified: true, exp: 9999999999, nonce: "wrong" }) })) as any;
    const cb = client({ env: GOOGLE, deps: baseDeps({ fetch: bad }) });
    cb.cookie = s.cookie;
    expect((await cb.request("GET", `/api/auth/google/callback?state=${s.state}&code=x`)).headers.get("location")).toContain("err=oauth_failed");

    const s2 = await start(c);
    const unv = (async () => Response.json({ id_token: idToken({ iss: "accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, sub: "y", email: uniqueEmail(), email_verified: false, exp: 9999999999, nonce: s2.nonce }) })) as any;
    const cu = client({ env: GOOGLE, deps: baseDeps({ fetch: unv }) });
    cu.cookie = s2.cookie;
    expect((await cu.request("GET", `/api/auth/google/callback?state=${s2.state}&code=x`)).headers.get("location")).toContain("err=oauth_failed");

    const s3 = await start(c);
    const nocookie = client({ env: GOOGLE });
    expect((await nocookie.request("GET", `/api/auth/google/callback?state=${s3.state}&code=x`)).headers.get("location")).toContain("err=oauth_failed");

    expect((await client({ env: GOOGLE }).request("GET", "/api/auth/google/callback?error=access_denied")).headers.get("location")).toContain("err=google_denied");
  });

  it("lets only the owner connect Gmail (offline + consent + gmail.send) and stores the refresh token encrypted", async () => {
    const member = await registeredClient({ env: GOOGLE });
    expect((await member.c.request("GET", "/api/admin/gmail/connect")).status).toBe(403);

    // owner account (may already exist from other test files): give it the known test password, then log in
    const oc = client({ env: GOOGLE });
    await oc.json("POST", "/api/auth/signup", { email: "owner@rayan.test", password: PASSWORD });
    await env.DB.prepare("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = ?1), email_verified_at = 1 WHERE email = 'owner@rayan.test'")
      .bind(member.email)
      .run();
    expect((await oc.json("POST", "/api/auth/login", { email: "owner@rayan.test", password: PASSWORD })).status).toBe(200);
    const session = oc.cookie;
    const r = await oc.request("GET", "/api/admin/gmail/connect");
    oc.cookie = session; // the test client keeps one cookie; restore the session after the state cookie
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.send");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    const state = loc.searchParams.get("state")!;
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    const f = (async () =>
      Response.json({
        id_token: idToken({ iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, sub: "own", email: "owner@rayan.test", email_verified: true, exp: 9999999999, nonce: loc.searchParams.get("nonce") }),
        refresh_token: "1//refresh-token-secret",
        scope: "openid https://www.googleapis.com/auth/gmail.send email",
      })) as any;
    const cb = client({ env: GOOGLE, deps: baseDeps({ fetch: f }) });
    cb.cookie = cookie;
    const done = await cb.request("GET", `/api/auth/google/callback?state=${state}&code=x`);
    expect(done.headers.get("location")).toMatch(/#\/admin\?gmail=connected$/);
    const row = await env.DB.prepare("SELECT ciphertext FROM app_secrets WHERE name = 'gmail_refresh_token'").first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain("refresh-token-secret");
    const st = await oc.json("GET", "/api/admin/gmail/status");
    expect(st.body).toMatchObject({ provider: "gmail", configured: true, gmail_connected: true, sender: "owner@rayan.test" });
    expect(JSON.stringify(st.body)).not.toContain("refresh-token-secret");
    expect((await oc.json("POST", "/api/admin/gmail/disconnect", {})).status).toBe(200);
    expect((await oc.json("GET", "/api/admin/gmail/status")).body.gmail_connected).toBe(false);
  });
});

describe("one-time Google credential provisioning", () => {
  it("is hidden without PROVISION_TOKEN, stores encrypted creds with it, and they enable Google sign-in", async () => {
    const id = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
    expect((await client().json("POST", "/api/admin/provision/google", {}, { "x-provision-token": "x" })).status).toBe(404);
    const e = { PROVISION_TOKEN: "p".repeat(32), DATA_ENC_KEY: "k".repeat(40) };
    expect((await client({ env: e }).json("POST", "/api/admin/provision/google", {}, { "x-provision-token": "wrong".padEnd(32, "x") })).status).toBe(404);
    const r = await client({ env: e }).json("POST", "/api/admin/provision/google", {}, { "x-provision-token": e.PROVISION_TOKEN, "x-google-client-id": id, "x-google-client-secret": "GOCSPX-test-secret-value-123" });
    expect(r.body.stored).toEqual(["google_client_id", "google_client_secret"]);
    expect(JSON.stringify(r.body)).not.toContain("GOCSPX");
    const row = await env.DB.prepare("SELECT ciphertext FROM app_secrets WHERE name = 'google_client_secret'").first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain("GOCSPX");
    const start = await client({ env: { DATA_ENC_KEY: e.DATA_ENC_KEY } }).request("GET", "/api/auth/google/start");
    expect(new URL(start.headers.get("location")!).searchParams.get("client_id")).toBe(id);
    await env.DB.prepare("DELETE FROM app_secrets WHERE name LIKE 'google_client_%'").run();
  });
});
