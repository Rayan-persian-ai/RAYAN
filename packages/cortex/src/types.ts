/** Shared core types for RAYAN CORTEX. */

export const INTENTS = [
  'chat',
  'code',
  'research',
  'content',
  'image',
  'automation',
  'admin',
  'analysis',
] as const;
export type Intent = (typeof INTENTS)[number];

export const AUTONOMY_LEVELS = ['automatic', 'guarded', 'restricted'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export type RiskLevel = 'low' | 'medium' | 'high';

/** Identity and policy context of the end user a request is executed for. */
export interface UserContext {
  userId: string;
  projectId?: string;
  sessionId?: string;
  locale?: 'fa' | 'en';
  /** e.g. ['owner'] or ['user']; 'owner' may approve restricted actions. */
  roles?: string[];
}

export interface LLMRequest {
  system?: string;
  prompt: string;
  /** Model id chosen by ModelRouter, when routed. */
  model?: string;
  /** Hint that the caller expects a JSON object back. */
  json?: boolean;
  signal?: AbortSignal;
}

/** Injectable LLM call. Implementations may wrap Workers AI, OpenRouter free tier, etc. */
export type LLMFunction = (req: LLMRequest) => Promise<string>;

/** Error carrying a machine-readable code and whether retrying can help. */
export class CortexError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  constructor(code: string, message: string, opts: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'CortexError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof CortexError) return err.retryable;
  if (err && typeof err === 'object' && 'retryable' in err) return Boolean((err as { retryable: unknown }).retryable);
  // Unknown errors (network blips etc.) are retryable by default.
  return true;
}
