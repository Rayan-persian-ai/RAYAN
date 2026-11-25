import type { ApprovalGate, ApprovalAction } from "../approval/approval.js";
import type { AntiSpamGuard, Channel, Contact, GuardResult, Sender } from "../antispam/guard.js";
import { changes, type D1DatabaseLike } from "../util/d1.js";
import type { CampaignDraft, CampaignStatus } from "./types.js";

/**
 * The exact content a human approves. Any change to copy, assets, discount, audience or
 * schedule changes the hash and invalidates earlier approvals.
 */
export function approvalPayload(draft: CampaignDraft, action: ApprovalAction): unknown {
  return {
    id: draft.id,
    version: draft.version,
    action,
    copy: draft.copy,
    discount: draft.discount,
    assets: draft.assets,
    schedule: draft.schedule,
    audience: action === "send" ? draft.audience.contactIds : undefined,
    channel: action === "send" ? draft.audience.definition.channel : undefined,
  };
}

export interface CampaignStore {
  get(id: string): Promise<CampaignDraft | null>;
  save(draft: CampaignDraft): Promise<void>;
  list(filter?: { status?: CampaignStatus; businessId?: string }): Promise<CampaignDraft[]>;
}

export class MemoryCampaignStore implements CampaignStore {
  private items = new Map<string, CampaignDraft>();
  async get(id: string) {
    const d = this.items.get(id);
    return d ? structuredClone(d) : null;
  }
  async save(d: CampaignDraft) {
    this.items.set(d.id, structuredClone(d));
  }
  async list(f: { status?: CampaignStatus; businessId?: string } = {}) {
    return [...this.items.values()]
      .filter((d) => (!f.status || d.status === f.status) && (!f.businessId || d.businessId === f.businessId))
      .map((d) => structuredClone(d));
  }
}

/** D1 store (table `autopilot_campaigns`); the full draft is stored as JSON. */
export class D1CampaignStore implements CampaignStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async get(id: string) {
    const r = await this.db.prepare("SELECT draft_json FROM autopilot_campaigns WHERE id = ?").bind(id).first<{ draft_json: string }>();
    return r ? (JSON.parse(r.draft_json) as CampaignDraft) : null;
  }
  async save(d: CampaignDraft) {
    const res = await this.db
      .prepare(
        `INSERT INTO autopilot_campaigns (id, business_id, event_instance_id, status, version, relevance_score, generator, draft_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, version = excluded.version, relevance_score = excluded.relevance_score,
           generator = excluded.generator, draft_json = excluded.draft_json, updated_at = excluded.updated_at`,
      )
      .bind(d.id, d.businessId, d.event.instanceId, d.status, d.version, d.relevance.score, d.generator, JSON.stringify(d), Date.parse(d.createdAt), Date.now())
      .run();
    if (changes(res) < 1) throw new Error("Failed to save campaign");
  }
  async list(f: { status?: CampaignStatus; businessId?: string } = {}) {
    const r = await this.db
      .prepare("SELECT draft_json FROM autopilot_campaigns WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR business_id = ?2) ORDER BY created_at DESC")
      .bind(f.status ?? null, f.businessId ?? null)
      .all<{ draft_json: string }>();
    return (r.results ?? []).map((x) => JSON.parse(x.draft_json) as CampaignDraft);
  }
}

/** Applies an edit to a draft: bumps version and resets status to pending_approval. */
export function reviseDraft(draft: CampaignDraft, patch: Partial<Pick<CampaignDraft, "copy" | "discount" | "idea" | "schedule">>): CampaignDraft {
  return { ...structuredClone(draft), ...structuredClone(patch), version: draft.version + 1, status: "pending_approval" };
}

export interface SendSummary {
  campaignId: string;
  attempted: number;
  sent: number;
  refused: Record<string, number>;
  results: { contactId: string; result: GuardResult }[];
}

/**
 * The only path from a draft to the outside world. Every publish/send asserts a human
 * approval (guarded level or stricter) bound to the draft's current content.
 */
export class CampaignPublisher {
  constructor(private readonly deps: { gate: ApprovalGate; guard: AntiSpamGuard; store?: CampaignStore }) {}

  async publish<T>(draft: CampaignDraft, publishFn: (d: CampaignDraft) => Promise<T>, now = new Date()): Promise<{ draft: CampaignDraft; result: T }> {
    if (draft.status === "rejected" || draft.status === "archived") throw new Error(`Cannot publish a ${draft.status} campaign`);
    await this.deps.gate.assert({ subjectType: "campaign", subjectId: draft.id, action: "publish", content: approvalPayload(draft, "publish"), now });
    const result = await publishFn(draft);
    const updated: CampaignDraft = { ...draft, status: "published" };
    await this.deps.store?.save(updated);
    return { draft: updated, result };
  }

  async send(draft: CampaignDraft, contacts: Contact[], sender: Sender, now = new Date()): Promise<SendSummary> {
    if (draft.status === "rejected" || draft.status === "archived") throw new Error(`Cannot send a ${draft.status} campaign`);
    if (draft.tags.includes("mourning"))
      throw new Error("Promotional sends are blocked for mourning events");
    await this.deps.gate.assert({ subjectType: "campaign", subjectId: draft.id, action: "send", content: approvalPayload(draft, "send"), now });
    const channel: Channel = draft.audience.definition.channel;
    const allowed = new Set(draft.audience.contactIds);
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const summary: SendSummary = { campaignId: draft.id, attempted: 0, sent: 0, refused: {}, results: [] };
    for (const id of allowed) {
      const c = byId.get(id);
      if (!c) continue;
      summary.attempted += 1;
      // Consent is re-checked at send time by the guard (consent may have been revoked since approval).
      const body = channel === "sms" ? draft.copy.sms : `${draft.copy.body}`;
      const result = await this.deps.guard.send(c, channel, { body, ...(channel === "email" ? { subject: draft.copy.headline } : {}) }, sender, {
        campaignId: draft.id,
        now,
      });
      summary.results.push({ contactId: id, result });
      if (result.sent) summary.sent += 1;
      else summary.refused[result.reason] = (summary.refused[result.reason] ?? 0) + 1;
    }
    const updated: CampaignDraft = { ...draft, status: "sent" };
    await this.deps.store?.save(updated);
    return summary;
  }
}
