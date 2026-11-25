import { describe, expect, it, vi } from "vitest";
import {
  AntiSpamGuard,
  MemorySendLogStore,
  D1SendLogStore,
  ApprovalGate,
  MemoryApprovalStore,
  D1ApprovalStore,
  ApprovalRequiredError,
  hasMarketingConsent,
  type Contact,
  type OutgoingMessage,
  type Approver,
} from "../src/index.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";

const human: Approver = { id: "u_owner", kind: "human", role: "owner" };
const human2: Approver = { id: "u_admin", kind: "human", role: "admin" };
const agent: Approver = { id: "agent_cortex", kind: "agent" };
// 11:00 Tehran
const noonish = new Date("2026-11-26T07:30:00Z");

const consented = (id: string, extra: Partial<Contact> = {}): Contact => ({
  id,
  phone: `+98912000${id.padStart(4, "0")}`,
  email: `${id}@example.com`,
  consent: { marketing: true, grantedAt: "2026-01-01" },
  ...extra,
});

describe("consent", () => {
  it("requires an explicit, non-revoked marketing opt-in for the channel", () => {
    expect(hasMarketingConsent({ id: "a" })).toBe(false);
    expect(hasMarketingConsent({ id: "a", consent: { marketing: false } })).toBe(false);
    expect(hasMarketingConsent({ id: "a", consent: { marketing: true, revokedAt: "2026-02-01" } })).toBe(false);
    expect(hasMarketingConsent({ id: "a", consent: { marketing: true, channels: ["email"] } }, "sms")).toBe(false);
    expect(hasMarketingConsent({ id: "a", consent: { marketing: true, channels: ["email"] } }, "email")).toBe(true);
    expect(hasMarketingConsent(consented("1"), "sms")).toBe(true);
  });
});

