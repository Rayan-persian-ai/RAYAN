import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ERRORS_FA } from "@rayan/shared";
import { hitRateLimit } from "../src/lib/ratelimit";
import { client, PASSWORD, registeredClient, uniqueEmail } from "./helpers";

describe("rate limiting (D1-backed)", () => {
  it("fixed window counts and rolls over", async () => {
    const key = `unit:${crypto.randomUUID()}`;
    const t0 = Date.UTC(2031, 0, 1, 0, 0, 5);
    expect((await hitRateLimit(env.DB, key, 2, 60, t0)).allowed).toBe(true);
    expect((await hitRateLimit(env.DB, key, 2, 60, t0 + 1000)).allowed).toBe(true);
    const third = await hitRateLimit(env.DB, key, 2, 60, t0 + 2000);
    expect(third).toMatchObject({ allowed: false, count: 3, limit: 2 });
    expect(third.retryAfterSec).toBe(53);
    expect((await hitRateLimit(env.DB, key, 2, 60, t0 + 60_000)).allowed).toBe(true); // next window
  });

  it("limits auth attempts per IP with 429, Retry-After and a Persian message", async () => {
    const c = client({ env: { RATE_LIMIT_AUTH_PER_MIN: "3" } });
    const body = { email: uniqueEmail(), password: "wrong-password-1" };
    for (let i = 0; i < 3; i++) expect((await c.json("POST", "/api/auth/login", body)).status).toBe(401);
    const blocked = await c.json("POST", "/api/auth/login", body);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.message).toBe(ERRORS_FA.rate_limited);
    expect(Number(blocked.res.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another IP is unaffected.
    const other = client({ env: { RATE_LIMIT_AUTH_PER_MIN: "3" } });
    expect((await other.json("POST", "/api/auth/login", body)).status).toBe(401);
  });

  it("limits login attempts per account across IPs", async () => {
    const { email } = await registeredClient(); // its successful login counts as attempt #1
    const envOver = { RATE_LIMIT_LOGIN_PER_EMAIL_15MIN: "3" };
    expect((await client({ env: envOver }).json("POST", "/api/auth/login", { email, password: "bad-password-1" })).status).toBe(401);
    expect((await client({ env: envOver }).json("POST", "/api/auth/login", { email, password: "bad-password-2" })).status).toBe(401);
    // Even the correct password from a fresh IP is throttled now.
    expect((await client({ env: envOver }).json("POST", "/api/auth/login", { email, password: PASSWORD })).status).toBe(429);
  });

  it("limits chat per user regardless of IP", async () => {
    const { c } = await registeredClient({ env: { RATE_LIMIT_CHAT_PER_MIN: "2", AI_DAILY_LIMIT: "100" } });
    const msg = { messages: [{ role: "user", content: "سلام" }] };
    expect((await c.json("POST", "/api/chat", msg)).status).toBe(200);
    c.ip = "203.0.113.7";
    expect((await c.json("POST", "/api/chat", msg)).status).toBe(200);
    c.ip = "203.0.113.8";
    const r = await c.json("POST", "/api/chat", msg);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("rate_limited");
  });

  it("applies a global per-IP API limit", async () => {
    const c = client({ env: { RATE_LIMIT_API_PER_MIN: "2" } });
    expect((await c.json("GET", "/api/me")).status).toBe(401);
    expect((await c.json("GET", "/api/me")).status).toBe(401);
    expect((await c.json("GET", "/api/me")).status).toBe(429);
    // Health is exempt so monitoring keeps working.
    expect((await c.json("GET", "/api/health")).status).toBe(200);
  });
});
