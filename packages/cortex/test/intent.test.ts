import { describe, expect, it } from 'vitest';
import { IntentEngine } from '../src/intent.js';
import { normalizeText, detectLanguage } from '../src/text.js';

describe('text', () => {
  it('normalizes Arabic letters, digits, ZWNJ', () => {
    expect(normalizeText('مي‌خواهم ۱۲ كتاب')).toBe('می خواهم 12 کتاب');
    expect(detectLanguage('سلام دنیا')).toBe('fa');
    expect(detectLanguage('hello world')).toBe('en');
  });
});

describe('IntentEngine keyword fallback', () => {
  const eng = new IntentEngine();
  const cases: [string, string][] = [
    ['سلام، خوبی؟', 'chat'],
    ['یک تابع پایتون بنویس که باگ این کد را رفع کند', 'code'],
    ['Fix this bug in my TypeScript function', 'code'],
    ['درباره انرژی خورشیدی در ایران تحقیق کن و منابع بده', 'research'],
    ['Research the latest news on Cloudflare D1 with sources', 'research'],
    ['یک پست اینستاگرام برای افتتاح کافه بنویس', 'content'],
    ['Write a blog post about Persian poetry', 'content'],
    ['یک لوگو برای برند رایان طراحی کن', 'image'],
    ['Generate an image of a Persian garden at sunset', 'image'],
    ['هر روز ساعت ۸ صبح یادآوری بفرست', 'automation'],
    ['Schedule a daily webhook to sync my data', 'automation'],
    ['دسترسی کاربر جدید را در تنظیمات تغییر بده', 'admin'],
    ['Revoke admin permission for this user account', 'admin'],
    ['این داده‌های فروش را تحلیل کن و نمودار بکش', 'analysis'],
    ['Analyze this CSV and show the trend', 'analysis'],
  ];
  for (const [text, intent] of cases) {
    it(`${intent}: ${text}`, () => {
      const r = eng.classifyByKeywords(text);
      expect(r.intent).toBe(intent);
      expect(r.source).toBe('keyword');
      expect(r.confidence).toBeGreaterThan(0.4);
    });
  }

  it('defaults to chat with low confidence when nothing matches', () => {
    const r = eng.classifyByKeywords('؟؟؟');
    expect(r).toMatchObject({ intent: 'chat', source: 'default', confidence: 0.3 });
  });

  it('is deterministic', () => {
    const a = eng.classifyByKeywords('Write a python script then analyze the data');
    const b = eng.classifyByKeywords('Write a python script then analyze the data');
    expect(a).toEqual(b);
  });
});

describe('IntentEngine with LLM', () => {
  it('uses valid LLM output', async () => {
    const eng = new IntentEngine({ llm: async () => 'Sure! {"intent":"research","confidence":0.9}' });
    const r = await eng.classify('hello');
    expect(r).toMatchObject({ intent: 'research', source: 'llm', confidence: 0.9 });
  });

  it('falls back on invalid intent', async () => {
    const eng = new IntentEngine({ llm: async () => '{"intent":"hack_the_planet"}' });
    const r = await eng.classify('یک لوگو بکش');
    expect(r.source).toBe('keyword');
    expect(r.intent).toBe('image');
    expect(r.llmError).toMatch(/invalid intent/);
  });

  it('falls back on LLM error', async () => {
    const eng = new IntentEngine({ llm: async () => { throw new Error('rate limited'); } });
    const r = await eng.classify('debug this code');
    expect(r).toMatchObject({ intent: 'code', source: 'keyword', llmError: 'rate limited' });
  });

  it('falls back on LLM timeout', async () => {
    const eng = new IntentEngine({ llm: () => new Promise(() => {}), llmTimeoutMs: 30 });
    const r = await eng.classify('write an article');
    expect(r.intent).toBe('content');
    expect(r.llmError).toMatch(/timed out/);
  });

  it('prefers strong keyword result over low-confidence LLM', async () => {
    const eng = new IntentEngine({ llm: async () => '{"intent":"chat","confidence":0.2}' });
    const r = await eng.classify('Fix the bug in this TypeScript function and add a unit test');
    expect(r.intent).toBe('code');
  });
});
