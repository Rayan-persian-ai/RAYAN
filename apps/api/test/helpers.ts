import { createExecutionContext, env as baseEnv, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import { createApp } from "../src/app";
import { defaultTaskHandlers } from "../src/cron/handlers";
import type { AiProvider, AppDeps, ChatTurn } from "../src/deps";
import type { Env } from "../src/env";

export const ORIGIN = "https://app.rayan.test";
export const PASSWORD = "correct-horse-battery";

/** Offline mock of the LLM: records calls, echoes the last user turn in Persian. */
export function mockAi(opts: { fail?: boolean } = {}) {
  const calls: ChatTurn[][] = [];
  const provider: AiProvider = {
    name: "mock",
    isAvailable: () => true,
    async chat(_env, messages) {
      calls.push(messages);
      if (opts.fail) throw new Error("mock failure");
      return `پاسخ آزمایشی: ${messages.at(-1)?.content ?? ""}`;
    },
  };
  return { provider, calls };
}

export function makeDeps(over: Partial<AppDeps> = {}): AppDeps {
  return { ai: mockAi().provider, taskHandlers: defaultTaskHandlers, now: () => Date.now(), ...over };
}

let ipCounter = 0;
/** Unique client IP per test client so IP-based limits don't bleed between tests. */
export function freshIp() {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

let emailCounter = 0;
export function uniqueEmail(prefix = "user") {
  emailCounter++;
  return `${prefix}.${Date.now()}.${emailCounter}@rayan.test`;
}

export interface Client {
  env: Env;
  ip: string;
  cookie: string | null;
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; res: Response }>;
}

export function client(opts: { deps?: AppDeps; env?: Partial<Env>; ip?: string } = {}): Client {
  const app = createApp(opts.deps ?? makeDeps());
  const env = { ...(baseEnv as unknown as Env), ...opts.env } as Env;
  const c: Client = {
    env,
    ip: opts.ip ?? freshIp(),
    cookie: null,
    async request(method, path, body, headers = {}) {
      const h: Record<string, string> = { "cf-connecting-ip": c.ip, ...headers };
      if (body !== undefined) h["content-type"] ??= "application/json";
      if (c.cookie) h.cookie = c.cookie;
      const req = new Request(`https://api.rayan.test${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const ctx = createExecutionContext();
      const res = await app.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      const set = res.headers.get("set-cookie");
      if (set) {
        const first = set.split(";")[0]!;
        const [name, value] = first.split("=");
        c.cookie = value ? `${name}=${value}` : null;
      }
      return res;
    },
    async json(method, path, body, headers) {
      const res = await c.request(method, path, body, headers);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, res };
    },
  };
  return c;
}

/** Signs up and logs in a fresh account; returns the logged-in client. */
export async function registeredClient(opts: Parameters<typeof client>[0] & { email?: string } = {}) {
  const c = client(opts);
  const email = opts.email ?? uniqueEmail();
  const s = await c.json("POST", "/api/auth/signup", { email, password: PASSWORD });
  expect(s.status).toBe(201);
  const l = await c.json("POST", "/api/auth/login", { email, password: PASSWORD });
  expect(l.status).toBe(200);
  expect(c.cookie).toBeTruthy();
  return { c, email, userId: l.body.user.id as string };
}

/** Grants a role directly in the DB (test fixture only — the API never allows granting super_admin). */
export async function grantRole(userId: string, role: "admin" | "super_admin" | "member") {
  await baseEnv.DB.prepare("INSERT OR IGNORE INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?1, ?2, 'test', ?3)")
    .bind(userId, role, Date.now())
    .run();
}
