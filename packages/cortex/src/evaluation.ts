import { PromptGuard } from './guard.js';
import { persianRatio } from './text.js';
import type { LLMFunction } from './types.js';
import { extractJsonObject, withTimeout } from './util.js';

export interface CheckResult {
  name: string;
  passed: boolean;
  /** 0..1 */
  score: number;
  weight: number;
  detail?: string;
}

export interface EvaluationInput {
  output: string;
  task?: string;
  expectedLanguage?: 'fa' | 'en';
  expectJson?: boolean;
  mustInclude?: string[];
  minLength?: number;
  maxLength?: number;
}

export interface EvaluationResult {
  score: number;
  passed: boolean;
  checks: CheckResult[];
  judge?: { score: number; reason: string } | { error: string };
}

export type Check = (input: EvaluationInput) => CheckResult | null;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI-style
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub token
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, // Slack
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
];

export const BUILTIN_CHECKS: Record<string, Check> = {
  nonEmpty: (i) => {
    const ok = i.output.trim().length > 0;
    return { name: 'nonEmpty', passed: ok, score: ok ? 1 : 0, weight: 3 };
  },
  length: (i) => {
    if (i.minLength === undefined && i.maxLength === undefined) return null;
    const n = i.output.trim().length;
    const min = i.minLength ?? 0;
    const max = i.maxLength ?? Infinity;
    const ok = n >= min && n <= max;
    const score = ok ? 1 : n < min ? n / Math.max(min, 1) : Math.max(0, 1 - (n - max) / max);
    return { name: 'length', passed: ok, score, weight: 1, detail: `${n} chars (want ${min}..${max})` };
  },
  language: (i) => {
    if (!i.expectedLanguage) return null;
    const r = persianRatio(i.output);
    const score = i.expectedLanguage === 'fa' ? r : 1 - r;
    // Code/URLs dilute ratio, so accept >= 0.6.
    return { name: 'language', passed: score >= 0.6, score, weight: 2, detail: `persian ratio ${r.toFixed(2)}` };
  },
  json: (i) => {
    if (!i.expectJson) return null;
    try {
      JSON.parse(i.output);
      return { name: 'json', passed: true, score: 1, weight: 2 };
    } catch {
      const embedded = extractJsonObject(i.output) !== undefined;
      return { name: 'json', passed: false, score: embedded ? 0.5 : 0, weight: 2, detail: embedded ? 'json embedded in prose' : 'not json' };
    }
  },
  mustInclude: (i) => {
    if (!i.mustInclude?.length) return null;
    const lower = i.output.toLowerCase();
    const hits = i.mustInclude.filter((k) => lower.includes(k.toLowerCase()));
    return { name: 'mustInclude', passed: hits.length === i.mustInclude.length, score: hits.length / i.mustInclude.length, weight: 2, detail: `${hits.length}/${i.mustInclude.length}` };
  },
  noSecrets: (i) => {
    const leaked = SECRET_PATTERNS.some((re) => re.test(i.output));
    return { name: 'noSecrets', passed: !leaked, score: leaked ? 0 : 1, weight: 5, detail: leaked ? 'possible credential in output' : undefined };
  },
  noRefusalLoop: (i) => {
    // Detect degenerate repetition (same line repeated many times).
    const lines = i.output.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 6) return { name: 'noRepetition', passed: true, score: 1, weight: 1 };
    const unique = new Set(lines).size / lines.length;
    return { name: 'noRepetition', passed: unique >= 0.5, score: Math.min(1, unique * 1.5), weight: 1, detail: `unique line ratio ${unique.toFixed(2)}` };
  },
};

export interface EvaluationEngineOptions {
  judge?: LLMFunction;
  /** Share of final score from the LLM judge (default 0.4). */
  judgeWeight?: number;
  judgeTimeoutMs?: number;
  passThreshold?: number;
  extraChecks?: Check[];
}

export class EvaluationEngine {
  private readonly guard = new PromptGuard();
  constructor(private readonly opts: EvaluationEngineOptions = {}) {}

  async evaluate(input: EvaluationInput, opts: { signal?: AbortSignal } = {}): Promise<EvaluationResult> {
    const checks: CheckResult[] = [];
    for (const c of [...Object.values(BUILTIN_CHECKS), ...(this.opts.extraChecks ?? [])]) {
      const r = c(input);
      if (r) checks.push(r);
    }
    const wsum = checks.reduce((a, c) => a + c.weight, 0);
    let score = wsum ? checks.reduce((a, c) => a + c.score * c.weight, 0) / wsum : 0;
    let judge: EvaluationResult['judge'];
    if (this.opts.judge && input.output.trim()) {
      try {
        const raw = await withTimeout(
          (signal) =>
            this.opts.judge!({
              system:
                'You are a strict evaluator. Score how well the OUTPUT fulfils the TASK from 0 to 10. ' +
                PromptGuard.SYSTEM_NOTICE +
                ' Reply JSON only: {"score": <0-10>, "reason": "<short>"}.',
              prompt: `<task>\n${(input.task ?? '').slice(0, 2000)}\n</task>\n${this.guard.wrap(input.output.slice(0, 8000), 'candidate_output')}`,
              json: true,
              signal,
            }),
          this.opts.judgeTimeoutMs ?? 10_000,
          opts.signal,
          'llm judge',
        );
        const j = extractJsonObject(raw) as { score?: unknown; reason?: unknown } | undefined;
        if (typeof j?.score !== 'number' || j.score < 0 || j.score > 10) throw new Error('judge returned no valid score');
        judge = { score: j.score / 10, reason: typeof j.reason === 'string' ? j.reason.slice(0, 300) : '' };
        const w = this.opts.judgeWeight ?? 0.4;
        score = score * (1 - w) + judge.score * w;
      } catch (e) {
        judge = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    // Hard gates: empty output or leaked secret always fails.
    const gated = checks.some((c) => (c.name === 'nonEmpty' || c.name === 'noSecrets') && !c.passed);
    score = Math.round(score * 1000) / 1000;
    return { score, passed: !gated && score >= (this.opts.passThreshold ?? 0.6), checks, judge };
  }
}
