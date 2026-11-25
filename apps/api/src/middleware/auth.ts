import type { MiddlewareHandler } from "hono";
import type { Permission } from "@rayan/shared";
import { intVar, type AppEnv } from "../env";
import { errorBody } from "../lib/errors";
import { hitRateLimit } from "../lib/ratelimit";
import { clientIp } from "../lib/request";
import { loadAuth } from "../lib/session";

/** Attaches c.var.auth (or null). Never rejects on its own. */
export const sessionLoader: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("auth", await loadAuth(c));
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.auth) return c.json(errorBody("unauthorized"), 401);
  await next();
};

/** RBAC gate: the caller must hold *every* listed permission (via any of their roles). */
export function requirePermission(...perms: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.var.auth;
    if (!auth) return c.json(errorBody("unauthorized"), 401);
    if (!perms.every((p) => auth.permissions.has(p))) return c.json(errorBody("forbidden"), 403);
    await next();
  };
}

type KeyFn = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string | null;

/** D1-backed fixed-window rate limit. `limitVar` picks the env var holding the limit. */
export function rateLimit(opts: {
  name: string;
  key: KeyFn;
  limit: (env: AppEnv["Bindings"]) => number;
  windowSec: number;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const k = opts.key(c);
    if (k) {
      const res = await hitRateLimit(c.env.DB, `${opts.name}:${k}`, opts.limit(c.env), opts.windowSec, c.var.deps.now());
      c.header("X-RateLimit-Limit", String(res.limit));
      c.header("X-RateLimit-Remaining", String(Math.max(0, res.limit - res.count)));
      if (!res.allowed) {
        c.header("Retry-After", String(res.retryAfterSec));
        return c.json(errorBody("rate_limited"), 429);
      }
    }
    await next();
  };
}

export const ipKey: KeyFn = (c) => clientIp(c);
export const userKey: KeyFn = (c) => c.var.auth?.user.id ?? null;

export const apiIpLimit = rateLimit({
  name: "api-ip",
  key: ipKey,
  limit: (env) => intVar(env.RATE_LIMIT_API_PER_MIN, 120),
  windowSec: 60,
});
export const authIpLimit = rateLimit({
  name: "auth-ip",
  key: ipKey,
  limit: (env) => intVar(env.RATE_LIMIT_AUTH_PER_MIN, 10),
  windowSec: 60,
});
export const chatUserLimit = rateLimit({
  name: "chat-user",
  key: userKey,
  limit: (env) => intVar(env.RATE_LIMIT_CHAT_PER_MIN, 10),
  windowSec: 60,
});
