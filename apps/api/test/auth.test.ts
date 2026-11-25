import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ERRORS_FA } from "@rayan/shared";
import { client, makeDeps, PASSWORD, registeredClient, uniqueEmail } from "./helpers";

describe("auth: signup / login / me / logout", () => {
  it("signs up with a PBKDF2 hash (never plaintext) and the member role", async () => {
    const c = client();
    const email = uniqueEmail();
    const r = await c.json("POST", "/api/auth/signup", { email: email.toUpperCase(), password: PASSWORD });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe(email); // normalised to lower case
    expect(c.cookie).toBeNull(); // signup does not create a session
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email = ?1").bind(email).first<{ password_hash: string }>();
    expect(row!.password_hash).toMatch(/^pbkdf2_sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(row!.password_hash).not.toContain(PASSWORD);
    const roles = await env.DB.prepare("SELECT role FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE u.email = ?1").bind(email).all();
    expect(roles.results).toEqual([{ role: "member" }]);
  });

  it("rejects duplicate emails, bad input and non-JSON bodies with Persian errors", async () => {
    const { email } = await registeredClient();
    const c = client();
    const dup = await c.json("POST", "/api/auth/signup", { email, password: PASSWORD });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: "email_taken", message: ERRORS_FA.email_taken });

    const bad = await c.json("POST", "/api/auth/signup", { email: "not-an-email", password: "short" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_input");
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["email", "password"]);

    const form = await c.json("POST", "/api/auth/signup", "email=a@b.c", { "content-type": "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
  });

  it("logs in with a hardened session cookie and exposes /me", async () => {
    const c = client();
    const email = uniqueEmail();
    await c.json("POST", "/api/auth/signup", { email, password: PASSWORD, display_name: "تیمور" });
    const res = await c.request("POST", "/api/auth/login", { email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-rayan_sid=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");

    const me = await c.json("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email, display_name: "تیمور" });
    expect(me.body.roles).toEqual(["member"]);
    expect(me.body.permissions).toContain("chat:use");
    expect(me.body.permissions).not.toContain("users:manage");

    // The DB stores only a hash of the token.
    const token = c.cookie!.split("=")[1]!;
    const raw = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?1").bind(token).first<{ n: number }>();
    expect(raw!.n).toBe(0);
  });

  it("rejects wrong passwords and unknown emails identically and audits failures", async () => {
    const { email } = await registeredClient();
    const c = client();
    const wrong = await c.json("POST", "/api/auth/login", { email, password: "wrong-password-123" });
    const unknown = await c.json("POST", "/api/auth/login", { email: uniqueEmail("ghost"), password: "wrong-password-123" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.message).toBe(ERRORS_FA.invalid_credentials);
    expect(c.cookie).toBeNull();
    const logs = await env.DB.prepare("SELECT metadata FROM audit_logs WHERE action = 'auth.login.failure' ORDER BY id DESC LIMIT 2").all<{ metadata: string }>();
    expect(logs.results.map((l) => JSON.parse(l.metadata).reason).sort()).toEqual(["bad_password", "unknown_email"]);
  });

  it("logout destroys the session server-side", async () => {
    const { c } = await registeredClient();
    const oldCookie = c.cookie;
    const out = await c.json("POST", "/api/auth/logout", {});
    expect(out.status).toBe(200);
    expect(c.cookie).toBeNull();
    c.cookie = oldCookie; // replaying the old cookie must not work
    expect((await c.json("GET", "/api/me")).status).toBe(401);
  });

  it("requires a session for /me and rejects expired sessions", async () => {
    expect((await client().json("GET", "/api/me")).status).toBe(401);
    let now = Date.now();
    const deps = makeDeps({ now: () => now });
    const { c } = await registeredClient({ deps });
    expect((await c.json("GET", "/api/me")).status).toBe(200);
    now += 169 * 3600_000; // past the 168h TTL
    expect((await c.json("GET", "/api/me")).status).toBe(401);
  });

  it("can disable signup with the signup_enabled feature flag", async () => {
    await env.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'signup_enabled'").run();
    try {
      const r = await client().json("POST", "/api/auth/signup", { email: uniqueEmail(), password: PASSWORD });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("signup_disabled");
    } finally {
      await env.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'signup_enabled'").run();
    }
  });
});

describe("super admin bootstrap", () => {
  it("is granted only after a verified login of OWNER_EMAIL, never at signup or via request data", async () => {
    const owner = uniqueEmail("owner");
    const c = client({ env: { OWNER_EMAIL: owner.toUpperCase() } });
    // Request body tries to smuggle a role — ignored.
    const s = await c.json("POST", "/api/auth/signup", { email: owner, password: PASSWORD, role: "super_admin", roles: ["super_admin"] });
    expect(s.status).toBe(201);
    const before = await env.DB.prepare("SELECT role FROM user_roles WHERE user_id = ?1").bind(s.body.user.id).all();
    expect(before.results).toEqual([{ role: "member" }]);

    // Failed login does not promote.
    expect((await c.json("POST", "/api/auth/login", { email: owner, password: "nope-nope-nope" })).status).toBe(401);
    const still = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ?1 AND role = 'super_admin'").bind(s.body.user.id).first<{ n: number }>();
    expect(still!.n).toBe(0);

    expect((await c.json("POST", "/api/auth/login", { email: owner, password: PASSWORD })).status).toBe(200);
    const me = await c.json("GET", "/api/me");
    expect(me.body.roles).toContain("super_admin");
    expect(me.body.permissions).toContain("users:manage");
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.bootstrap.super_admin' AND target_id = ?1").bind(s.body.user.id).first<{ n: number }>();
    expect(audit!.n).toBe(1);

    // Idempotent: a second login does not log another promotion.
    await c.json("POST", "/api/auth/login", { email: owner, password: PASSWORD });
    const audit2 = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.bootstrap.super_admin' AND target_id = ?1").bind(s.body.user.id).first<{ n: number }>();
    expect(audit2!.n).toBe(1);
  });

  it("does nothing for other emails or when OWNER_EMAIL is unset", async () => {
    const { c } = await registeredClient({ env: { OWNER_EMAIL: "" } });
    expect((await c.json("GET", "/api/me")).body.roles).toEqual(["member"]);
    const { c: c2 } = await registeredClient({ env: { OWNER_EMAIL: "someone-else@rayan.test" } });
    expect((await c2.json("GET", "/api/me")).body.roles).toEqual(["member"]);
  });
});