describe("AntiSpamGuard", () => {
  it("refuses sends without consent and never calls the sender", async () => {
    const guard = new AntiSpamGuard({ store: new MemorySendLogStore() });
    const sender = vi.fn(async (_m: OutgoingMessage) => {});
    const r = await guard.send({ id: "x", phone: "+989120000000" }, "sms", { body: "سلام" }, sender, { now: noonish });
    expect(r).toEqual({ sent: false, reason: "no_consent" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("appends the SMS opt-out footer and dedupes per campaign", async () => {
    const guard = new AntiSpamGuard({ store: new MemorySendLogStore(), limits: { perRecipientPerDay: 5 } });
    const sender = vi.fn(async (_m: OutgoingMessage) => {});
    const r = await guard.send(consented("1"), "sms", { body: "تخفیف یلدا" }, sender, { campaignId: "c1", now: noonish });
    expect(r.sent).toBe(true);
    expect(sender.mock.calls[0]![0]).toMatchObject({ to: "+989120000001", body: "تخفیف یلدا\nلغو۱۱", campaignId: "c1" });
    expect(await guard.send(consented("1"), "sms", { body: "تخفیف یلدا" }, sender, { campaignId: "c1", now: noonish })).toEqual({ sent: false, reason: "duplicate" });
  });

  it("rate-limits per recipient (day/week) and globally", async () => {
    const store = new MemorySendLogStore();
    const guard = new AntiSpamGuard({ store, limits: { perRecipientPerDay: 1, perRecipientPerWeek: 2, globalPerMinute: 3 } });
    const send = vi.fn(async (_m: OutgoingMessage) => {});
    const day = 86_400_000;
    expect((await guard.send(consented("1"), "sms", { body: "a" }, send, { campaignId: "c1", now: noonish })).sent).toBe(true);
    expect(await guard.send(consented("1"), "sms", { body: "b" }, send, { campaignId: "c2", now: noonish })).toMatchObject({ reason: "recipient_rate_limited", detail: "per day" });
    expect((await guard.send(consented("1"), "sms", { body: "c" }, send, { campaignId: "c3", now: new Date(noonish.getTime() + day) })).sent).toBe(true);
    expect(await guard.send(consented("1"), "sms", { body: "d" }, send, { campaignId: "c4", now: new Date(noonish.getTime() + 2 * day) })).toMatchObject({
      reason: "recipient_rate_limited",
      detail: "per week",
    });
    const g2 = new AntiSpamGuard({ store: new MemorySendLogStore(), limits: { globalPerMinute: 3 } });
    const results = [];
    for (let i = 1; i <= 5; i += 1) results.push(await g2.send(consented(String(i)), "sms", { body: "x" }, send, { campaignId: "g", now: noonish }));
    expect(results.filter((r) => r.sent)).toHaveLength(3);
    expect(results[3]).toMatchObject({ reason: "global_rate_limited" });
  });

  it("honours quiet hours in Tehran time", async () => {
    const guard = new AntiSpamGuard({ store: new MemorySendLogStore() });
    expect(guard.isQuietTime(new Date("2026-11-26T18:00:00Z"))).toBe(true); // 21:30 Tehran
    expect(guard.isQuietTime(new Date("2026-11-26T05:00:00Z"))).toBe(true); // 08:30 Tehran
    expect(guard.isQuietTime(new Date("2026-11-26T05:30:00Z"))).toBe(false); // 09:00 Tehran
    const r = await guard.send(consented("1"), "sms", { body: "x" }, async () => {}, { now: new Date("2026-11-26T20:00:00Z") });
    expect(r).toEqual({ sent: false, reason: "quiet_hours" });
  });

  it("reports provider failures, refuses empty bodies and missing addresses", async () => {
    const guard = new AntiSpamGuard({ store: new MemorySendLogStore() });
    expect(await guard.send(consented("1"), "sms", { body: "  " }, async () => {}, { now: noonish })).toEqual({ sent: false, reason: "empty_message" });
    expect(await guard.send(consented("1", { phone: undefined }), "sms", { body: "x" }, async () => {}, { now: noonish })).toEqual({ sent: false, reason: "no_address" });
    const r = await guard.send(consented("2"), "email", { body: "x", subject: "s" }, async () => { throw new Error("provider down"); }, { now: noonish });
    expect(r).toEqual({ sent: false, reason: "send_failed", detail: "provider down" });
  });

  it("works on the D1 send-log store", async () => {
    const guard = new AntiSpamGuard({ store: new D1SendLogStore(createSqliteD1()), quietHours: null });
    const send = vi.fn(async (_m: OutgoingMessage) => {});
    expect((await guard.send(consented("1"), "email", { body: "x" }, send, { campaignId: "c", now: noonish })).sent).toBe(true);
    expect(await guard.send(consented("1"), "email", { body: "x" }, send, { campaignId: "c", now: noonish })).toEqual({ sent: false, reason: "duplicate" });
    expect(await guard.send(consented("1"), "email", { body: "x" }, send, { campaignId: "c2", now: noonish })).toMatchObject({ reason: "recipient_rate_limited" });
  });
});

describe("ApprovalGate", () => {
  const req = { subjectType: "campaign" as const, subjectId: "cmp_1", action: "publish" as const, content: { headline: "یلدا" } };

  for (const [name, mk] of [
    ["memory", () => new MemoryApprovalStore()],
    ["D1", () => new D1ApprovalStore(createSqliteD1())],
  ] as const) {
    it(`guarded: one human approval bound to content (${name})`, async () => {
      const gate = new ApprovalGate(mk());
      expect((await gate.check(req)).ok).toBe(false);
      await expect(gate.assert(req)).rejects.toBeInstanceOf(ApprovalRequiredError);
      await gate.approve({ ...req, approver: human });
      expect((await gate.check(req)).ok).toBe(true);
      const changed = await gate.check({ ...req, content: { headline: "یلدا!" } });
      expect(changed).toMatchObject({ ok: false, reason: expect.stringMatching(/content changed/) });
      expect((await gate.check({ ...req, action: "send" })).ok).toBe(false); // approval is per action
    });
  }

  it("refuses agent approvals and disallowed roles", async () => {
    const gate = new ApprovalGate(new MemoryApprovalStore(), { allowedRoles: ["owner"] });
    await expect(gate.approve({ ...req, approver: agent })).rejects.toThrow(/human/);
    await expect(gate.approve({ ...req, approver: human2 })).rejects.toThrow(/role/);
    await gate.approve({ ...req, approver: human });
    expect((await gate.check(req)).ok).toBe(true);
  });

  it("strict level needs two distinct humans", async () => {
    const gate = new ApprovalGate(new MemoryApprovalStore(), { level: "strict" });
    await gate.approve({ ...req, approver: human });
    await gate.approve({ ...req, approver: human });
    expect((await gate.check(req)).ok).toBe(false);
    await gate.approve({ ...req, approver: human2 });
    expect((await gate.check(req)).ok).toBe(true);
  });

  it("a later rejection overrides, approvals expire", async () => {
    const gate = new ApprovalGate(new MemoryApprovalStore(), { ttlMs: 60_000 });
    const t = new Date("2026-11-25T10:00:00Z");
    await gate.approve({ ...req, approver: human, now: t });
    await gate.reject({ ...req, approver: human2, now: new Date(t.getTime() + 1000), note: "متن اصلاح شود" });
    expect(await gate.check({ ...req, now: new Date(t.getTime() + 2000) })).toMatchObject({ ok: false, reason: "rejected by u_admin" });
    await gate.approve({ ...req, approver: human, now: new Date(t.getTime() + 3000) });
    expect((await gate.check({ ...req, now: new Date(t.getTime() + 4000) })).ok).toBe(true);
    expect(await gate.check({ ...req, now: new Date(t.getTime() + 120_000) })).toMatchObject({ ok: false, reason: "approval expired" });
  });

  it("D1 approvals table is append-only", async () => {
    const db = createSqliteD1();
    const gate = new ApprovalGate(new D1ApprovalStore(db));
    await gate.approve({ ...req, approver: human });
    expect(() => db.raw.exec("UPDATE autopilot_approvals SET decision = 'approved'")).toThrow(/append-only/);
    expect(() => db.raw.exec("DELETE FROM autopilot_approvals")).toThrow(/append-only/);
  });
});
