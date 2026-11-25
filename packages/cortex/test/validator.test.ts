import { describe, expect, it } from 'vitest';
import { s, ValidationError } from '../src/validator.js';

describe('validator', () => {
  const schema = s.object({
    q: s.string().min(2).max(10),
    n: s.number().int().min(1).optional(),
    mode: s.enum(['fast', 'deep'] as const).default('fast'),
    tags: s.array(s.string()).max(3).default([]),
  });

  it('parses valid input, applies defaults and strips unknown keys', () => {
    expect(schema.parse({ q: 'سلام', extra: 1 })).toEqual({ q: 'سلام', mode: 'fast', tags: [] });
  });

  it('collects all issues with paths', () => {
    const r = schema.safeParse({ q: 'x', n: 1.5, mode: 'slow', tags: ['a', 2] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.issues.map((i) => i.path).sort();
      expect(paths).toEqual(['mode', 'n', 'q', 'tags[1]']);
    }
  });

  it('strict mode rejects unknown keys', () => {
    const r = s.object({ a: s.string() }).strict().safeParse({ a: 'x', b: 1 });
    expect(r.success).toBe(false);
  });

  it('parse throws ValidationError', () => {
    expect(() => s.number().parse('1')).toThrow(ValidationError);
  });

  it('supports refine, url, literal, record', () => {
    expect(s.string().url().safeParse('ftp://x').success).toBe(false);
    expect(s.string().url().safeParse('https://rayan.ir').success).toBe(true);
    expect(s.literal('a').safeParse('b').success).toBe(false);
    expect(s.number().refine((n) => n % 2 === 0, 'even').safeParse(3).success).toBe(false);
    expect(s.record(s.number()).parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });
});
