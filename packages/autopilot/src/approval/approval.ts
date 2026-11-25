import { contentHash, randomId } from "../util/hash.js";
import { changes, type D1DatabaseLike } from "../util/d1.js";

/**
 * Approval levels:
 *  - guarded: one human approval bound to the exact content hash (default; minimum for every
 *    outward-facing action).
 *  - strict: two distinct human approvers, both bound to the same content hash.
 * There is deliberately no "auto" level: publish/send/rollback/promote/apply always need a human.
 */
export type ApprovalLevel = "guarded" | "strict";
export type ApprovalSubjectType = "campaign" | "snapshot" | "theme_proposal" | "send_batch";
export type ApprovalAction = "publish" | "send" | "promote" | "rollback" | "apply";

export interface Approver {
  id: string;
  kind: "human" | "agent";
  role?: "owner" | "admin" | "editor";
  displayName?: string;
}

export interface ApprovalRecord {
  id: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  action: ApprovalAction;
  contentHash: string;
  decision: "approved" | "rejected";
  approver: Approver;
  decidedAt: number;
  expiresAt: number | null;
  note: string | null;
}

export interface ApprovalStore {
  save(record: ApprovalRecord): Promise<void>;
  list(subjectType: ApprovalSubjectType, subjectId: string, action: ApprovalAction): Promise<ApprovalRecord[]>;
}

export class ApprovalRequiredError extends Error {
  override name = "ApprovalRequiredError";
  constructor(
    message: string,
    readonly subjectType: ApprovalSubjectType,
    readonly subjectId: string,
    readonly action: ApprovalAction,
  ) {
    super(message);
  }
}

export interface ApprovalCheck {
  ok: boolean;
  reason: string;
  level: ApprovalLevel;
  contentHash: string;
  approvals: ApprovalRecord[];
}

export interface ApprovalRequest {
  subjectType: ApprovalSubjectType;
  subjectId: string;
  action: ApprovalAction;
  /** The exact content being approved (hashed; any later change invalidates the approval). */
  content: unknown;
}

export class ApprovalGate {
  readonly level: ApprovalLevel;
  private readonly ttlMs: number | null;
  private readonly allowedRoles: ReadonlySet<string> | null;

  constructor(
    private readonly store: ApprovalStore,
    opts: { level?: ApprovalLevel; ttlMs?: number | null; allowedRoles?: NonNullable<Approver["role"]>[] } = {},
  ) {
    this.level = opts.level ?? "guarded";
    this.ttlMs = opts.ttlMs === undefined ? 30 * 24 * 3600_000 : opts.ttlMs;
    this.allowedRoles = opts.allowedRoles ? new Set<string>(opts.allowedRoles) : null;
  }

  async decide(
    req: ApprovalRequest & { approver: Approver; decision?: "approved" | "rejected"; note?: string; now?: Date },
  ): Promise<ApprovalRecord> {
    const decision = req.decision ?? "approved";
    if (decision === "approved") {
      if (req.approver.kind !== "human") throw new Error("Only a human approver can approve outward-facing actions");
      if (this.allowedRoles && !this.allowedRoles.has(req.approver.role ?? "")) {
        throw new Error(`Approver role "${req.approver.role ?? "none"}" is not allowed to approve`);
      }
    }
    if (!req.approver.id.trim()) throw new Error("approver.id is required");
    const now = (req.now ?? new Date()).getTime();
    const record: ApprovalRecord = {
      id: randomId("apr_"),
      subjectType: req.subjectType,
      subjectId: req.subjectId,
      action: req.action,
      contentHash: await contentHash(req.content),
      decision,
      approver: req.approver,
      decidedAt: now,
      expiresAt: this.ttlMs === null ? null : now + this.ttlMs,
      note: req.note ?? null,
    };
    await this.store.save(record);
    return record;
  }

  approve(req: ApprovalRequest & { approver: Approver; note?: string; now?: Date }) {
    return this.decide({ ...req, decision: "approved" });
  }

  reject(req: ApprovalRequest & { approver: Approver; note?: string; now?: Date }) {
    return this.decide({ ...req, decision: "rejected" });
  }

