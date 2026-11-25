import { describe, expect, it } from 'vitest';
import { IntentEngine } from '../src/intent.js';
import { PlanError, TaskPlanner, validatePlan } from '../src/planner.js';

describe('validatePlan', () => {
  it('accepts a DAG and returns topological order + depth', () => {
    const v = validatePlan([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]);
    expect(v.ok).toBe(true);
    expect(v.order[0]).toBe('a');
    expect(v.order[3]).toBe('d');
    expect(v.depth).toBe(3);
  });

  it('detects cycles, self deps, unknown deps, duplicates', () => {
    expect(validatePlan([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]).errors.join()).toMatch(/cycle/);
    expect(validatePlan([{ id: 'a', dependsOn: ['a'] }]).errors.join()).toMatch(/itself/);
    expect(validatePlan([{ id: 'a', dependsOn: ['zzz'] }]).errors.join()).toMatch(/unknown/);
    expect(validatePlan([{ id: 'a', dependsOn: [] }, { id: 'a', dependsOn: [] }]).errors.join()).toMatch(/duplicate/);
    expect(validatePlan([]).ok).toBe(false);
  });

  it('caps steps and depth', () => {
    const chain = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, dependsOn: i ? [`s${i - 1}`] : [] }));
    expect(validatePlan(chain, { maxDepth: 5 }).errors.join()).toMatch(/depth 10 exceeds/);
    expect(validatePlan(chain, { maxSteps: 4 }).errors.join()).toMatch(/max is 4/);
  });
});

describe('TaskPlanner templates', () => {
  it('builds a research DAG with tools', async () => {
    const p = await new TaskPlanner().plan('درباره D1 تحقیق کن', 'research');
    expect(p.source).toBe('template');
    expect(p.steps.map((s) => s.id)).toEqual(['search', 'read', 'synthesize']);
    expect(p.steps[0]!.toolNames).toEqual(['web.search']);
    expect(p.steps[1]!.dependsOn).toEqual(['search']);
    expect(p.steps[0]!.title).toBe('جستجوی منابع');
  });

  it('splits compound goals (Persian and English) and chains segments', async () => {
    const intents = new IntentEngine();
    const planner = new TaskPlanner({ classifySegment: (s) => intents.classifyByKeywords(s).intent });
    expect(planner.splitGoal('درباره هوش مصنوعی تحقیق کن و سپس یک مقاله بنویس')).toHaveLength(2);
    const p = await planner.plan('Research Cloudflare D1 then write a blog post about it', 'research', { locale: 'en' });
    const ids = p.steps.map((s) => s.id);
    expect(ids).toContain('s1.search');
    expect(ids).toContain('s2.outline');
    const outline = p.steps.find((s) => s.id === 's2.outline')!;
    expect(outline.dependsOn).toEqual(['s1.synthesize']);
    expect(outline.intent).toBe('content');
    expect(validatePlan(p.steps).ok).toBe(true);
  });

  it('caps segments and steps', async () => {
    const planner = new TaskPlanner({ limits: { maxSegments: 2, maxSteps: 4 } });
    const segs = planner.splitGoal('a1 then b2 then c3 then d4');
    expect(segs).toHaveLength(2);
    const p = await planner.plan('analyze x then analyze y then analyze z', 'analysis');
    expect(p.steps.length).toBeLessThanOrEqual(4);
    expect(validatePlan(p.steps).ok).toBe(true);
  });
});

describe('TaskPlanner with LLM', () => {
  it('uses a valid LLM plan', async () => {
    const llm = async () =>
      JSON.stringify({ steps: [{ id: 'x', title: 'X', capability: 'code.write' }, { id: 'y', title: 'Y', capability: 'code.test', dependsOn: ['x'] }] });
    const p = await new TaskPlanner({ llm }).plan('build it', 'code');
    expect(p.source).toBe('llm');
    expect(p.steps[1]!.dependsOn).toEqual(['x']);
  });

  it('rejects cyclic LLM plans and falls back to templates', async () => {
    const llm = async () =>
      JSON.stringify({ steps: [{ id: 'x', title: 'X', capability: 'c', dependsOn: ['y'] }, { id: 'y', title: 'Y', capability: 'c', dependsOn: ['x'] }] });
    const p = await new TaskPlanner({ llm }).plan('build it', 'code');
    expect(p.source).toBe('template');
    expect(p.llmError).toMatch(/cycle/);
  });

  it('rejects malformed LLM output', async () => {
    const p = await new TaskPlanner({ llm: async () => 'no json here' }).plan('hi', 'chat');
    expect(p.source).toBe('template');
    expect(p.llmError).toBeDefined();
  });

  it('PlanError carries errors', () => {
    expect(new PlanError(['a', 'b']).errors).toEqual(['a', 'b']);
  });
});
