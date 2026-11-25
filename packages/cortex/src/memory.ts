import type { D1DatabaseLike } from './d1.js';
import { CortexError, type UserContext } from './types.js';
import { newId, systemClock, type Clock } from './util.js';
import { normalizeText } from './text.js';

export const MEMORY_SCOPES = ['short-term', 'long-term', 'user', 'project', 'agent'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryRecord<V = unknown> {
  id: string;
  userId: string;
  scope: MemoryScope;
  /** sessionId (short-term), projectId (project), agentSlug (agent), '' otherwise. */
  namespace: string;
  key: string;
  value: V;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface MemoryQuery {
  prefix?: string;
  tag?: string;
  limit?: number;
}

/**
 * Storage adapter. EVERY method takes userId as its first argument and must never return or touch
 * rows of another user. MemoryManager is the only intended caller.
 */
export interface MemoryAdapter {
  put(rec: MemoryRecord): Promise<void>;
  get(userId: string, scope: MemoryScope, ns: string, key: string, now: number): Promise<MemoryRecord | undefined>;
  list(userId: string, scope: MemoryScope, ns: string, q: MemoryQuery, now: number): Promise<MemoryRecord[]>;
  delete(userId: string, scope: MemoryScope, ns: string, key: string): Promise<boolean>;
  search(userId: string, text: string, scopes: MemoryScope[], limit: number, now: number): Promise<MemoryRecord[]>;
  purgeExpired(now: number): Promise<number>;
  deleteUser(userId: string): Promise<number>;
}

const live = (r: MemoryRecord, now: number) => r.expiresAt === null || r.expiresAt > now;

/** Per-user partitioned in-memory store (users never share a Map). */
export class InMemoryMemoryAdapter implements MemoryAdapter {
  private readonly users = new Map<string, Map<string, MemoryRecord>>();
  private k(scope: string, ns: string, key: string) {
    return `${scope}\u0000${ns}\u0000${key}`;
  }
  private part(userId: string, create = false) {
    let p = this.users.get(userId);
    if (!p && create) this.users.set(userId, (p = new Map()));
    return p;
  }
  async put(rec: MemoryRecord) {
    this.part(rec.userId, true)!.set(this.k(rec.scope, rec.namespace, rec.key), structuredClone(rec));
  }
  async get(userId: string, scope: MemoryScope, ns: string, key: string, now: number) {
    const r = this.part(userId)?.get(this.k(scope, ns, key));
    return r && live(r, now) ? structuredClone(r) : undefined;
  }
  async list(userId: string, scope: MemoryScope, ns: string, q: MemoryQuery, now: number) {
    const out: MemoryRecord[] = [];
    for (const r of this.part(userId)?.values() ?? []) {
      if (r.scope !== scope || r.namespace !== ns || !live(r, now)) continue;
      if (q.prefix && !r.key.startsWith(q.prefix)) continue;
      if (q.tag && !r.tags.includes(q.tag)) continue;
      out.push(structuredClone(r));
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, q.limit ?? 100);
  }
  async delete(userId: string, scope: MemoryScope, ns: string, key: string) {
    return this.part(userId)?.delete(this.k(scope, ns, key)) ?? false;
  }
  async search(userId: string, text: string, scopes: MemoryScope[], limit: number, now: number) {
    const terms = normalizeText(text).split(' ').filter(Boolean);
    const scored: { r: MemoryRecord; s: number }[] = [];
    for (const r of this.part(userId)?.values() ?? []) {
      if (!scopes.includes(r.scope) || !live(r, now)) continue;
      const hay = normalizeText(`${r.key} ${JSON.stringify(r.value)} ${r.tags.join(' ')}`);
      const s = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
      if (s > 0) scored.push({ r, s });
    }
    return scored
      .sort((a, b) => b.s - a.s || b.r.updatedAt - a.r.updatedAt)
      .slice(0, limit)
      .map((x) => structuredClone(x.r));
  }
  async purgeExpired(now: number) {
    let n = 0;
    for (const p of this.users.values()) for (const [k, r] of p) if (!live(r, now)) {
      p.delete(k);
      n++;
    }
    return n;
  }
  async deleteUser(userId: string) {
    const n = this.users.get(userId)?.size ?? 0;
    this.users.delete(userId);
    return n;
  }
}

/** SQL used by D1MemoryAdapter. Every statement is filtered by user_id. */
export const MEMORY_SQL = {
  upsert:
    'INSERT INTO cortex_memory (id, user_id, scope, namespace, key, value, tags, created_at, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ' +
    'ON CONFLICT(user_id, scope, namespace, key) DO UPDATE SET value = excluded.value, tags = excluded.tags, updated_at = excluded.updated_at, expires_at = excluded.expires_at',
  get: 'SELECT * FROM cortex_memory WHERE user_id = ?1 AND scope = ?2 AND namespace = ?3 AND key = ?4 AND (expires_at IS NULL OR expires_at > ?5)',
  list:
    "SELECT * FROM cortex_memory WHERE user_id = ?1 AND scope = ?2 AND namespace = ?3 AND (expires_at IS NULL OR expires_at > ?4) AND key LIKE ?5 ESCAPE '\\' AND (?6 IS NULL OR tags LIKE ?6) ORDER BY updated_at DESC LIMIT ?7",
  delete: 'DELETE FROM cortex_memory WHERE user_id = ?1 AND scope = ?2 AND namespace = ?3 AND key = ?4',
  // Plain LIKE search (portable on D1). For semantic search pair with Vectorize.
  searchPrefix: 'SELECT * FROM cortex_memory WHERE user_id = ?1 AND (expires_at IS NULL OR expires_at > ?2) AND scope IN (SELECT value FROM json_each(?3)) AND (',
  purge: 'DELETE FROM cortex_memory WHERE expires_at IS NOT NULL AND expires_at <= ?1',
  deleteUser: 'DELETE FROM cortex_memory WHERE user_id = ?1',
} as const;

interface MemoryRow {
  id: string;
  user_id: string;
  scope: string;
  namespace: string;
  key: string;
  value: string;
  tags: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

function rowToRecord(r: MemoryRow): MemoryRecord {
  return {
    id: r.id,
    userId: r.user_id,
    scope: r.scope as MemoryScope,
    namespace: r.namespace,
    key: r.key,
    value: JSON.parse(r.value),
    tags: JSON.parse(r.tags) as string[],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    expiresAt: r.expires_at === null ? null : Number(r.expires_at),
  };
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class D1MemoryAdapter implements MemoryAdapter {
  constructor(private readonly db: D1DatabaseLike) {}
  async put(r: MemoryRecord) {
    await this.db
      .prepare(MEMORY_SQL.upsert)
      .bind(r.id, r.userId, r.scope, r.namespace, r.key, JSON.stringify(r.value), JSON.stringify(r.tags), r.createdAt, r.updatedAt, r.expiresAt)
      .run();
  }
  async get(userId: string, scope: MemoryScope, ns: string, key: string, now: number) {
    const row = await this.db.prepare(MEMORY_SQL.get).bind(userId, scope, ns, key, now).first<MemoryRow>();
    return row ? rowToRecord(row) : undefined;
  }
  async list(userId: string, scope: MemoryScope, ns: string, q: MemoryQuery, now: number) {
    const { results } = await this.db
      .prepare(MEMORY_SQL.list)
      .bind(userId, scope, ns, now, `${likeEscape(q.prefix ?? '')}%`, q.tag ? `%${JSON.stringify(q.tag)}%` : null, q.limit ?? 100)
      .all<MemoryRow>();
    return results.map(rowToRecord);
  }
  async delete(userId: string, scope: MemoryScope, ns: string, key: string) {
    const r = await this.db.prepare(MEMORY_SQL.delete).bind(userId, scope, ns, key).run();
    return (r.meta?.changes ?? 0) > 0;
  }
  async search(userId: string, text: string, scopes: MemoryScope[], limit: number, now: number) {
    const terms = normalizeText(text).split(' ').filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const clauses = terms.map((_, i) => `(key || ' ' || value || ' ' || tags) LIKE ?${i + 4} ESCAPE '\\'`).join(' OR ');
    const sql = `${MEMORY_SQL.searchPrefix}${clauses}) ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`;
    const { results } = await this.db
      .prepare(sql)
      .bind(userId, now, JSON.stringify(scopes), ...terms.map((t) => `%${likeEscape(t)}%`))
      .all<MemoryRow>();
    return results.map(rowToRecord);
  }
  async purgeExpired(now: number) {
    const r = await this.db.prepare(MEMORY_SQL.purge).bind(now).run();
    return r.meta?.changes ?? 0;
  }
  async deleteUser(userId: string) {
    const r = await this.db.prepare(MEMORY_SQL.deleteUser).bind(userId).run();
    return r.meta?.changes ?? 0;
  }
}

export interface MemoryManagerOptions {
  clock?: Clock;
  /** Default TTL for short-term memory (default 1h). */
  shortTermTtlMs?: number;
  /** Max serialized value size in bytes (default 64 KiB). */
  maxValueBytes?: number;
}

export interface PutOptions {
  tags?: string[];
  ttlMs?: number;
  /** Required for agent scope. */
  agentSlug?: string;
}

/**
 * Scope-aware memory. Obtain a handle with forUser(ctx); the handle binds userId at creation and
 * offers no way to address another user's data.
 */
export class MemoryManager {
  private readonly clock: Clock;
  constructor(private readonly adapter: MemoryAdapter = new InMemoryMemoryAdapter(), private readonly opts: MemoryManagerOptions = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  forUser(ctx: UserContext): UserMemory {
    if (!ctx.userId || typeof ctx.userId !== 'string') throw new CortexError('memory_no_user', 'userId is required for memory access');
    return new UserMemory(this.adapter, Object.freeze({ ...ctx }), this.clock, this.opts);
  }

  purgeExpired() {
    return this.adapter.purgeExpired(this.clock());
  }
}

export class UserMemory {
  constructor(
    private readonly adapter: MemoryAdapter,
    readonly ctx: Readonly<UserContext>,
    private readonly clock: Clock,
    private readonly opts: MemoryManagerOptions,
  ) {}

  private ns(scope: MemoryScope, agentSlug?: string): string {
    switch (scope) {
      case 'short-term':
        if (!this.ctx.sessionId) throw new CortexError('memory_scope', 'short-term memory requires ctx.sessionId');
        return this.ctx.sessionId;
      case 'project':
        if (!this.ctx.projectId) throw new CortexError('memory_scope', 'project memory requires ctx.projectId');
        return this.ctx.projectId;
      case 'agent':
        if (!agentSlug) throw new CortexError('memory_scope', 'agent memory requires agentSlug');
        return agentSlug;
      case 'user':
      case 'long-term':
        return '';
      default:
        throw new CortexError('memory_scope', `unknown scope ${String(scope)}`);
    }
  }

  async put<V>(scope: MemoryScope, key: string, value: V, opts: PutOptions = {}): Promise<MemoryRecord<V>> {
    if (!key || key.length > 256) throw new CortexError('memory_key', 'key must be 1..256 chars');
    const json = JSON.stringify(value);
    if (json === undefined) throw new CortexError('memory_value', 'value must be JSON-serializable');
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > (this.opts.maxValueBytes ?? 65_536)) throw new CortexError('memory_value', `value is ${bytes} bytes, max ${this.opts.maxValueBytes ?? 65_536}`);
    const namespace = this.ns(scope, opts.agentSlug);
    const now = this.clock();
    const ttl = opts.ttlMs ?? (scope === 'short-term' ? (this.opts.shortTermTtlMs ?? 3600_000) : undefined);
    const existing = await this.adapter.get(this.ctx.userId, scope, namespace, key, now);
    const rec: MemoryRecord<V> = {
      id: existing?.id ?? newId('mem'),
      userId: this.ctx.userId,
      scope,
      namespace,
      key,
      value: JSON.parse(json) as V,
      tags: [...new Set(opts.tags ?? [])],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: ttl ? now + ttl : null,
    };
    await this.adapter.put(rec);
    return rec;
  }

  async get<V = unknown>(scope: MemoryScope, key: string, opts: { agentSlug?: string } = {}): Promise<V | undefined> {
    const r = await this.adapter.get(this.ctx.userId, scope, this.ns(scope, opts.agentSlug), key, this.clock());
    return r?.value as V | undefined;
  }

  async record(scope: MemoryScope, key: string, opts: { agentSlug?: string } = {}) {
    return this.adapter.get(this.ctx.userId, scope, this.ns(scope, opts.agentSlug), key, this.clock());
  }

  list(scope: MemoryScope, q: MemoryQuery & { agentSlug?: string } = {}) {
    return this.adapter.list(this.ctx.userId, scope, this.ns(scope, q.agentSlug), { ...q, limit: Math.min(q.limit ?? 100, 1000) }, this.clock());
  }

  delete(scope: MemoryScope, key: string, opts: { agentSlug?: string } = {}) {
    return this.adapter.delete(this.ctx.userId, scope, this.ns(scope, opts.agentSlug), key);
  }

  /** Keyword search across this user's scopes (project/short-term only within the ctx project/session). */
  async search(text: string, opts: { scopes?: MemoryScope[]; limit?: number } = {}) {
    const scopes = opts.scopes ?? ['user', 'long-term', 'project', 'short-term'];
    const rows = await this.adapter.search(this.ctx.userId, text, scopes, Math.max(opts.limit ?? 10, 1) * 3, this.clock());
    // Namespace isolation for session/project scopes.
    return rows
      .filter((r) => (r.scope === 'short-term' ? r.namespace === this.ctx.sessionId : r.scope === 'project' ? r.namespace === this.ctx.projectId : true))
      .slice(0, opts.limit ?? 10);
  }

  /** Delete ALL memory for this user (GDPR-style erase). */
  forgetEverything() {
    return this.adapter.deleteUser(this.ctx.userId);
  }
}
