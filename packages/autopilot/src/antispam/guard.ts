import { changes, type D1DatabaseLike } from "../util/d1.js";

export type Channel = "sms" | "email" | "push" | "whatsapp" | "telegram" | "bale" | "eitaa";

export interface ContactConsent {
  /** Explicit opt-in to marketing messages. Anything but `true` means NO. */
  marketing: boolean;
  /** Channels the opt-in covers. Omitted = the opt-in covers every channel. */
  channels?: Channel[];
  grantedAt?: string;
  source?: string;
  /** ISO time of opt-out; a revoked consent is never valid. */
  revokedAt?: string | null;
}

export interface Contact {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
  city?: string;
  tags?: string[];
  lastPurchaseAt?: string;
  consent?: ContactConsent;
}

export function hasMarketingConsent(contact: Contact, channel?: Channel): boolean {
  const c = contact.consent;
  if (!c || c.marketing !== true || c.revokedAt) return false;
  if (channel && c.channels && !c.channels.includes(channel)) return false;
  return true;
}

export function addressFor(contact: Contact, channel: Channel): string | undefined {
  if (channel === "sms" || channel === "whatsapp") return contact.phone;
  if (channel === "email") return contact.email;
  return contact.id; // push/messenger channels address by contact id
}

export interface SendLogStore {
  /** Number of sends recorded under `scope` strictly after `sinceMs`. */
  countSince(scope: string, sinceMs: number): Promise<number>;
  record(scopes: string[], atMs: number): Promise<void>;
  /** Atomically claims a dedupe key. Returns false when already claimed. */
  claim(dedupeKey: string, atMs: number): Promise<boolean>;
  /** Read-only: has the dedupe key been claimed? */
  isClaimed(dedupeKey: string): Promise<boolean>;
}

