import { ERRORS_FA, type ErrorCode } from "@rayan/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    readonly details?: unknown,
    message?: string,
  ) {
    super(message ?? ERRORS_FA[code]);
  }
}

export function errorBody(code: ErrorCode, details?: unknown, message?: string) {
  return { error: { code, message: message ?? ERRORS_FA[code], ...(details !== undefined ? { details } : {}) } };
}

export function sendError(c: Context, err: ApiError) {
  return c.json(errorBody(err.code, err.details, err.message), err.status);
}
