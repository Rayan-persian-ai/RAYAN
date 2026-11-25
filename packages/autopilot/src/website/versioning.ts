import type { ApprovalGate } from "../approval/approval.js";
import { contentHash, randomId } from "../util/hash.js";
import { changes, type D1DatabaseLike } from "../util/d1.js";

export type SiteEnvironment = "staging" | "production";
export type ThemeTokens = Record<string, string>;

export interface SiteContent {
  /** path -> file content (HTML/CSS/JSON...) */
  files: Record<string, string>;
  themeTokens: ThemeTokens;
  meta?: Record<string, unknown>;
}

export type SnapshotReason = "manual" | "pre_change" | "promotion" | "rollback" | "theme_apply";

export interface Snapshot {
  id: string;
  siteId: string;
  environment: SiteEnvironment;
  label: string;
  reason: SnapshotReason;
  content: SiteContent;
  contentHash: string;
  parentId: string | null;
  createdBy: string;
  createdAt: number;
}

export interface SnapshotStore {
  save(s: Snapshot): Promise<void>;
  get(id: string): Promise<Snapshot | null>;
  list(siteId: string, env: SiteEnvironment, limit?: number): Promise<Snapshot[]>;
  getActiveId(siteId: string, env: SiteEnvironment): Promise<string | null>;
  setActive(siteId: string, env: SiteEnvironment, snapshotId: string): Promise<void>;
}

export class MemorySnapshotStore implements SnapshotStore {
  private snaps = new Map<string, Snapshot>();
  private active = new Map<string, string>();
  async save(s: Snapshot) {
    if (this.snaps.has(s.id)) throw new Error("Snapshots are immutable");
    this.snaps.set(s.id, structuredClone(s));
  }
  async get(id: string) {
    const s = this.snaps.get(id);
    return s ? structuredClone(s) : null;
  }
  async list(siteId: string, env: SiteEnvironment, limit = 50) {
    return [...this.snaps.values()]
      .filter((s) => s.siteId === siteId && s.environment === env)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }
  async getActiveId(siteId: string, env: SiteEnvironment) {
    return this.active.get(`${siteId}:${env}`) ?? null;
  }
  async setActive(siteId: string, env: SiteEnvironment, id: string) {
    this.active.set(`${siteId}:${env}`, id);
  }
}

interface SnapRow {
  id: string;
  site_id: string;
  environment: SiteEnvironment;
  label: string;
  reason: SnapshotReason;
  content_json: string;
  content_hash: string;
  parent_id: string | null;
  created_by: string;
  created_at: number;
}
const rowToSnap = (r: SnapRow): Snapshot => ({
  id: r.id,
  siteId: r.site_id,
  environment: r.environment,
  label: r.label,
  reason: r.reason,
  content: JSON.parse(r.content_json) as SiteContent,
  contentHash: r.content_hash,
  parentId: r.parent_id,
  createdBy: r.created_by,
  createdAt: Number(r.created_at),
});

