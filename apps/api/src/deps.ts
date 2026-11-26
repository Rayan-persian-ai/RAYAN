import type { Env } from "./env";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Abstraction over the LLM so tests (and future providers) can swap it out. */
export interface AiProvider {
  readonly name: string;
  /**
   * True when the provider meters itself against the D1 Cost Controller per underlying provider
   * (the multi-provider chain). Callers then skip the single "workers_ai" reservation and map
   * AiCapError to 429 daily_cap_reached. Plain providers (and test mocks) leave this unset.
   */
  readonly selfMetered?: boolean;
  /** Optional: same as chat() but also reports which provider/model served the answer. */
  chatDetailed?(env: Env, messages: ChatTurn[]): Promise<{ text: string; provider: string; model: string }>;
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
  /** Optional overrides for cortex tools (e.g. a stub fetch in tests). */
  cortexRuntime?: import("./lib/cortex").CortexRuntimeDeps;
  taskHandlers: Record<string, TaskHandler>;
  now: () => number;
}
