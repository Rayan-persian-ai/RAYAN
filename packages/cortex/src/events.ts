import type { D1DatabaseLike } from './d1.js';
import { newId, redact, sha256Hex, systemClock, type Clock } from './util.js';

export interface CortexEvent<D = unknown> {
  id: string;
  type: string;
  at: number;
  traceId?: string;
  userId?: string;
  data: D;
}

export type EventHandler = (event: CortexEvent) => void | Promise<void>;

/**
 * In-process pub/sub. Handler errors are isolated (never break the emitter) and reported
 * to `onHandlerError`. Subscribe with an exact type, a prefix wildcard ('step.*'), or '*'.
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private readonly history: CortexEvent[] = [];
  constructor(
    private readonly opts: { historyLimit?: number; clock?: Clock; onHandlerError?: (err: unknown, e: CortexEvent) => void } = {},
  ) {}

  on(type: string, handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  once(type: string, handler: EventHandler): () => void {
    const off = this.on(type, (e) => {
      off();
      return handler(e);
    });
    return off;
  }

  private matching(type: string): EventHandler[] {
    const out: EventHandler[] = [];
    const add = (k: string) => this.handlers.get(k)?.forEach((h) => out.push(h));
    add(type);
    const parts = type.split('.');
    for (let i = parts.length - 1; i > 0; i--) add(`${parts.slice(0, i).join('.')}.*`);
    add('*');
    return out;
  }

  /** Emit and return the event. Async handlers run detached; use emitAsync to await them. */
  emit<D>(type: string, data: D, meta: { traceId?: string; userId?: string } = {}): CortexEvent<D> {
    const event = this.build(type, data, meta);
    for (const h of this.matching(type)) {
      try {
        const r = h(event);
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => this.report(e, event));
      } catch (e) {
        this.report(e, event);
      }
    }
    return event;
  }

  async emitAsync<D>(type: string, data: D, meta: { traceId?: string; userId?: string } = {}): Promise<CortexEvent<D>> {
    const event = this.build(type, data, meta);
    await Promise.all(
      this.matching(type).map(async (h) => {
        try {
          await h(event);
        } catch (e) {
          this.report(e, event);
        }
      }),
    );
    return event;
  }

  recent(limit = 50): CortexEvent[] {
    return this.history.slice(-limit);
  }

  private build<D>(type: string, data: D, meta: { traceId?: string; userId?: string }): CortexEvent<D> {
    const event: CortexEvent<D> = { id: newId('evt'), type, at: (this.opts.clock ?? systemClock)(), data, ...meta };
    const limit = this.opts.historyLimit ?? 200;
    if (limit > 0) {
      this.history.push(event);
      if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
    }
    return event;
  }

  private report(err: unknown, e: CortexEvent) {
    this.opts.onHandlerError?.(err, e);
  }
}

// ---------------------------------------------------------------- Audit

export interface AuditEntry {
  id: string;
  at: number;
  userId: string;
  actor: string; // agent slug, 'system', or user id
  action: string; // e.g. 'tool.execute', 'permission.decision'
  target?: string;
  decision?: 'allowed' | 'denied' | 'approval_required' | 'info';
  details?: unknown;
  prevHash: string;
  hash: string;
}

export interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  last(): Promise<AuditEntry | undefined>;
  list(filter: { userId?: string; limit?: number; since?: number }): Promise<AuditEntry[]>;
  all(): Promise<AuditEntry[]>;
}

export class InMemoryAuditStore implements AuditStore {
  private entries: AuditEntry[] = [];
  async append(e: AuditEntry) {
    this.entries.push(e);
  }
  async last() {
    return this.entries[this.entries.length - 1];
  }
  async list(f: { userId?: string; limit?: number; since?: number }) {
    let r = this.entries.filter((e) => (!f.userId || e.userId === f.userId) && (!f.since || e.at >= f.since));
    if (f.limit) r = r.slice(-f.limit);
    return r;
  }
  async all() {
    return [...this.entries];
  }
}

