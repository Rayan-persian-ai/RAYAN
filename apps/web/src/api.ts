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

/** Same-origin JSON client. The session lives in an HttpOnly cookie the browser sends automatically. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
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
