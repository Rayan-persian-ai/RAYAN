import type { Env } from "./env";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCallOptions {
  maxTokens?: number;
  /** Model picker id (lib/models.ts); default "auto". */
  model?: string;
  /** Images for the last user turn (vision models only). */
  images?: import("./lib/gemini").ImagePart[];
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
  chatDetailed?(env: Env, messages: ChatTurn[], opts?: ChatCallOptions): Promise<{ text: string; provider: string; model: string }>;
  /**
   * Optional token streaming. Resolves once the upstream accepted the request (errors before the
   * first token reject here, so callers can fall back to chat()); the iterator yields text deltas.
   */
  chatStream?(env: Env, messages: ChatTurn[], opts?: ChatCallOptions): Promise<{ stream: AsyncIterable<string>; provider: string; model: string }>;
  isAvailable(env: Env): boolean;
  chat(env: Env, messages: ChatTurn[], opts?: ChatCallOptions): Promise<string>;
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
  /** Outbound fetch for web search (Wikipedia); tests inject a stub so nothing leaves the sandbox. */
  fetch?: typeof fetch;
  /** Outgoing email provider override (tests); production selects one from env (Gmail by default). */
  email?: import("./lib/email").EmailProvider;
  now: () => number;
}
