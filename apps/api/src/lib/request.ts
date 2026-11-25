import type { Context } from "hono";
import type { z } from "zod";
import { ApiError } from "./errors";

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

export function userAgent(c: Context): string | null {
  return c.req.header("user-agent")?.slice(0, 256) ?? null;
}

/** Parses a JSON body against a zod schema. Rejects non-JSON content types (CSRF hardening). */
export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "invalid_input", { content_type: "application/json required" });
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_input", { body: "invalid JSON" });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "invalid_input",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}
