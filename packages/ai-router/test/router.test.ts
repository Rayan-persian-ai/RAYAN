import { describe, expect, it, vi } from "vitest";
import {
  AiRouter,
  AllProvidersFailedError,
  ProviderError,
  cleanOutput,
  httpError,
  isMostlyPersian,
  providersFromEnv,
  wantsPersian,
  withPersianInstruction,
  type Provider,
} from "../src/index";

const FA = "سلام، پایتخت ایران تهران است.";
const user = (content: string) => [{ role: "user" as const, content }];

function fake(id: string, impl: (n: number) => string | Promise<string>, extra: Partial<Provider> = {}): Provider & { calls: number } {
  const p: Provider & { calls: number } = {
    id,
    label: id,
    model: `${id}-model`,
    dailyCap: 0,
    minIntervalMs: 0,
    timeoutMs: 1_000,
    calls: 0,
    async chat(): Promise<string> {
      p.calls++;
      return impl(p.calls);
    },
    ...extra,
  };
  return p;
}
const fail = (kind: ProviderError["kind"], status?: number, retry?: number) => () => {
  throw new ProviderError(`${kind}`, kind, status, retry);
};

function clock(start = Date.UTC(2026, 10, 25, 12)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("persian helpers", () => {
  it("detects Persian vs English", () => {
    expect(isMostlyPersian(FA)).toBe(true);
    expect(isMostlyPersian("Hello, the capital is Tehran.")).toBe(false);
    expect(wantsPersian("سلام چطوری؟")).toBe(true);
    expect(wantsPersian("hello there")).toBe(false);
    expect(wantsPersian("لطفاً به انگلیسی جواب بده")).toBe(false);
    expect(wantsPersian("یک تابع python بنویس که sort کند")).toBe(true);
  });
  it("strips think blocks", () => {
    expect(cleanOutput("<think>reasoning</think>\n" + FA)).toBe(FA);
    expect(cleanOutput("<think>never ends")).toBe("");
  });
  it("adds the Persian instruction once", () => {
    const a = withPersianInstruction([{ role: "system", content: "x" }, ...user("سلام")]);
    expect(a[0]!.content).toContain("فارسی");
    expect(withPersianInstruction(a)).toBe(a);
    expect(withPersianInstruction(user("سلام"))[0]!.role).toBe("system");
  });
});

describe("AiRouter chain", () => {
  it("uses the first healthy provider", async () => {
    const a = fake("a", () => FA);
    const b = fake("b", () => FA);
    const r = await new AiRouter({ providers: [a, b] }).chat(user("سلام"));
    expect(r.provider).toBe("a");
    expect(b.calls).toBe(0);
  });

  it("falls through quota (402) and rate (429) errors to the local last resort", async () => {
    const c = clock();
    const hf = fake("hf", fail("quota", 402, 6 * 3600_000));
    const pol = fake("pol", fail("rate", 429));
    const local = fake("local", () => FA, { lastResort: true });
    const router = new AiRouter({ providers: [local, hf, pol], now: c.now });
    const r = await router.chat(user("سلام"));
    expect(r.provider).toBe("local");
    expect(r.attempts.map((x) => x.outcome)).toEqual(["failed", "failed", "ok"]);
    // second call: hf is quota-exhausted and pol is cooling down -> skipped without calling
    await router.chat(user("سلام"));
    expect(hf.calls).toBe(1);
    expect(pol.calls).toBe(1);
    const st = router.status().providers.find((p) => p.id === "hf")!;
    expect(st.skipReason).toBe("quota_exhausted");
    c.advance(6 * 3600_000 + 1);
    expect(router.status().providers.find((p) => p.id === "hf")!.skipReason).toBeNull();
  });

  it("quota without Retry-After lasts until next UTC midnight", async () => {
    const c = clock(Date.UTC(2026, 10, 25, 23, 0));
    const a = fake("a", fail("quota", 429));
    const local = fake("local", () => FA, { lastResort: true });
    const router = new AiRouter({ providers: [a, local], now: c.now });
    await router.chat(user("سلام"));
    expect(router.status().providers[0]!.exhaustedUntil).toBe(Date.UTC(2026, 10, 26));
  });

  it("opens the circuit after N transient failures, half-opens after cooldown, closes on success", async () => {
    const c = clock();
    let healthy = false;
    const a = fake("a", () => {
      if (!healthy) throw new ProviderError("boom", "server", 500);
      return FA;
    });
    const local = fake("local", () => FA, { lastResort: true });
    const router = new AiRouter({ providers: [a, local], now: c.now, failureThreshold: 2, baseCooldownMs: 10_000 });
    await router.chat(user("سلام"));
    await router.chat(user("سلام"));
    expect(router.status().providers[0]!.breaker).toBe("open");
    await router.chat(user("سلام"));
    expect(a.calls).toBe(2); // skipped while open
    c.advance(10_001);
    healthy = true;
    const r = await router.chat(user("سلام"));
    expect(r.provider).toBe("a");
    expect(router.status().providers[0]!.breaker).toBe("closed");
  });

  it("re-trips with doubled cooldown when the half-open trial fails", async () => {
    const c = clock();
    const a = fake("a", fail("server", 503));
    const local = fake("local", () => FA, { lastResort: true });
    const router = new AiRouter({ providers: [a, local], now: c.now, failureThreshold: 1, baseCooldownMs: 1_000 });
    await router.chat(user("سلام"));
    c.advance(1_001);
    await router.chat(user("سلام")); // half-open trial fails
    const s = router.snapshot().stats.a!;
    expect(s.breaker).toBe("open");
    expect(s.openUntil - c.now()).toBe(2_000);
  });

  it("enforces per-provider daily caps and resets them at UTC midnight", async () => {
    const c = clock(Date.UTC(2026, 10, 25, 22));
    const a = fake("a", () => FA, { dailyCap: 2 });
    const local = fake("local", () => FA, { lastResort: true });
    const router = new AiRouter({ providers: [a, local], now: c.now });
    for (let i = 0; i < 3; i++) await router.chat(user("سلام"));
    expect(a.calls).toBe(2);
    expect(local.calls).toBe(1);
    c.advance(3 * 3600_000); // next UTC day
    expect((await router.chat(user("سلام"))).provider).toBe("a");
  });

  it("respects a provider's minimum interval (politeness / free-tier terms)", async () => {
    const c = clock();
    const pol = fake("pol", () => FA, { minIntervalMs: 15_000 });
    const local = fake("local", () => FA, { lastResort: true });
    const router = new AiRouter({ providers: [pol, local], now: c.now });
    expect((await router.chat(user("سلام"))).provider).toBe("pol");
    expect((await router.chat(user("سلام"))).provider).toBe("local");
    c.advance(15_000);
    expect((await router.chat(user("سلام"))).provider).toBe("pol");
  });

  it("skips a provider whose answer is not Persian, but keeps it as a last candidate", async () => {
    const en = fake("en", () => "The capital of Iran is Tehran.");
    const fa = fake("fa", () => FA);
    expect((await new AiRouter({ providers: [en, fa] }).chat(user("پایتخت ایران؟"))).provider).toBe("fa");
    const only = await new AiRouter({ providers: [fake("en2", () => "Tehran.")] }).chat(user("پایتخت ایران؟"));
    expect(only.provider).toBe("en2");
    expect(only.attempts[0]!.outcome).toBe("non_persian");
    // English request -> English accepted
    expect((await new AiRouter({ providers: [en, fa] }).chat(user("capital of Iran?"))).provider).toBe("en");
  });

  it("local last resort ignores caps/breaker but waits for readiness", async () => {
    const local = fake("local", () => FA, { lastResort: true, dailyCap: 1, ready: async () => false });
    const router = new AiRouter({ providers: [local] });
    await expect(router.chat(user("سلام"))).rejects.toBeInstanceOf(AllProvidersFailedError);
    const ok = fake("local", () => FA, { lastResort: true, dailyCap: 1 });
    const r2 = new AiRouter({ providers: [ok] });
    for (let i = 0; i < 5; i++) expect((await r2.chat(user("سلام"))).provider).toBe("local");
  });

  it("times out slow providers", async () => {
    const slow = fake("slow", () => new Promise<string>(() => {}), { timeoutMs: 30 });
    slow.chat = (_m, o) =>
      new Promise<string>((_r, rej) => o.signal.addEventListener("abort", () => rej(o.signal.reason)));
    const local = fake("local", () => FA, { lastResort: true });
    const r = await new AiRouter({ providers: [slow, local] }).chat(user("سلام"));
    expect(r.provider).toBe("local");
    expect(r.attempts[0]!.reason).toMatch(/^timeout/);
  });

  it("disables a provider for an hour on auth errors", async () => {
    const c = clock();
    const a = fake("a", fail("auth", 401));
    const local = fake("local", () => FA, { lastResort: true });
    const router = new AiRouter({ providers: [a, local], now: c.now });
    await router.chat(user("سلام"));
    expect(router.status().providers[0]!.skipReason).toBe("auth_disabled");
    c.advance(3600_001);
    expect(router.status().providers[0]!.skipReason).toBeNull();
  });

  it("snapshot/restore keeps counters across restarts", async () => {
    const c = clock();
    const mk = () => [fake("a", () => FA, { dailyCap: 1 }), fake("local", () => FA, { lastResort: true })];
    const r1 = new AiRouter({ providers: mk(), now: c.now });
    await r1.chat(user("سلام"));
    const r2 = new AiRouter({ providers: mk(), now: c.now });
    r2.restore(JSON.parse(JSON.stringify(r1.snapshot())));
    expect((await r2.chat(user("سلام"))).provider).toBe("local");
  });
});

describe("http error mapping", () => {
  it("maps statuses to failure kinds", async () => {
    expect((await httpError(new Response("x", { status: 402 }), "p")).kind).toBe("quota");
    expect((await httpError(new Response("Rate limit", { status: 429, headers: { "retry-after": "7" } }), "p")).retryAfterMs).toBe(7000);
    expect((await httpError(new Response("Rate limit", { status: 429 }), "p")).kind).toBe("rate");
    expect((await httpError(new Response("daily quota exceeded", { status: 429 }), "p")).kind).toBe("quota");
    expect((await httpError(new Response("", { status: 401 }), "p")).kind).toBe("auth");
    expect((await httpError(new Response("", { status: 503 }), "p")).kind).toBe("server");
  });
});

describe("providersFromEnv", () => {
  it("builds the documented order and only enables keyed providers with keys", () => {
    const ids = providersFromEnv({ HF_TOKEN: "x", GROQ_API_KEY: "g", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }).map((p) => p.id);
    expect(ids).toEqual(["cloudflare", "hf-router", "pollinations", "groq", "local"]);
    expect(providersFromEnv({}).map((p) => p.id)).toEqual(["pollinations", "local"]);
  });
  it("supports AI_DISABLE, AI_PROVIDER_ORDER and caps from env", () => {
    const ps = providersFromEnv({ HF_TOKEN: "x", AI_DISABLE: "pollinations", AI_PROVIDER_ORDER: "local,hf-router", HF_ROUTER_DAILY_CAP: "7" });
    expect(ps.map((p) => p.id)).toEqual(["local", "hf-router"]);
    expect(ps.find((p) => p.id === "hf-router")!.dailyCap).toBe(7);
  });
  it("refuses non-free OpenRouter models", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(providersFromEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "openai/gpt-4o" }).map((p) => p.id)).not.toContain("openrouter");
    expect(providersFromEnv({ OPENROUTER_API_KEY: "k" }).map((p) => p.id)).toContain("openrouter");
    warn.mockRestore();
  });
  it("sends OpenAI-compatible requests and parses responses (fetch stubbed)", async () => {
    const seen: Array<{ url: string; body: any; auth: string | null }> = [];
    const f = async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ choices: [{ message: { content: FA } }] });
    };
    const [hf] = providersFromEnv({ HF_TOKEN: "tok", POLLINATIONS_ENABLED: "false", LOCAL_LLM_ENABLED: "false" }, { fetch: f });
    const out = await hf!.chat(user("سلام"), { maxTokens: 50, signal: new AbortController().signal });
    expect(out).toBe(FA);
    expect(seen[0]!.url).toBe("https://router.huggingface.co/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer tok");
    expect(seen[0]!.body.max_tokens).toBe(50);
  });
  it("cloudflare REST: parses result.response and maps 4006 to quota", async () => {
    let mode = 0;
    const f = async () =>
      mode === 0
        ? Response.json({ success: true, result: { response: FA } })
        : Response.json({ success: false, errors: [{ code: 4006, message: "you have used up your daily free allocation" }] });
    const [cf] = providersFromEnv({ CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t", POLLINATIONS_ENABLED: "0", LOCAL_LLM_ENABLED: "0" }, { fetch: f as never });
    const sig = new AbortController().signal;
    expect(await cf!.chat(user("سلام"), { maxTokens: 10, signal: sig })).toBe(FA);
    mode = 1;
    await expect(cf!.chat(user("سلام"), { maxTokens: 10, signal: sig })).rejects.toMatchObject({ kind: "quota" });
  });
});

describe("readiness wait", () => {
  it("waits for a loading local model up to readyWaitMs", async () => {
    let n = 0;
    const local = fake("local", () => FA, { lastResort: true, readyWaitMs: 3_000, ready: async () => ++n >= 2 });
    const r = await new AiRouter({ providers: [local] }).chat(user("سلام"));
    expect(r.provider).toBe("local");
    expect(n).toBe(2);
  });
});
