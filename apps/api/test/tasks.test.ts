import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AGENT_MANIFESTS } from "@rayan/shared";
import { grantRole, registeredClient } from "./helpers";

describe("task queue API", () => {
  it("create -> get -> list (own) -> cancel -> cannot cancel twice", async () => {
    const { c, userId } = await registeredClient();
    const created = await c.json("POST", "/api/tasks", { type: "echo", payload: { text: "سلام" }, max_attempts: 2 });
    expect(created.status).toBe(201);
    const t = created.body.task;
    expect(t).toMatchObject({ type: "echo", status: "pending", attempts: 0, max_attempts: 2, created_by: userId, payload: { text: "سلام" } });

    expect((await c.json("GET", `/api/tasks/${t.id}`)).body.task.status).toBe("pending");
    const list = await c.json("GET", "/api/tasks");
    expect(list.body.tasks.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect((await c.json("GET", "/api/tasks?status=succeeded")).body.tasks).toEqual([]);

    const cancelled = await c.json("POST", `/api/tasks/${t.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.task.status).toBe("cancelled");
    expect(cancelled.body.task.finished_at).toBeTypeOf("number");
    const again = await c.json("POST", `/api/tasks/${t.id}/cancel`, {});
    expect(again.status).toBe(409);
  });

  it("validates task input", async () => {
    const { c } = await registeredClient();
    expect((await c.json("POST", "/api/tasks", { type: "rm-rf" })).status).toBe(400); // unknown type
    expect((await c.json("POST", "/api/tasks", { type: "echo", max_attempts: 50 })).status).toBe(400);
    expect((await c.json("POST", "/api/tasks", { type: "Bad Type!" })).status).toBe(400);
    expect((await c.json("POST", "/api/tasks", { type: "echo", agent_slug: "nobody" })).status).toBe(400);
    expect((await c.json("GET", "/api/tasks?status=weird")).status).toBe(400);
  });

  it("isolates tasks between members; admins see all", async () => {
    const { c: alice } = await registeredClient();
    const { c: bob } = await registeredClient();
    const t = (await alice.json("POST", "/api/tasks", { type: "echo", payload: {} })).body.task;
    expect((await bob.json("GET", `/api/tasks/${t.id}`)).status).toBe(404);
    expect((await bob.json("POST", `/api/tasks/${t.id}/cancel`, {})).status).toBe(404);
    expect((await bob.json("GET", "/api/tasks")).body.tasks).toEqual([]);

    const { c: admin, userId } = await registeredClient();
    await grantRole(userId, "admin");
    expect((await admin.json("GET", `/api/tasks/${t.id}`)).status).toBe(200);
    const all = await admin.json("GET", "/api/tasks?scope=all&limit=100");
    expect(all.body.tasks.some((x: { id: string }) => x.id === t.id)).toBe(true);
    expect((await admin.json("POST", `/api/tasks/${t.id}/cancel`, {})).body.task.status).toBe("cancelled");
    const audit = await env.DB.prepare("SELECT actor_user_id FROM audit_logs WHERE action = 'task.cancel' AND target_id = ?1").bind(t.id).first<{ actor_user_id: string }>();
    expect(audit!.actor_user_id).toBe(userId);
  });

  it("refuses tasks for disabled agents and accepts enabled ones", async () => {
    const { c } = await registeredClient();
    const enabled = AGENT_MANIFESTS.find((m) => m.enabled)!;
    const disabled = AGENT_MANIFESTS.find((m) => !m.enabled)!;
    expect((await c.json("POST", "/api/tasks", { type: "echo", agent_slug: enabled.slug })).status).toBe(201);
    const r = await c.json("POST", "/api/tasks", { type: "echo", agent_slug: disabled.slug });
    expect(r.status).toBe(409);
  });
});

describe("agent registry", () => {
  it("is seeded with the 20 shared manifests (Persian names, scoped permissions)", async () => {
    const { c } = await registeredClient();
    const r = await c.json("GET", "/api/agents");
    expect(r.status).toBe(200);
    expect(r.body.agents).toHaveLength(20);
    const bySlug = new Map(r.body.agents.map((a: { slug: string }) => [a.slug, a]));
    for (const m of AGENT_MANIFESTS) {
      expect(bySlug.get(m.slug)).toMatchObject({ name_fa: m.name_fa, permissions: m.permissions, version: m.version });
    }
  });

  it("sync preserves admin enable/disable choices", async () => {
    const { c, userId } = await registeredClient();
    await grantRole(userId, "admin");
    await c.json("PATCH", "/api/agents/sales", { enabled: true });
    const s = await c.json("POST", "/api/agents/sync", {});
    expect(s.body.synced).toBe(20);
    const row = await env.DB.prepare("SELECT enabled FROM agents WHERE slug = 'sales'").first<{ enabled: number }>();
    expect(row!.enabled).toBe(1);
    await c.json("PATCH", "/api/agents/sales", { enabled: false });
  });
});
