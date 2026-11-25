import type { Permission, Role } from "@rayan/shared";

export interface Me {
  user: { id: string; email: string; display_name: string | null };
  roles: Role[];
  permissions: Permission[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Accepts only absolute http(s) URLs; strips trailing slashes. Anything else means "same origin". */
export function normalizeBase(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "";
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

let basePromise: Promise<string> | undefined;

/**
 * API base URL. Order: `apiBaseUrl` in /rayan-config.json (written by the Android/Windows shells),
 * then VITE_API_BASE_URL at build time, else same origin (Cloudflare Pages proxies /api to the Worker).
 */
export function apiBase(): Promise<string> {
  basePromise ??= (async () => {
    try {
      const res = await fetch("/rayan-config.json", { cache: "no-store", credentials: "omit" });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
        const cfg = (await res.json()) as { apiBaseUrl?: unknown };
        const fromCfg = normalizeBase(cfg.apiBaseUrl);
        if (fromCfg) return fromCfg;
      }
    } catch {
      /* optional file */
    }
    return normalizeBase(import.meta.env.VITE_API_BASE_URL);
  })();
  return basePromise;
}

/** JSON client. The session lives in an HttpOnly cookie the browser sends automatically. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  const base = await apiBase();
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      credentials: base ? "include" : "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "unknown", err?.message ?? `خطای ${res.status}`, err?.details);
  }
  return data as T;
}

let meCache: Me | null | undefined;

export async function getMe(force = false): Promise<Me | null> {
  if (meCache !== undefined && !force) return meCache;
  try {
    meCache = await api<Me>("GET", "/me");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) meCache = null;
    else throw e;
  }
  return meCache;
}

export function clearMe() {
  meCache = undefined;
}

export function can(me: Me | null, p: Permission): boolean {
  return !!me?.permissions.includes(p);
}
