import { describe, expect, it } from 'vitest';
import { D1MemoryAdapter, InMemoryMemoryAdapter, MemoryManager, type MemoryAdapter } from '../src/memory.js';
import { createTestD1 } from './helpers/d1.js';

const adapters: [string, () => MemoryAdapter][] = [
  ['in-memory', () => new InMemoryMemoryAdapter()],
  ['d1', () => new D1MemoryAdapter(createTestD1())],
];

for (const [name, make] of adapters) {
  describe(`MemoryManager (${name})`, () => {
    it('strictly isolates users across every scope', async () => {
      let now = 1_000;
      const mm = new MemoryManager(make(), { clock: () => now });
      const alice = mm.forUser({ userId: 'alice', projectId: 'p1', sessionId: 's1' });
      const bob = mm.forUser({ userId: 'bob', projectId: 'p1', sessionId: 's1' }); // same project/session ids!
      for (const scope of ['user', 'long-term', 'project', 'short-term'] as const) await alice.put(scope, 'secret', { v: `alice-${scope}` });
      await alice.put('agent', 'secret', 'alice-agent', { agentSlug: 'writer' });
      for (const scope of ['user', 'long-term', 'project', 'short-term'] as const) {
        expect(await bob.get(scope, 'secret')).toBeUndefined();
        expect(await bob.list(scope)).toHaveLength(0);
        expect(await alice.get(scope, 'secret')).toEqual({ v: `alice-${scope}` });
      }
      expect(await bob.get('agent', 'secret', { agentSlug: 'writer' })).toBeUndefined();
      expect(await bob.search('alice')).toHaveLength(0);
      expect((await alice.search('alice')).length).toBeGreaterThan(0);
      expect(await bob.delete('user', 'secret')).toBe(false);
      expect(await alice.get('user', 'secret')).toBeDefined();
      now++;
    });

    it('isolates projects, sessions and agents within one user', async () => {
      const mm = new MemoryManager(make());
      const p1 = mm.forUser({ userId: 'u', projectId: 'p1', sessionId: 's1' });
      const p2 = mm.forUser({ userId: 'u', projectId: 'p2', sessionId: 's2' });
      await p1.put('project', 'k', 'one');
      await p1.put('short-term', 'k', 'sess1');
      await p1.put('agent', 'k', 'w', { agentSlug: 'writer' });
      expect(await p2.get('project', 'k')).toBeUndefined();
      expect(await p2.get('short-term', 'k')).toBeUndefined();
      expect(await p2.get('agent', 'k', { agentSlug: 'coder' })).toBeUndefined();
      expect(await p2.get('agent', 'k', { agentSlug: 'writer' })).toBe('w'); // agent memory is per user+agent
      expect((await p2.search('one')).length).toBe(0);
    });

    it('requires namespace context for scoped memory', async () => {
      const u = new MemoryManager(make()).forUser({ userId: 'u' });
      await expect(u.put('project', 'k', 1)).rejects.toThrow(/projectId/);
      await expect(u.put('short-term', 'k', 1)).rejects.toThrow(/sessionId/);
      await expect(u.put('agent', 'k', 1)).rejects.toThrow(/agentSlug/);
      expect(() => new MemoryManager(make()).forUser({ userId: '' })).toThrow(/userId/);
    });

    it('expires short-term memory and purges', async () => {
      let now = 0;
      const mm = new MemoryManager(make(), { clock: () => now, shortTermTtlMs: 100 });
      const u = mm.forUser({ userId: 'u', sessionId: 's' });
      await u.put('short-term', 'k', 'v');
      await u.put('user', 'pref', 'tea');
      now = 50;
      expect(await u.get('short-term', 'k')).toBe('v');
      now = 200;
      expect(await u.get('short-term', 'k')).toBeUndefined();
      expect(await mm.purgeExpired()).toBe(1);
      expect(await u.get('user', 'pref')).toBe('tea');
    });

    it('upserts, lists by prefix/tag, enforces value size, and erases a user', async () => {
      let now = 0;
      const mm = new MemoryManager(make(), { clock: () => ++now, maxValueBytes: 100 });
      const u = mm.forUser({ userId: 'u' });
      const first = await u.put('user', 'food:breakfast', 'نان و پنیر', { tags: ['food'] });
      const second = await u.put('user', 'food:breakfast', 'املت', { tags: ['food'] });
      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      await u.put('user', 'food:lunch', 'کباب', { tags: ['food', 'lunch'] });
      await u.put('user', 'city', 'تهران');
      expect((await u.list('user', { prefix: 'food:' })).map((r) => r.key).sort()).toEqual(['food:breakfast', 'food:lunch']);
      expect((await u.list('user', { tag: 'lunch' })).map((r) => r.key)).toEqual(['food:lunch']);
      expect((await u.search('کباب'))[0]?.key).toBe('food:lunch');
      await expect(u.put('user', 'big', 'x'.repeat(200))).rejects.toThrow(/max 100/);
      expect(await u.forgetEverything()).toBe(3);
      expect(await u.list('user')).toHaveLength(0);
    });

    it('treats LIKE wildcards in prefixes literally', async () => {
      const u = new MemoryManager(make()).forUser({ userId: 'u' });
      await u.put('user', 'a%b', 1);
      await u.put('user', 'aXb', 2);
      expect((await u.list('user', { prefix: 'a%' })).map((r) => r.key)).toEqual(['a%b']);
    });
  });
}
