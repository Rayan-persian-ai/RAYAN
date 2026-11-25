import type { AgentManifest } from './agents.js';
import { AUTONOMY_LEVELS, type AutonomyLevel, type RiskLevel, type UserContext } from './types.js';
import { fnv1a, newId, stableStringify, systemClock, type Clock } from './util.js';

export interface ActionDescriptor {
  /** Tool name or action id, e.g. 'admin.write'. */
  name: string;
  risk: RiskLevel;
  /** Explicit level declared by the tool; combined with risk and agent floor (strictest wins). */
  level?: AutonomyLevel;
  input?: unknown;
}

export interface ApprovalRequest {
  id: string;
  userId: string;
  agentSlug: string;
  action: string;
  level: Exclude<AutonomyLevel, 'automatic'>;
  fingerprint: string;
  inputPreview: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  approvedBy?: string;
}

export type PermissionDecision =
  | { outcome: 'allow'; level: AutonomyLevel; via: 'automatic' | 'grant'; approvalId?: string }
  | { outcome: 'approval_required'; level: Exclude<AutonomyLevel, 'automatic'>; approval: ApprovalRequest };

export interface PermissionPolicy {
  /** Level implied by risk (default low→automatic, medium→guarded, high→restricted). */
  riskLevels: Record<RiskLevel, AutonomyLevel>;
  /** Per-action overrides, e.g. { 'web.search': 'automatic' } — can only TIGHTEN unless allowLoosen. */
  overrides: Record<string, AutonomyLevel>;
  allowLoosen: boolean;
  /** Roles allowed to approve each level. */
  approverRoles: Record<Exclude<AutonomyLevel, 'automatic'>, string[]>;
  approvalTtlMs: number;
}

export const DEFAULT_POLICY: PermissionPolicy = {
  riskLevels: { low: 'automatic', medium: 'guarded', high: 'restricted' },
  overrides: {},
  allowLoosen: false,
  approverRoles: { guarded: ['owner', 'user', 'admin'], restricted: ['owner'] },
  approvalTtlMs: 24 * 3600_000,
};

const RANK: Record<AutonomyLevel, number> = { automatic: 0, guarded: 1, restricted: 2 };
export function strictest(...levels: (AutonomyLevel | undefined)[]): AutonomyLevel {
  let out: AutonomyLevel = 'automatic';
  for (const l of levels) if (l && RANK[l] > RANK[out]) out = l;
  return out;
}

/**
 * Decides whether an action may run. 'automatic' runs; 'guarded' and 'restricted' produce an
 * ApprovalRequest instead of executing. An approval becomes a single-use grant bound to the exact
 * (user, agent, action, input) fingerprint, so approving one call never authorises a different one.
 */
export class PermissionManager {
  readonly policy: PermissionPolicy;
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly byFingerprint = new Map<string, string>();

  constructor(policy: Partial<PermissionPolicy> = {}, private readonly clock: Clock = systemClock) {
    this.policy = {
      ...DEFAULT_POLICY,
      ...policy,
      riskLevels: { ...DEFAULT_POLICY.riskLevels, ...policy.riskLevels },
      approverRoles: { ...DEFAULT_POLICY.approverRoles, ...policy.approverRoles },
      overrides: { ...policy.overrides },
    };
    for (const [k, v] of Object.entries(this.policy.overrides)) {
      if (!(AUTONOMY_LEVELS as readonly string[]).includes(v)) throw new Error(`invalid autonomy override for ${k}: ${v}`);
    }
  }

  levelFor(action: ActionDescriptor, agent?: Pick<AgentManifest, 'autonomy'>): AutonomyLevel {
    const base = strictest(this.policy.riskLevels[action.risk], action.level, agent?.autonomy);
    const ov = this.policy.overrides[action.name];
    if (!ov) return base;
    return this.policy.allowLoosen ? ov : strictest(base, ov);
  }

  fingerprint(user: UserContext, agentSlug: string, action: ActionDescriptor): string {
    return fnv1a(stableStringify({ u: user.userId, a: agentSlug, n: action.name, i: action.input ?? null })) +
      fnv1a(stableStringify([action.input ?? null, action.name, agentSlug, user.userId]));
  }

  decide(user: UserContext, agent: Pick<AgentManifest, 'slug' | 'autonomy'>, action: ActionDescriptor): PermissionDecision {
    const level = this.levelFor(action, agent);
    if (level === 'automatic') return { outcome: 'allow', level, via: 'automatic' };
    const fp = this.fingerprint(user, agent.slug, action);
    const existingId = this.byFingerprint.get(fp);
    const existing = existingId ? this.approvals.get(existingId) : undefined;
    const now = this.clock();
    if (existing && existing.expiresAt <= now && existing.status !== 'consumed') existing.status = 'expired';
    if (existing && existing.status === 'approved') {
      existing.status = 'consumed'; // single use
      this.byFingerprint.delete(fp);
      return { outcome: 'allow', level, via: 'grant', approvalId: existing.id };
    }
    if (existing && existing.status === 'pending') return { outcome: 'approval_required', level, approval: existing };
    const approval: ApprovalRequest = {
      id: newId('apr'),
      userId: user.userId,
      agentSlug: agent.slug,
      action: action.name,
      level,
      fingerprint: fp,
      inputPreview: stableStringify(action.input ?? null).slice(0, 500),
      reason: level === 'restricted' ? `"${action.name}" is restricted; owner approval required` : `"${action.name}" is guarded; user approval required`,
      createdAt: now,
      expiresAt: now + this.policy.approvalTtlMs,
      status: 'pending',
    };
    this.approvals.set(approval.id, approval);
    this.byFingerprint.set(fp, approval.id);
    return { outcome: 'approval_required', level, approval };
  }

  /** Approve a pending request. The approver must own the request and hold a role allowed for its level. */
  approve(approvalId: string, approver: UserContext): ApprovalRequest {
    const a = this.mustGet(approvalId);
    if (a.userId !== approver.userId) throw new Error('approver does not own this request');
    if (a.expiresAt <= this.clock()) {
      a.status = 'expired';
      throw new Error('approval request expired');
    }
    if (a.status !== 'pending') throw new Error(`approval is ${a.status}`);
    const roles = approver.roles ?? ['user'];
    if (!roles.some((r) => this.policy.approverRoles[a.level].includes(r))) {
      throw new Error(`role(s) ${roles.join(',')} cannot approve ${a.level} actions`);
    }
    a.status = 'approved';
    a.approvedBy = approver.userId;
    return a;
  }

  reject(approvalId: string, approver: UserContext): ApprovalRequest {
    const a = this.mustGet(approvalId);
    if (a.userId !== approver.userId) throw new Error('approver does not own this request');
    a.status = 'rejected';
    this.byFingerprint.delete(a.fingerprint);
    return a;
  }

  get(approvalId: string) {
    return this.approvals.get(approvalId);
  }

  pending(userId: string): ApprovalRequest[] {
    const now = this.clock();
    return [...this.approvals.values()].filter((a) => a.userId === userId && a.status === 'pending' && a.expiresAt > now);
  }

  private mustGet(id: string) {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`unknown approval ${id}`);
    return a;
  }
}
