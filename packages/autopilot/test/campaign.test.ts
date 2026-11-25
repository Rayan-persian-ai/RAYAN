import { describe, expect, it, vi } from "vitest";
import {
  EventCalendar,
  CampaignPlanner,
  CampaignPublisher,
  MemoryCampaignStore,
  D1CampaignStore,
  ApprovalGate,
  MemoryApprovalStore,
  AntiSpamGuard,
  MemorySendLogStore,
  ApprovalRequiredError,
  approvalPayload,
  reviseDraft,
  scoreRelevance,
  suggestDiscount,
  buildAudience,
  parseLlmCopy,
  renderBannerSvg,
  wrapText,
  type BusinessProfile,
  type CalendarEvent,
  type Contact,
  type OutgoingMessage,
  type LlmFn,
} from "../src/index.js";
import { assertWellFormedXml } from "./helpers/xml.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";

const cal = new EventCalendar();
const ev = (id: string, year = 2026): CalendarEvent => cal.occurrencesInYear(year).find((e) => e.id === id)!;
const NOW = new Date("2026-11-25T08:00:00Z"); // 11:30 Tehran

const shop: BusinessProfile = {
  id: "biz_anar",
  name: "قنادی انار",
  industry: "food",
  city: "تهران",
  priceRange: "mid",
  websiteUrl: "https://anar.example.ir/shop",
  tone: "formal",
};
const fashion: BusinessProfile = { id: "biz_mod", name: "مزون نیلوفر", industry: "fashion", priceRange: "premium", websiteUrl: "https://niloofar.example.ir" };

const contacts: Contact[] = [
  { id: "c1", phone: "+989120000001", consent: { marketing: true }, tags: ["vip"], city: "تهران" },
  { id: "c2", phone: "+989120000002", consent: { marketing: false } },
  { id: "c3", phone: "+989120000003" },
  { id: "c4", phone: "+989120000004", consent: { marketing: true, revokedAt: "2026-05-01" } },
  { id: "c5", email: "c5@example.com", consent: { marketing: true } }, // no phone
  { id: "c6", phone: "+989120000006", consent: { marketing: true, channels: ["sms"] }, city: "شیراز" },
];

describe("relevance & discount", () => {
  it("scores food shop high for Yalda, low for Cyber Monday; skips mourning and past events", () => {
    const yalda = scoreRelevance(ev("yalda"), shop, NOW);
    expect(yalda.score).toBeGreaterThanOrEqual(60);
    expect(yalda.recommendation).toBe("recommended");
    const cyber = scoreRelevance(ev("cyber_monday"), shop, NOW);
    expect(cyber.score).toBeLessThan(yalda.score);
    expect(scoreRelevance(ev("ashura"), shop, NOW)).toMatchObject({ score: 0, recommendation: "skip" });
    expect(scoreRelevance(ev("nowruz"), shop, NOW)).toMatchObject({ score: 0, recommendation: "skip" }); // March 2026 is past
    expect(scoreRelevance(ev("black_friday"), { ...shop, industry: "electronics" }, NOW).score).toBeGreaterThan(cyber.score);
  });

  it("suggests capped, rounded discounts with deterministic codes", () => {
    const bf = suggestDiscount(ev("black_friday"), { ...shop, industry: "electronics", priceRange: "budget", maxDiscountPercent: 25 });
    expect(bf).toMatchObject({ type: "percent", value: 25 });
    expect(bf.code).toMatch(/^BLACKF05[0-9A-Z]{2}$/);
    expect(suggestDiscount(ev("black_friday"), shop).code).toBe(suggestDiscount(ev("black_friday"), shop).code);
    expect(suggestDiscount(ev("revolution_day"), shop).type).toBe("none");
    expect(suggestDiscount(ev("yalda"), { ...shop, allowDiscounts: false }).type).toBe("gift");
    expect(suggestDiscount(ev("yalda"), { ...shop, maxDiscountPercent: 0 }).type).toBe("free_shipping");
    const y = suggestDiscount(ev("yalda"), shop);
    expect(y.validTo).toBe("2026-12-21");
    expect(y.validFrom).toBe("2026-12-14");
  });

  it("audience contains only consented, reachable contacts", () => {
    const a = buildAudience(contacts, { channel: "sms", consentRequired: true }, NOW);
    expect(a.contactIds).toEqual(["c1", "c6"]);
    expect(a.excluded).toEqual({ noConsent: 3, noAddress: 1, filteredOut: 0 });
    expect(buildAudience(contacts, { channel: "sms", consentRequired: true, cities: ["تهران"] }, NOW).contactIds).toEqual(["c1"]);
    expect(buildAudience(contacts, { channel: "email", consentRequired: true }, NOW).contactIds).toEqual(["c5"]);
  });
});