export class MemorySendLogStore implements SendLogStore {
  private log = new Map<string, number[]>();
  private claimed = new Set<string>();
  async countSince(scope: string, since: number) {
    return (this.log.get(scope) ?? []).filter((t) => t > since).length;
  }
  async record(scopes: string[], at: number) {
    for (const s of scopes) {
      const arr = this.log.get(s) ?? [];
      arr.push(at);
      this.log.set(s, arr);
    }
  }
  async isClaimed(key: string) {
    return this.claimed.has(key);
  }
  async claim(key: string) {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}

/** D1 store: tables `autopilot_send_log` and `autopilot_send_dedupe`. */
export class D1SendLogStore implements SendLogStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async countSince(scope: string, since: number) {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM autopilot_send_log WHERE scope = ? AND sent_at > ?").bind(scope, since).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }
  async record(scopes: string[], at: number) {
    for (const s of scopes) await this.db.prepare("INSERT INTO autopilot_send_log (scope, sent_at) VALUES (?, ?)").bind(s, at).run();
  }
  async isClaimed(key: string) {
    return (await this.db.prepare("SELECT 1 AS x FROM autopilot_send_dedupe WHERE dedupe_key = ?").bind(key).first()) !== null;
  }
  async claim(key: string, at: number) {
    const r = await this.db.prepare("INSERT INTO autopilot_send_dedupe (dedupe_key, claimed_at) VALUES (?, ?) ON CONFLICT(dedupe_key) DO NOTHING").bind(key, at).run();
    return changes(r) === 1;
  }
}

export interface AntiSpamLimits {
  perRecipientPerDay: number;
  perRecipientPerWeek: number;
  globalPerMinute: number;
  globalPerHour: number;
}

export interface QuietHours {
  /** Local hour sends become forbidden (e.g. 21). */
  startHour: number;
  /** Local hour sends are allowed again (e.g. 9). */
  endHour: number;
  utcOffsetMinutes: number;
}

export interface OutgoingMessage {
  channel: Channel;
  to: string;
  body: string;
  subject?: string;
  contactId: string;
  campaignId?: string;
}

export type Sender = (msg: OutgoingMessage) => Promise<void>;

export type GuardRefusal =
  | "no_consent"
  | "no_address"
  | "duplicate"
  | "quiet_hours"
  | "global_rate_limited"
  | "recipient_rate_limited"
  | "empty_message";

export type GuardResult = { sent: true; message: OutgoingMessage } | { sent: false; reason: GuardRefusal; detail?: string } | { sent: false; reason: "send_failed"; detail: string };

export interface AntiSpamGuardOptions {
  store: SendLogStore;
  limits?: Partial<AntiSpamLimits>;
  /** Default: no sends 21:00–09:00 Tehran time. Pass null to disable. */
  quietHours?: QuietHours | null;
  /** Appended to SMS bodies that don't already contain it (e.g. "لغو۱۱"). */
  smsOptOutFooter?: string | null;
}

export const DEFAULT_LIMITS: AntiSpamLimits = {
  perRecipientPerDay: 1,
  perRecipientPerWeek: 3,
  globalPerMinute: 60,
  globalPerHour: 2000,
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Every marketing send MUST go through `guard.send`. It refuses without explicit consent,
 * deduplicates per (campaign, contact, channel), honours quiet hours and rate limits.
 * Delivery semantics: at-most-once per dedupe key (a failed provider call is not retried
 * automatically, to avoid double messages).
 * Note: limits are check-then-record; across many concurrent Workers isolates they are
 * best-effort (use a Durable Object store for strict global limits).
 */
export class AntiSpamGuard {
  private readonly store: SendLogStore;
  readonly limits: AntiSpamLimits;
  private readonly quiet: QuietHours | null;
  private readonly footer: string | null;

  constructor(opts: AntiSpamGuardOptions) {
    this.store = opts.store;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.quiet = opts.quietHours === undefined ? { startHour: 21, endHour: 9, utcOffsetMinutes: 210 } : opts.quietHours;
    this.footer = opts.smsOptOutFooter === undefined ? "لغو۱۱" : opts.smsOptOutFooter;
  }

  isQuietTime(now: Date): boolean {
    if (!this.quiet) return false;
    const local = new Date(now.getTime() + this.quiet.utcOffsetMinutes * MIN);
    const h = local.getUTCHours();
    const { startHour: s, endHour: e } = this.quiet;
    return s > e ? h >= s || h < e : h >= s && h < e;
  }

  /** Dry-run check without sending or recording anything. */
  async check(contact: Contact, channel: Channel, now = new Date()): Promise<{ allowed: true } | { allowed: false; reason: GuardRefusal; detail?: string }> {
    if (!hasMarketingConsent(contact, channel)) return { allowed: false, reason: "no_consent" };
    if (!addressFor(contact, channel)) return { allowed: false, reason: "no_address" };
    if (this.isQuietTime(now)) return { allowed: false, reason: "quiet_hours" };
    const t = now.getTime();
    if ((await this.store.countSince(`global:${channel}`, t - MIN)) >= this.limits.globalPerMinute)
      return { allowed: false, reason: "global_rate_limited", detail: "per minute" };
    if ((await this.store.countSince(`global:${channel}`, t - HOUR)) >= this.limits.globalPerHour)
      return { allowed: false, reason: "global_rate_limited", detail: "per hour" };
    const rk = `recipient:${contact.id}`;
    if ((await this.store.countSince(rk, t - DAY)) >= this.limits.perRecipientPerDay)
      return { allowed: false, reason: "recipient_rate_limited", detail: "per day" };
    if ((await this.store.countSince(rk, t - 7 * DAY)) >= this.limits.perRecipientPerWeek)
      return { allowed: false, reason: "recipient_rate_limited", detail: "per week" };
    return { allowed: true };
  }

  async send(
    contact: Contact,
    channel: Channel,
    content: { body: string; subject?: string },
    sender: Sender,
    opts: { campaignId?: string; now?: Date } = {},
  ): Promise<GuardResult> {
    const now = opts.now ?? new Date();
    if (!content.body?.trim()) return { sent: false, reason: "empty_message" };
    const dedupeKey = `${opts.campaignId ?? "adhoc"}:${contact.id}:${channel}`;
    // Read-only duplicate check first so a refusal (e.g. quiet hours) doesn't burn the key.
    if (opts.campaignId && hasMarketingConsent(contact, channel) && (await this.store.isClaimed(dedupeKey))) return { sent: false, reason: "duplicate" };
    const c = await this.check(contact, channel, now);
    if (!c.allowed) return { sent: false, reason: c.reason, ...(c.detail ? { detail: c.detail } : {}) };
    // Atomic claim closes the race between concurrent senders.
    if (opts.campaignId && !(await this.store.claim(dedupeKey, now.getTime()))) return { sent: false, reason: "duplicate" };
    let body = content.body.trim();
    if (channel === "sms" && this.footer && !body.includes(this.footer)) body = `${body}\n${this.footer}`;
    const message: OutgoingMessage = {
      channel,
      to: addressFor(contact, channel)!,
      body,
      contactId: contact.id,
      ...(content.subject ? { subject: content.subject } : {}),
      ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
    };
    try {
      await sender(message);
    } catch (e) {
      return { sent: false, reason: "send_failed", detail: e instanceof Error ? e.message : String(e) };
    }
    await this.store.record([`global:${channel}`, `recipient:${contact.id}`], now.getTime());
    return { sent: true, message };
  }
}
