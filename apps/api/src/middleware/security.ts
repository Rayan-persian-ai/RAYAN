import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "../env";
import { errorBody } from "../lib/errors";

/** Origins of the packaged app shells: Android (Capacitor, androidScheme https) and Windows (Tauri). */
export const APP_SHELL_ORIGINS = ["https://localhost", "http://tauri.localhost"] as const;

export function allowedOrigins(env: Env): string[] {
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...configured, ...APP_SHELL_ORIGINS])];
}

/** Strict headers for a JSON-only API. */
export const securityHeaders = secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
  strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
  xFrameOptions: "DENY",
  referrerPolicy: "no-referrer",
  crossOriginResourcePolicy: "same-site",
  crossOriginOpenerPolicy: "same-origin",
  permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
});

/** CORS locked to the configured origin list; credentials allowed only for those origins. */
export const corsMiddleware: MiddlewareHandler<AppEnv> = (c, next) =>
  cors({
    origin: (origin) => (allowedOrigins(c.env).includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 600,
  })(c, next);

/**
 * CSRF defence in depth (cookies are SameSite=Lax and bodies must be JSON):
 * any state-changing request that carries an Origin header must come from an allowed origin.
 */
export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins(c.env).includes(origin)) {
      return c.json(errorBody("origin_not_allowed"), 403);
    }
  }
  await next();
};

export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (!c.res.headers.get("cache-control")?.startsWith("private")) c.header("Cache-Control", "no-store");
};