describe("CampaignPlanner (template fallback)", () => {
  it("produces a complete Persian draft in pending_approval", async () => {
    const d = await new CampaignPlanner().plan(ev("yalda"), shop, { now: NOW, contacts });
    expect(d.status).toBe("pending_approval");
    expect(d.generator).toBe("template");
    expect(d.event).toMatchObject({ id: "yalda", date: "2026-12-21", jalaliDate: "1405/09/30" });
    expect(d.copy.headline).toMatch(/[\u0600-\u06FF]/);
    expect(d.copy.body).toContain("قنادی انار");
    expect(d.copy.body).toContain(d.discount.code!);
    expect(d.copy.sms).toContain("۱۵٪ تخفیف");
    expect(d.copy.hashtags).toContain("#شب_یلدا");
    expect(d.audience.contactIds).toEqual(["c1", "c6"]);
    expect(d.banner).toMatchObject({ width: 1200, height: 628, direction: "rtl", lang: "fa", motif: "pomegranate" });
    expect(d.poster).toMatchObject({ width: 1080, height: 1920 });
    expect(d.schedule).toEqual({ startDate: "2026-12-07", suggestedSendDate: "2026-12-18", suggestedSendLocalTime: "10:00 Asia/Tehran" });
    // deterministic
    const again = await new CampaignPlanner().plan(ev("yalda"), shop, { now: NOW, contacts });
    expect(again.copy).toEqual(d.copy);
    expect(again.id).toBe(d.id);
  });

  it("renders real RTL SVG banners", async () => {
    const d = await new CampaignPlanner().plan(ev("black_friday"), fashion, { now: NOW });
    for (const svg of [d.assets.bannerSvg, d.assets.posterSvg]) {
      assertWellFormedXml(svg);
      expect(svg).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
      expect(svg).toContain('xml:lang="fa"');
      expect(svg).toContain('direction="rtl"');
      expect(svg).toContain("مزون نیلوفر");
      expect(svg).toContain(d.discount.code!);
    }
  });

  it("escapes hostile input in SVG and landing HTML", async () => {
    const evil: BusinessProfile = { ...shop, name: 'فروشگاه <script>alert("x")</script> & co', websiteUrl: "javascript:alert(1)" };
    const d = await new CampaignPlanner().plan(ev("yalda"), evil, { now: NOW });
    assertWellFormedXml(d.assets.bannerSvg);
    expect(d.assets.bannerSvg).not.toContain("<script>");
    expect(d.assets.landingHtml).not.toContain("<script>");
    expect(d.assets.landingHtml).not.toContain("javascript:");
    expect(d.warnings.join(" ")).toMatch(/وب‌سایت/);
  });

  it("landing page is an RTL, noindex draft with UTM-tagged CTA", async () => {
    const d = await new CampaignPlanner().plan(ev("yalda"), shop, { now: NOW });
    const html = d.assets.landingHtml;
    expect(html).toContain('<html lang="fa" dir="rtl">');
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain("utm_source=rayan_autopilot");
    expect(html).toContain(`utm_campaign=${d.id}`);
    expect(html).toContain("پیش‌نویس");
    expect(html).toContain("<svg");
  });

  it("mourning events: no discount, warnings, no promo send", async () => {
    const d = await new CampaignPlanner().plan(ev("ashura", 2027), shop, { now: NOW, contacts });
    expect(d.relevance.recommendation).toBe("skip");
    expect(d.discount.type).toBe("none");
    expect(d.banner.badge).toBeNull();
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  it("wraps long headlines", () => {
    expect(wrapText("یک دو سه چهار پنج شش هفت هشت نه ده", 40, 200).length).toBeGreaterThan(1);
    const svg = renderBannerSvg({
      format: "social_banner", width: 1200, height: 628, lang: "fa", direction: "rtl", fontFamily: "Tahoma",
      background: { from: "#000000", to: "#333333" }, textColor: "#ffffff", accentColor: "#f5c518", ctaTextColor: "#111111",
      brand: "برند", headline: "این یک تیتر بسیار بسیار طولانی است که باید در چند خط شکسته شود تا داخل بنر جا شود و بیرون نزند",
      subline: "زیرعنوان", cta: "خرید", badge: null, code: null, motif: "none", dateLabel: "۱ دی",
    });
    assertWellFormedXml(svg);
    expect((svg.match(/font-weight="800"/g) ?? []).length).toBeLessThanOrEqual(2);
  });
});

describe("CampaignPlanner with injected LLM", () => {
  const good = (d: number | null): LlmFn => async () =>
    "```json\n" +
    JSON.stringify({
      idea_title: "جعبهٔ انار و آجیل یلدا",
      idea_summary: "بستهٔ هدیهٔ یلدا با تحویل همان روز",
      angle: "سنت",
      headline: "یلدای شیرین با قنادی انار",
      body: d === null ? "شب یلدا را با شیرینی‌های تازهٔ ما جشن بگیرید." : `شب یلدا را با شیرینی‌های تازه و ${d}٪ تخفیف جشن بگیرید.`,
      cta: "سفارش دهید",
      sms: "یلدای شیرین با قنادی انار",
      hashtags: ["یلدا", "#شیرینی"],
    }) +
    "\n```";

  it("uses valid LLM copy and keeps the approved code", async () => {
    const d = await new CampaignPlanner({ llm: good(15) }).plan(ev("yalda"), shop, { now: NOW });
    expect(d.generator).toBe("llm");
    expect(d.copy.headline).toBe("یلدای شیرین با قنادی انار");
    expect(d.copy.body).toContain(d.discount.code!);
    expect(d.copy.hashtags).toEqual(["#یلدا", "#شیرینی"]);
    expect(d.status).toBe("pending_approval");
  });

  it("rejects hallucinated discounts and falls back to templates", async () => {
    const d = await new CampaignPlanner({ llm: good(50) }).plan(ev("yalda"), shop, { now: NOW });
    expect(d.generator).toBe("template");
    expect(d.warnings.join(" ")).toMatch(/50%/);
  });

  it("falls back on LLM errors, timeouts and junk", async () => {
    const boom: LlmFn = async () => { throw new Error("quota"); };
    const slow: LlmFn = () => new Promise((r) => setTimeout(() => r("{}"), 1000));
    const junk: LlmFn = async () => "sure! here is your ad";
    const english: LlmFn = async () => JSON.stringify({ idea_title: "Yalda", headline: "Yalda sale", body: "Buy now", cta: "Buy", sms: "Buy" });
    for (const llm of [boom, junk, english]) expect((await new CampaignPlanner({ llm }).plan(ev("yalda"), shop, { now: NOW })).generator).toBe("template");
    const d = await new CampaignPlanner({ llm: slow, llmTimeoutMs: 20 }).plan(ev("yalda"), shop, { now: NOW });
    expect(d.generator).toBe("template");
    expect(d.warnings.join(" ")).toMatch(/timed out/);
  });

  it("parseLlmCopy strips HTML and refuses URLs", () => {
    const raw = JSON.stringify({ idea_title: "ایده", headline: "<b>تیتر</b>", body: "متن https://evil.example", cta: "خرید", sms: "پیامک" });
    expect(parseLlmCopy(raw, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/URL/) });
    const ok = parseLlmCopy(JSON.stringify({ idea_title: "ایده", headline: "<b>تیتر</b>", body: "متن", cta: "خرید", sms: "پیامک ۲۰ درصد" }), 20);
    expect(ok).toMatchObject({ ok: true, copy: { headline: "تیتر" } });
  });

  it("never calls the LLM for mourning events", async () => {
    const llm = vi.fn(good(null));
    await new CampaignPlanner({ llm }).plan(ev("ashura", 2027), shop, { now: NOW });
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("CampaignPublisher (approval-guarded)", () => {
  const owner = { id: "owner_1", kind: "human" as const, role: "owner" as const };
  const setup = async () => {
    const approvals = new MemoryApprovalStore();
    const gate = new ApprovalGate(approvals);
    const guard = new AntiSpamGuard({ store: new MemorySendLogStore() });
    const store = new MemoryCampaignStore();
    const publisher = new CampaignPublisher({ gate, guard, store });
    const draft = await new CampaignPlanner().plan(ev("yalda"), shop, { now: NOW, contacts });
    await store.save(draft);
    return { gate, guard, store, publisher, draft };
  };

  it("refuses to publish or send without approval", async () => {
    const { publisher, draft } = await setup();
    const publishFn = vi.fn(async () => "url");
    await expect(publisher.publish(draft, publishFn, NOW)).rejects.toBeInstanceOf(ApprovalRequiredError);
    const sender = vi.fn(async (_m: OutgoingMessage) => {});
    await expect(publisher.send(draft, contacts, sender, NOW)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(publishFn).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
  });

  it("publishes after approval; an edit invalidates the approval", async () => {
    const { gate, publisher, draft, store } = await setup();
    await gate.approve({ subjectType: "campaign", subjectId: draft.id, action: "publish", content: approvalPayload(draft, "publish"), approver: owner, now: NOW });
    const res = await publisher.publish(draft, async () => "https://anar.example.ir/yalda", NOW);
    expect(res.result).toBe("https://anar.example.ir/yalda");
    expect((await store.get(draft.id))!.status).toBe("published");
    const edited = reviseDraft(draft, { copy: { ...draft.copy, headline: "تیتر جدید" } });
    expect(edited).toMatchObject({ version: 2, status: "pending_approval" });
    await expect(publisher.publish(edited, async () => "x", NOW)).rejects.toThrow(/re-approval|needs/);
  });

  it("sends only to consented audience, re-checking consent at send time", async () => {
    const { gate, publisher, draft } = await setup();
    await gate.approve({ subjectType: "campaign", subjectId: draft.id, action: "send", content: approvalPayload(draft, "send"), approver: owner, now: NOW });
    // c6 revoked consent after approval
    const current = contacts.map((c) => (c.id === "c6" ? { ...c, consent: { marketing: true, revokedAt: "2026-11-25" } } : c));
    const sender = vi.fn(async (_m: OutgoingMessage) => {});
    const sendAt = new Date("2026-12-18T06:30:00Z"); // 10:00 Tehran
    const summary = await publisher.send(draft, current, sender, sendAt);
    expect(summary).toMatchObject({ attempted: 2, sent: 1, refused: { no_consent: 1 } });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]![0]).toMatchObject({ to: "+989120000001", channel: "sms" });
    // re-running the send is deduplicated
    const again = await publisher.send(draft, current, sender, sendAt);
    expect(again.sent).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("a quiet-hours refusal does not burn the dedupe key", async () => {
    const { gate, publisher, draft } = await setup();
    await gate.approve({ subjectType: "campaign", subjectId: draft.id, action: "send", content: approvalPayload(draft, "send"), approver: owner, now: NOW });
    const sender = vi.fn(async (_m: OutgoingMessage) => {});
    const night = await publisher.send(draft, contacts, sender, new Date("2026-12-17T20:00:00Z"));
    expect(night.refused).toEqual({ quiet_hours: 2 });
    const morning = await publisher.send(draft, contacts, sender, new Date("2026-12-18T06:30:00Z"));
    expect(morning.sent).toBe(2);
  });

  it("blocks sends for mourning-event drafts even if approved", async () => {
    const { gate, publisher } = await setup();
    const d = await new CampaignPlanner().plan(ev("ashura", 2027), shop, { now: NOW, contacts });
    await gate.approve({ subjectType: "campaign", subjectId: d.id, action: "send", content: approvalPayload(d, "send"), approver: owner, now: NOW });
    await expect(publisher.send(d, contacts, async () => {}, NOW)).rejects.toThrow(/mourning/);
  });

  it("D1 campaign store round-trips drafts", async () => {
    const store = new D1CampaignStore(createSqliteD1());
    const d = await new CampaignPlanner().plan(ev("yalda"), shop, { now: NOW, contacts });
    await store.save(d);
    expect(await store.get(d.id)).toEqual(d);
    await store.save({ ...d, status: "published" });
    expect((await store.list({ status: "published" })).map((x) => x.id)).toEqual([d.id]);
    expect(await store.list({ status: "pending_approval" })).toEqual([]);
  });
});
