import type { Env } from "./env";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Abstraction over the LLM so tests (and future providers) can swap it out. */
export interface AiProvider {
  readonly name: string;
  isAvailable(env: Env): boolean;
  chat(env: Env, messages: ChatTurn[]): Promise<string>;
}

export interface TaskContext {
  env: Env;
  deps: AppDeps;
  task: { id: string; type: string; payload: Record<string, unknown>; attempts: number; created_by: string | null };
}
export type TaskHandler = (ctx: TaskContext) => Promise<unknown>;

export interface AppDeps {
  ai: AiProvider;
  taskHandlers: Record<string, TaskHandler>;
  now: () => number;
}
