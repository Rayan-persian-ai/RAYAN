import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ERRORS_FA, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "@rayan/shared";
import { client, grantRole, ORIGIN, registeredClient } from "./helpers";

describe("RBAC", () => {
  it("D1 role_permissions match the shared catalogue exactly", async () => {
    const { results } = await env.DB.prepare("SELECT role, permission FROM role_permissions").all<{ role: string; permission: string }>();
    for (const role of ROLES) {
      const db = results.filter((r) => r.role === role).map((r) => r.permission).sort();
      expect(db).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
    const perms = await env.DB.prepare("SELECT name FROM permissions").all<{ name: string }>();
    expect(perms.results.map((p) => p.name).sort()).toEqual([...PERMISSIONS].sort());
  });

  it("anonymous callers get 401 on protected routes", async () => {
    const c = client();
    for (const [m, p] of [
      ["GET", "/api/admin/users"],
      ["GET", "/api/agents"],
      ["POST", "/api/chat"],
      ["GET", "/api/tasks"],
    ] as const) {
      const r = await c.json(m, p, m === "POST" ? { messages: [{ role: "user", content: "سلام" }] } : undefined);
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.body.error.message).toBe(ERRORS_FA.unauthorized);
    }
  });

  it("members are denied admin endpoints with 403 and a Persian message", async () => {
    const { c } = await registeredClient();
    const denied: [string, string, unknown?][] = [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/audit"],
      ["GET", "/api/admin/usage"],
      ["PUT", "/api/admin/usage/workers_ai", { limit: 999 }],
      ["PUT", "/api/admin/flags/ai_enabled", { enabled: false }],
      ["PATCH", "/api/agents/ai-ceo", { enabled: false }],
      ["POST", "/api/agents/sync", {}],
      ["GET", "/api/tasks?scope=all"],
    ];
    for (const [m, p, b] of denied) {
      const r = await c.json(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.error).toMatchObject({ code: "forbidden", message: ERRORS_FA.forbidden });
    }
    // ...but can read agents
    expect((await c.json("GET", "/api/agents")).status).toBe(200);
    // and nothing changed
    const agent = await env.DB.prepare("SELECT enabled FROM agents WHERE slug = 'ai-ceo'").first<{ enabled: number }>();
    expect(agent!.enabled).toBe(1);
  });

  it("admins can manage agents and read users/audit but cannot manage roles, caps or flags", async () => {
    const { c, userId } = await registeredClient();
    await grantRole(userId, "admin");
    expect((await c.json("GET", "/api/admin/users")).status).toBe(200);
    expect((await c.json("GET", "/api/admin/audit")).status).toBe(200);
    const toggled = await c.json("PATCH", "/api/agents/hr", { enabled: true });
    expect(toggled.status).toBe(200);
    expect(toggled.body.agent).toMatchObject({ slug: "hr", enabled: true });
    expect((await c.json("PATCH", "/api/agents/hr", { enabled: false })).body.agent.enabled).toBe(false);
    expect((await c.json("PATCH", "/api/agents/no-such-agent", { enabled: true })).status).toBe(404);

    const { userId: other } = await registeredClient();
    expect((await c.json("POST", `/api/admin/users/${other}/roles`, { role: "admin", action: "grant" })).status).toBe(403);
    expect((await c.json("PUT", "/api/admin/usage/workers_ai", { limit: 5 })).status).toBe(403);
    expect((await c.json("PUT", "/api/admin/flags/ai_enabled", { enabled: false })).status).toBe(403);

    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_user_id = ?1 AND action LIKE 'admin.agent.%'").bind(userId).first<{ n: number }>();
    expect(log!.n).toBe(2);
  });

  it("super_admin can grant/revoke admin but never super_admin, and not on itself", async () => {
    const { c, userId } = await registeredClient();
    await grantRole(userId, "super_admin");
    const { userId: target, c: targetClient } = await registeredClient();

    const g = await c.json("POST", `/api/admin/users/${target}/roles`, { role: "admin", action: "grant" });
    expect(g.status).toBe(200);
    expect(g.body.roles).toEqual(["admin", "member"]);
    expect((await targetClient.json("GET", "/api/admin/users")).status).toBe(200);

    const sa = await c.json("POST", `/api/admin/users/${target}/roles`, { role: "super_admin", action: "grant" });
    expect(sa.status).toBe(400);
    expect((await c.json("POST", `/api/admin/users/${userId}/roles`, { role: "admin", action: "revoke" })).status).toBe(409);

    const r = await c.json("POST", `/api/admin/users/${target}/roles`, { role: "admin", action: "revoke" });
    expect(r.body.roles).toEqual(["member"]);
    expect((await targetClient.json("GET", "/api/admin/users")).status).toBe(403);

    const actions = await env.DB.prepare("SELECT action FROM audit_logs WHERE actor_user_id = ?1 AND action LIKE 'admin.role.%' ORDER BY id").bind(userId).all<{ action: string }>();
    expect(actions.results.map((a) => a.action)).toEqual(["admin.role.grant", "admin.role.revoke"]);
  });
});

describe("security headers, CORS and origin guard", () => {
  it("sets strict security headers on API responses", async () => {
    const res = await client().request("GET", "/api/health");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("CORS only reflects the configured origin", async () => {
    const c = client();
    const ok = await c.request("OPTIONS", "/api/auth/login", undefined, { origin: ORIGIN, "access-control-request-method": "POST" });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const evil = await c.request("OPTIONS", "/api/auth/login", undefined, { origin: "https://evil.example", "access-control-request-method": "POST" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects state-changing requests from foreign origins (CSRF guard)", async () => {
    const { c } = await registeredClient();
    const r = await c.json("POST", "/api/tasks", { type: "echo", payload: {} }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("origin_not_allowed");
    const ok = await c.json("POST", "/api/tasks", { type: "echo", payload: {} }, { origin: ORIGIN });
    expect(ok.status).toBe(201);
  });

  it("unknown routes return a JSON 404", async () => {
    const r = await client().json("GET", "/api/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });
});