export class D1AuditStore implements AuditStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async append(e: AuditEntry) {
    await this.db
      .prepare(
        'INSERT INTO cortex_audit (id, at, user_id, actor, action, target, decision, details, prev_hash, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
      )
      .bind(e.id, e.at, e.userId, e.actor, e.action, e.target ?? null, e.decision ?? null, JSON.stringify(e.details ?? null), e.prevHash, e.hash)
      .run();
  }
  async last() {
    const row = await this.db.prepare('SELECT * FROM cortex_audit ORDER BY seq DESC LIMIT 1').first<AuditRow>();
    return row ? fromRow(row) : undefined;
  }
  async list(f: { userId?: string; limit?: number; since?: number }) {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM (SELECT * FROM cortex_audit WHERE (?1 IS NULL OR user_id = ?1) AND at >= ?2 ORDER BY seq DESC LIMIT ?3) ORDER BY seq ASC',
      )
      .bind(f.userId ?? null, f.since ?? 0, f.limit ?? 1000)
      .all<AuditRow>();
    return results.map(fromRow);
  }
  async all() {
    const { results } = await this.db.prepare('SELECT * FROM cortex_audit ORDER BY seq ASC').all<AuditRow>();
    return results.map(fromRow);
  }
}

interface AuditRow {
  id: string;
  at: number;
  user_id: string;
  actor: string;
  action: string;
  target: string | null;
  decision: string | null;
  details: string | null;
  prev_hash: string;
  hash: string;
}
function fromRow(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    at: Number(r.at),
    userId: r.user_id,
    actor: r.actor,
    action: r.action,
    target: r.target ?? undefined,
    decision: (r.decision ?? undefined) as AuditEntry['decision'],
    details: r.details ? JSON.parse(r.details) : undefined,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

const GENESIS = '0'.repeat(64);

/**
 * Append-only, hash-chained audit log. Details are redacted (secret-looking keys) before storage.
 * verify() recomputes the chain to detect tampering. Appends are serialized to keep the chain linear.
 */
export class AuditLogger {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: AuditStore = new InMemoryAuditStore(), private readonly clock: Clock = systemClock) {}

  log(input: Omit<AuditEntry, 'id' | 'at' | 'prevHash' | 'hash'>): Promise<AuditEntry> {
    const run = async () => {
      const prev = await this.store.last();
      const base = {
        id: newId('aud'),
        at: this.clock(),
        userId: input.userId,
        actor: input.actor,
        action: input.action,
        target: input.target,
        decision: input.decision,
        details: input.details === undefined ? undefined : redact(input.details),
        prevHash: prev?.hash ?? GENESIS,
      };
      const entry: AuditEntry = { ...base, hash: await sha256Hex(canonical(base)) };
      await this.store.append(entry);
      return entry;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Forward selected bus events into the audit log. Returns an unsubscribe function. */
  attach(bus: EventBus, types: string[] = ['*']): () => void {
    const offs = types.map((t) =>
      bus.on(t, (e) =>
        this.log({ userId: e.userId ?? 'system', actor: 'system', action: `event.${e.type}`, decision: 'info', details: e.data }).then(() => undefined),
      ),
    );
    return () => offs.forEach((o) => o());
  }

  list(filter: { userId?: string; limit?: number; since?: number } = {}) {
    return this.store.list(filter);
  }

  async verify(): Promise<{ ok: boolean; brokenAt?: string }> {
    await this.queue;
    let prev = GENESIS;
    for (const e of await this.store.all()) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || (await sha256Hex(canonical(rest))) !== hash) return { ok: false, brokenAt: e.id };
      prev = hash;
    }
    return { ok: true };
  }
}

function canonical(e: Omit<AuditEntry, 'hash'>): string {
  return JSON.stringify([e.id, e.at, e.userId, e.actor, e.action, e.target ?? null, e.decision ?? null, e.details ?? null, e.prevHash]);
}
