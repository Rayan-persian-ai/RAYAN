import { describe, expect, it } from "vitest";
import { AiRouter, ProviderError, stringEnv, workersAiBindingProvider, workersProvidersFromEnv } from "../src/index";

const FA = "سلام! من رایان هستم.";
const user = (content: string) => [{ role: "user" as const, content }];
const signal = new AbortController().signal;

describe("workers chain", () => {
  it("orders workers-ai -> pollinations -> keyed providers, never local", () => {
    const ai = { run: async () => ({ response: FA }) };
    expect(workersProvidersFromEnv({}, { ai }).map((p) => p.id)).toEqual(["workers-ai", "pollinations"]);
    const ids = workersProvidersFromEnv({ GROQ_API_KEY: "k", HF_TOKEN: "h", LOCAL_LLM_ENABLED: "true" }, { ai }).map((p) => p.id);
    expect(ids).toEqual(["workers-ai", "pollinations", "hf-router", "groq"]);
    expect(ids).not.toContain("local");
    expect(workersProvidersFromEnv({ AI_DISABLE: "pollinations" }, {}).map((p) => p.id)).toEqual([]);
  });

  it("binding provider maps 4006 to quota and other errors to server", async () => {
    const q = workersAiBindingProvider({ run: async () => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); } })!;
    await expect(q.chat(user("سلام"), { maxTokens: 10, signal })).rejects.toMatchObject({ kind: "quota" });
    const s = workersAiBindingProvider({ run: async () => { throw new Error("boom"); } })!;
    await expect(s.chat(user("سلام"), { maxTokens: 10, signal })).rejects.toBeInstanceOf(ProviderError);
    await expect(s.chat(user("سلام"), { maxTokens: 10, signal })).rejects.toMatchObject({ kind: "server" });
    const ok = workersAiBindingProvider({ run: async (_m, i) => ({ response: `${FA} ${(i.messages as unknown[]).length}` }) }, { AI_MODEL: "@cf/x" })!;
    expect(ok.model).toBe("@cf/x");
    expect(await ok.chat(user("سلام"), { maxTokens: 10, signal })).toContain("رایان");
  });

  it("falls back to pollinations (stubbed fetch) when workers-ai quota is used up", async () => {
    const ai = { run: async () => { throw new Error("4006 daily free allocation"); } };
    const fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: FA } }] }), { status: 200 });
    const router = new AiRouter({ providers: workersProvidersFromEnv({}, { ai, fetch }) });
    const r = await router.chat(user("سلام"));
    expect(r.provider).toBe("pollinations");
    expect(r.attempts.map((a) => a.outcome)).toEqual(["failed", "ok"]);
  });

  it("stringEnv drops bindings", () => {
    expect(stringEnv({ A: "1", DB: {}, AI: { run() {} }, N: 3 })).toEqual({ A: "1" });
  });
});