  async check(req: ApprovalRequest & { now?: Date }): Promise<ApprovalCheck> {
    const now = (req.now ?? new Date()).getTime();
    const hash = await contentHash(req.content);
    const all = await this.store.list(req.subjectType, req.subjectId, req.action);
    const base = { level: this.level, contentHash: hash };
    const forContent = all.filter((r) => r.contentHash === hash);
    const latestRejection = forContent.filter((r) => r.decision === "rejected").sort((a, b) => b.decidedAt - a.decidedAt)[0];
    const valid = forContent.filter(
      (r) =>
        r.decision === "approved" &&
        r.approver.kind === "human" &&
        (r.expiresAt === null || r.expiresAt > now) &&
        (!latestRejection || r.decidedAt > latestRejection.decidedAt),
    );
    const latestApproval = forContent.filter((r) => r.decision === "approved").sort((a, b) => b.decidedAt - a.decidedAt)[0];
    if (latestRejection && (!latestApproval || latestRejection.decidedAt >= latestApproval.decidedAt)) {
      return { ...base, ok: false, reason: `rejected by ${latestRejection.approver.id}`, approvals: [] };
    }
    const distinct = new Map(valid.map((r) => [r.approver.id, r]));
    const needed = this.level === "strict" ? 2 : 1;
    if (distinct.size >= needed) return { ...base, ok: true, reason: "approved", approvals: [...distinct.values()] };
    const stale = all.some((r) => r.decision === "approved" && r.contentHash !== hash);
    const expired = forContent.some((r) => r.decision === "approved" && r.expiresAt !== null && r.expiresAt <= now);
    const reason = stale
      ? "content changed after approval — re-approval required"
      : expired
        ? "approval expired"
        : `needs ${needed} human approval(s), has ${distinct.size}`;
    return { ...base, ok: false, reason, approvals: [...distinct.values()] };
  }

  /** Throws ApprovalRequiredError unless approved. */
  async assert(req: ApprovalRequest & { now?: Date }): Promise<ApprovalCheck> {
    const c = await this.check(req);
    if (!c.ok) throw new ApprovalRequiredError(`Approval required for ${req.action} ${req.subjectType}:${req.subjectId} — ${c.reason}`, req.subjectType, req.subjectId, req.action);
    return c;
  }
}

export class MemoryApprovalStore implements ApprovalStore {
  readonly records: ApprovalRecord[] = [];
  async save(r: ApprovalRecord) {
    this.records.push(structuredClone(r));
  }
  async list(t: ApprovalSubjectType, id: string, a: ApprovalAction) {
    return this.records.filter((r) => r.subjectType === t && r.subjectId === id && r.action === a).map((r) => structuredClone(r));
  }
}

interface ApprovalRow {
  id: string;
  subject_type: ApprovalSubjectType;
  subject_id: string;
  action: ApprovalAction;
  content_hash: string;
  decision: "approved" | "rejected";
  approver_json: string;
  decided_at: number;
  expires_at: number | null;
  note: string | null;
}

/** D1-backed approval store (table `autopilot_approvals`). Records are append-only. */
export class D1ApprovalStore implements ApprovalStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async save(r: ApprovalRecord) {
    const res = await this.db
      .prepare(
        `INSERT INTO autopilot_approvals (id, subject_type, subject_id, action, content_hash, decision, approver_id, approver_json, decided_at, expires_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(r.id, r.subjectType, r.subjectId, r.action, r.contentHash, r.decision, r.approver.id, JSON.stringify(r.approver), r.decidedAt, r.expiresAt, r.note)
      .run();
    if (changes(res) !== 1) throw new Error("Failed to persist approval record");
  }
  async list(t: ApprovalSubjectType, id: string, a: ApprovalAction) {
    const res = await this.db
      .prepare("SELECT * FROM autopilot_approvals WHERE subject_type = ? AND subject_id = ? AND action = ? ORDER BY decided_at")
      .bind(t, id, a)
      .all<ApprovalRow>();
    return (res.results ?? []).map((r) => ({
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      action: r.action,
      contentHash: r.content_hash,
      decision: r.decision,
      approver: JSON.parse(r.approver_json) as Approver,
      decidedAt: Number(r.decided_at),
      expiresAt: r.expires_at === null ? null : Number(r.expires_at),
      note: r.note,
    }));
  }
}
