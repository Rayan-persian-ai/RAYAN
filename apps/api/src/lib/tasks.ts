export interface TaskRow {
  id: string;
  type: string;
  status: string;
  payload: string;
  result: string | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  agent_slug: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  next_run_at: number | null;
}

export const TASK_COLUMNS =
  "id, type, status, payload, result, error, attempts, max_attempts, agent_slug, created_by, created_at, updated_at, started_at, finished_at, next_run_at";

function tryParse(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function serializeTask(t: TaskRow) {
  return { ...t, payload: tryParse(t.payload), result: tryParse(t.result) };
}

/** Error that must not be retried (bad input, unknown task type...). */
export class NonRetryableError extends Error {}
