import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createChainProvider, serviceFor } from "../src/lib/ai-chain";
import { AI_SERVICE } from "../src/lib/cost";
import { makeDeps, registeredClient } from "./helpers";

const msg = (content = "سلام رایان") => ({ messages: [{ role: "user", content }] });
let dayOffset = 0;
/** Own UTC day per test (far from cost.test's days) so usage counters don't leak. */
const testDay = () => Date.UTC(2040, 0, 1 + ++dayOffset * 10, 12);

function fakeAi(opts: { fail?: string } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    binding: {
      async run(model: string, inputs: Record<string, unknown>) {
        calls.push({ model, inputs });
        if (opts.fail) throw new Error(opts.fail);
        return { response: "سلام! من رایان هستم، از Workers AI." };
      },
    },
  };
}

function fakeFetch() {
  const urls: string[] = [];
  const f = async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: "پاسخ از Pollinations به فارسی." } }] }), { status: 200 });
  };
  return { urls, f };
}

const chainEnv = (ai: unknown, extra: Record<string, string> = {}) => ({
  AI: ai as Ai,
  POLLINATIONS_MIN_INTERVAL_MS: "0",
  POLLINATIONS_DAILY_CAP: "2",
  ...extra,
});

describe("multi-provider AI chain (Workers AI -> Pollinations -> keyed)", () => {
  it("serves from Workers AI first and charges the workers_ai counter", async () => {
    const now = testDay();
    const ai = fakeAi();
    const net = fakeFetch();
    const deps = makeDeps({ ai: createChainProvider({ fetch: net.f, now: () => now, log: () => {} }), now: () => now });
    const { c } = await registeredClient({ deps, env: chainEnv(ai.binding) });
    const r = await c.json("POST", "/api/chat", msg());
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("workers-ai");
    expect(r.body.reply).toContain("رایان");
    expect(r.body.usage).toMatchObject({ used: 1, limit: 3 });
    expect(net.urls).toHaveLength(0);
  });

  it("falls through to Pollinations once the Workers AI daily cap is used, then 429 when all are capped", async () => {
    const now = testDay();
    const ai = fakeAi();
    const net = fakeFetch();
    const deps = makeDeps({ ai: createChainProvider({ fetch: net.f, now: () => now, log: () => {} }), now: () => now });
    const { c } = await registeredClient({ deps, env: chainEnv(ai.binding) });
    for (let i = 0; i < 3; i++) expect((await c.json("POST", "/api/chat", msg())).body.provider).toBe("workers-ai");
    expect(ai.calls).toHaveLength(3);
    for (let i = 0; i < 2; i++) {
      const r = await c.json("POST", "/api/chat", msg());
      expect(r.status).toBe(200);
      expect(r.body.provider).toBe("pollinations");
    }
    expect(ai.calls).toHaveLength(3); // Workers AI never called past its cap (protects the 10k neurons/day)
    expect(net.urls[0]).toContain("pollinations");
    const capped = await c.json("POST", "/api/chat", msg());
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("daily_cap_reached");
    const day = new Date(now).toISOString().slice(0, 10);
    const row = await env.DB.prepare("SELECT count FROM usage_counters WHERE service = ?1 AND day = ?2")
      .bind(serviceFor("pollinations"), day)
      .first<{ count: number }>();
    expect(row?.count).toBe(2);
    expect(serviceFor("workers-ai")).toBe(AI_SERVICE);
  });

  it("falls through on a Workers AI 4006 (neurons used up) error", async () => {
    const now = testDay();
    const ai = fakeAi({ fail: "4006: you have used up your daily free allocation of 10,000 neurons" });
    const net = fakeFetch();
    const deps = makeDeps({ ai: createChainProvider({ fetch: net.f, now: () => now, log: () => {} }), now: () => now });
    const { c } = await registeredClient({ deps, env: chainEnv(ai.binding) });
    const r = await c.json("POST", "/api/chat", msg());
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe("pollinations");
  });

  it("kill switch still stops the whole chain (503)", async () => {
    const now = testDay();
    const ai = fakeAi();
    const deps = makeDeps({ ai: createChainProvider({ fetch: fakeFetch().f, now: () => now, log: () => {} }), now: () => now });
    const { c } = await registeredClient({ deps, env: chainEnv(ai.binding) });
    await env.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'ai_enabled'").run();
    try {
      const r = await c.json("POST", "/api/chat", msg());
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("ai_disabled");
      expect(ai.calls).toHaveLength(0);
    } finally {
      await env.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'ai_enabled'").run();
    }
  });

  it("only enables keyed providers whose secret exists; never a local model", () => {
    const chain = createChainProvider();
    const base = { ...(env as unknown as Record<string, unknown>), AI: fakeAi().binding } as never;
    expect(chain.providerIds(base)).toEqual(["workers-ai", "pollinations"]);
    expect(chain.providerIds({ ...(base as object), GROQ_API_KEY: "x" } as never)).toEqual(["workers-ai", "pollinations", "groq"]);
  });
});
