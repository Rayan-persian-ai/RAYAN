import { describe, expect, it } from 'vitest';
import { AgentRegistry, AgentRouter, type AgentManifest } from '../src/agents.js';

const m = (over: Partial<AgentManifest> & { slug: string }): AgentManifest => ({
  name_fa: 'عامل',
  capabilities: ['research.search'],
  allowedTools: [],
  permissions: [],
  enabled: true,
  ...over,
});

describe('AgentRegistry', () => {
  it('validates manifests and collects errors in bulk load', () => {
    const reg = new AgentRegistry();
    const r = reg.load([m({ slug: 'ok-1' }), { slug: 'BAD SLUG', name_fa: 'x', capabilities: ['a'] }, { slug: 'no-caps', name_fa: 'x', capabilities: [] }, m({ slug: 'ok-2', extra: 1 } as never)]);
    expect(r.loaded).toBe(1);
    expect(r.errors.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(reg.size).toBe(1);
  });

  it('loads NDJSON and JSON arrays', () => {
    const reg = new AgentRegistry();
    const nd = [m({ slug: 'a' }), m({ slug: 'b' })].map((x) => JSON.stringify(x)).join('\n') + '\n{broken';
    const r = reg.loadJson(nd);
    expect(r.loaded).toBe(2);
    expect(r.errors).toHaveLength(1);
    expect(new AgentRegistry().loadJson(JSON.stringify([m({ slug: 'c' })])).loaded).toBe(1);
  });

  it('keeps indexes consistent on upsert/remove/setEnabled', () => {
    const reg = new AgentRegistry();
    reg.upsert(m({ slug: 'a', capabilities: ['x.one'], allowedTools: ['t1'] }));
    reg.upsert(m({ slug: 'a', capabilities: ['x.two'], allowedTools: ['t2'] }));
    expect(reg.slugsForCapability('x.one').size).toBe(0);
    expect(reg.slugsForTool('t2').has('a')).toBe(true);
    reg.setEnabled('a', false);
    expect(reg.enabledSize).toBe(0);
    expect(reg.remove('a')).toBe(true);
    expect(reg.slugsForTool('t2').size).toBe(0);
  });
});

describe('AgentRouter', () => {
  const build = () => {
    const reg = new AgentRegistry();
    reg.load([
      m({ slug: 'generalist', capabilities: ['research.*', 'content.*'], allowedTools: ['web.search', 'web.fetch'] }),
      m({ slug: 'searcher', capabilities: ['research.search'], allowedTools: ['web.search'] }),
      m({ slug: 'disabled-best', capabilities: ['research.search'], allowedTools: ['web.search'], enabled: false, priority: 1000 }),
      m({ slug: 'no-tools', capabilities: ['research.search'], allowedTools: [] }),
    ]);
    return { reg, router: new AgentRouter(reg) };
  };

  it('picks the specialist over a domain generalist, never a disabled agent', () => {
    const { router } = build();
    expect(router.pick({ capability: 'research.search', toolNames: ['web.search'] })?.agent.slug).toBe('searcher');
  });

  it('requires all tools', () => {
    const { router } = build();
    expect(router.pick({ capability: 'research.read', toolNames: ['web.fetch'] })?.agent.slug).toBe('generalist');
    expect(router.pick({ capability: 'research.search', toolNames: ['web.search', 'db.write'] })).toBeUndefined();
  });

  it('honours preferred slug when eligible, and exclusions', () => {
    const { router } = build();
    expect(router.pick({ capability: 'research.search', toolNames: ['web.search'], preferredSlug: 'generalist' })?.agent.slug).toBe('generalist');
    expect(router.pick({ capability: 'research.search', toolNames: ['web.search'], preferredSlug: 'disabled-best' })?.agent.slug).toBe('searcher');
    expect(router.pick({ capability: 'research.search', toolNames: ['web.search'], exclude: ['searcher'] })?.agent.slug).toBe('generalist');
  });

  it('learns from outcomes', () => {
    const reg = new AgentRegistry();
    reg.load([m({ slug: 'a1' }), m({ slug: 'a2' })]);
    const router = new AgentRouter(reg);
    expect(router.pick({ capability: 'research.search' })?.agent.slug).toBe('a1'); // tie → slug order
    for (let i = 0; i < 5; i++) router.recordOutcome('a1', false);
    router.recordOutcome('a2', true);
    expect(router.pick({ capability: 'research.search' })?.agent.slug).toBe('a2');
  });

  it('scales to 100k manifests with indexed lookup', () => {
    const reg = new AgentRegistry();
    const domains = ['research', 'code', 'content', 'image', 'analysis', 'automation', 'admin', 'chat'];
    const t0 = performance.now();
    const r = reg.load(
      (function* () {
        for (let i = 0; i < 100_000; i++) {
          const d = domains[i % domains.length]!;
          yield { slug: `agent-${i}`, name_fa: `عامل ${i}`, capabilities: [`${d}.task${i % 50}`], allowedTools: [`tool.${i % 200}`], permissions: [], enabled: i % 7 !== 0 };
        }
      })(),
    );
    const loadMs = performance.now() - t0;
    expect(r.loaded).toBe(100_000);
    expect(reg.size).toBe(100_000);
    const router = new AgentRouter(reg);
    const t1 = performance.now();
    let found = 0;
    for (let i = 0; i < 1000; i++) {
      const res = router.pick({ capability: `code.task${(i * 8 + 1) % 50}`, toolNames: [`tool.${(i * 8 + 1) % 200}`] });
      if (res) {
        found++;
        expect(res.candidatesScanned).toBeLessThan(1000); // index, not a full scan
      }
    }
    const routeMs = performance.now() - t1;
    expect(found).toBeGreaterThan(0);
    // Generous bounds for CI; typical: load ~1s, 1000 routes << 200ms.
    expect(loadMs).toBeLessThan(15_000);
    expect(routeMs).toBeLessThan(2_000);
    console.log(`[scale] load 100k: ${loadMs.toFixed(0)}ms, 1000 routes: ${routeMs.toFixed(1)}ms`);
  });
});