/** D1 store: tables `autopilot_snapshots` + `autopilot_site_pointers`. */
export class D1SnapshotStore implements SnapshotStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async save(s: Snapshot) {
    const r = await this.db
      .prepare(
        `INSERT INTO autopilot_snapshots (id, site_id, environment, label, reason, content_json, content_hash, parent_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(s.id, s.siteId, s.environment, s.label, s.reason, JSON.stringify(s.content), s.contentHash, s.parentId, s.createdBy, s.createdAt)
      .run();
    if (changes(r) !== 1) throw new Error("Failed to save snapshot");
  }
  async get(id: string) {
    const r = await this.db.prepare("SELECT * FROM autopilot_snapshots WHERE id = ?").bind(id).first<SnapRow>();
    return r ? rowToSnap(r) : null;
  }
  async list(siteId: string, env: SiteEnvironment, limit = 50) {
    const r = await this.db
      .prepare("SELECT * FROM autopilot_snapshots WHERE site_id = ? AND environment = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .bind(siteId, env, limit)
      .all<SnapRow>();
    return (r.results ?? []).map(rowToSnap);
  }
  async getActiveId(siteId: string, env: SiteEnvironment) {
    const r = await this.db
      .prepare("SELECT snapshot_id FROM autopilot_site_pointers WHERE site_id = ? AND environment = ?")
      .bind(siteId, env)
      .first<{ snapshot_id: string }>();
    return r?.snapshot_id ?? null;
  }
  async setActive(siteId: string, env: SiteEnvironment, id: string) {
    await this.db
      .prepare(
        `INSERT INTO autopilot_site_pointers (site_id, environment, snapshot_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(site_id, environment) DO UPDATE SET snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at`,
      )
      .bind(siteId, env, id, Date.now())
      .run();
  }
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
  tokens: { token: string; from: string | null; to: string | null }[];
}

export function diffContent(a: SiteContent, b: SiteContent): SnapshotDiff {
  const af = Object.keys(a.files);
  const bf = Object.keys(b.files);
  const tokens = [...new Set([...Object.keys(a.themeTokens), ...Object.keys(b.themeTokens)])]
    .sort()
    .filter((k) => a.themeTokens[k] !== b.themeTokens[k])
    .map((k) => ({ token: k, from: a.themeTokens[k] ?? null, to: b.themeTokens[k] ?? null }));
  return {
    added: bf.filter((p) => !(p in a.files)).sort(),
    removed: af.filter((p) => !(p in b.files)).sort(),
    changed: bf.filter((p) => p in a.files && a.files[p] !== b.files[p]).sort(),
    tokens,
  };
}

/**
 * Staging/production version history. Snapshots are immutable; rollback never deletes
 * history — it creates a NEW snapshot whose content equals the target and moves the pointer.
 * Anything touching production (promote, rollback, theme apply) needs a human approval.
 */
export class WebsiteVersioning {
  constructor(private readonly deps: { store: SnapshotStore; gate: ApprovalGate }) {}

  async snapshot(
    siteId: string,
    env: SiteEnvironment,
    content: SiteContent,
    opts: { label?: string; reason?: SnapshotReason; createdBy: string; now?: Date; activate?: boolean },
  ): Promise<Snapshot> {
    const parentId = await this.deps.store.getActiveId(siteId, env);
    const s: Snapshot = {
      id: randomId("snap_"),
      siteId,
      environment: env,
      label: opts.label ?? "",
      reason: opts.reason ?? "manual",
      content: structuredClone(content),
      contentHash: await contentHash(content),
      parentId,
      createdBy: opts.createdBy,
      createdAt: (opts.now ?? new Date()).getTime(),
    };
    await this.deps.store.save(s);
    if (opts.activate !== false) await this.deps.store.setActive(siteId, env, s.id);
    return s;
  }

  async active(siteId: string, env: SiteEnvironment): Promise<Snapshot | null> {
    const id = await this.deps.store.getActiveId(siteId, env);
    return id ? this.deps.store.get(id) : null;
  }

  history(siteId: string, env: SiteEnvironment, limit?: number): Promise<Snapshot[]> {
    return this.deps.store.list(siteId, env, limit);
  }

  async diff(fromId: string, toId: string): Promise<SnapshotDiff> {
    const [a, b] = await Promise.all([this.mustGet(fromId), this.mustGet(toId)]);
    return diffContent(a.content, b.content);
  }

  /** Approval subject: snapshot <stagingSnapshotId>, action "promote", content = its contentHash. */
  async promote(siteId: string, stagingSnapshotId: string, opts: { createdBy: string; now?: Date }): Promise<Snapshot> {
    const src = await this.mustGet(stagingSnapshotId);
    if (src.siteId !== siteId || src.environment !== "staging") throw new Error("Only a staging snapshot of this site can be promoted");
    await this.deps.gate.assert({ subjectType: "snapshot", subjectId: src.id, action: "promote", content: { contentHash: src.contentHash }, ...(opts.now ? { now: opts.now } : {}) });
    return this.snapshot(siteId, "production", src.content, { label: `promoted from ${src.id}`, reason: "promotion", createdBy: opts.createdBy, ...(opts.now ? { now: opts.now } : {}) });
  }

  /**
   * Roll back an environment to an earlier snapshot. Production requires approval
   * (subject: snapshot <targetId>, action "rollback", content = { env, contentHash }).
   */
  async rollback(siteId: string, env: SiteEnvironment, targetId: string, opts: { createdBy: string; now?: Date }): Promise<Snapshot> {
    const target = await this.mustGet(targetId);
    if (target.siteId !== siteId || target.environment !== env) throw new Error("Rollback target must belong to the same site and environment");
    if (env === "production") {
      await this.deps.gate.assert({ subjectType: "snapshot", subjectId: target.id, action: "rollback", content: rollbackApprovalContent(target), ...(opts.now ? { now: opts.now } : {}) });
    }
    return this.snapshot(siteId, env, target.content, { label: `rollback to ${target.id}`, reason: "rollback", createdBy: opts.createdBy, ...(opts.now ? { now: opts.now } : {}) });
  }

  private async mustGet(id: string): Promise<Snapshot> {
    const s = await this.deps.store.get(id);
    if (!s) throw new Error(`Snapshot "${id}" not found`);
    return s;
  }
}

export function rollbackApprovalContent(target: Snapshot): unknown {
  return { env: target.environment, contentHash: target.contentHash };
}
