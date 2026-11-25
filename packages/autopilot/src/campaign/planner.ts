import type { CalendarEvent, EventTag } from "../calendar/events.js";
import { addDaysIso, diffDaysIso, isoToJdn, toIsoDate } from "../calendar/civil.js";
import { formatJalali, jdnToJalali, toPersianDigits } from "../calendar/jalali.js";
import { hasMarketingConsent, addressFor, type Channel, type Contact } from "../antispam/guard.js";
import { bestTextColor, isHexColor, normalizeHex, mix } from "../util/color.js";
import { fnv1a } from "../util/hash.js";
import { BANNER_SIZES, renderBannerSvg } from "./svg.js";
import { renderLandingHtml, safeHttpUrl } from "./landing.js";
import { COPY_TEMPLATES, CTA_BY_TONE, THEME_PALETTES, fill, themeFor, type CampaignTheme } from "./templates.js";
import type {
  Audience, AudienceDefinition, BannerFormat, BannerSpec, BusinessProfile, CampaignCopy, CampaignDraft, CampaignIdea,
  DiscountSuggestion, Industry, LlmFn, RelevanceResult,
} from "./types.js";

/** How strongly an industry benefits from an event tag (0..1). */
export const INDUSTRY_AFFINITY: Record<Industry, Partial<Record<EventTag, number>>> = {
  fashion: { fashion: 1, new_year: 0.9, gifting: 0.8, sale: 0.9, women: 0.7, men: 0.7, shopping: 0.8, romance: 0.6, kids: 0.5 },
  food: { food: 1, family: 0.9, new_year: 0.7, nature: 0.6, religious: 0.5, gifting: 0.4 },
  restaurant: { food: 1, family: 0.9, romance: 0.8, new_year: 0.5, women: 0.5, men: 0.5 },
  electronics: { tech: 1, sale: 1, shopping: 0.8, gifting: 0.6, education: 0.6, men: 0.5, new_year: 0.5 },
  beauty: { beauty: 1, women: 0.9, romance: 0.8, gifting: 0.8, new_year: 0.7, sale: 0.7 },
  education: { education: 1, career: 0.7, kids: 0.6, new_year: 0.3, tech: 0.4 },
  home: { home: 1, new_year: 0.9, family: 0.7, sale: 0.8, shopping: 0.6 },
  travel: { travel: 1, nature: 0.9, new_year: 0.8, family: 0.6, romance: 0.4 },
  health: { health: 1, career: 0.4, women: 0.4, men: 0.4, new_year: 0.3 },
  kids: { kids: 1, education: 0.8, family: 0.7, new_year: 0.7, gifting: 0.6, nature: 0.4 },
  jewelry: { gifting: 1, romance: 1, women: 0.9, new_year: 0.6, men: 0.4 },
  books: { education: 0.9, gifting: 0.8, national_pride: 0.5, family: 0.5, kids: 0.5 },
  services: { new_year: 0.5, sale: 0.5, career: 0.5, shopping: 0.3 },
  general: { shopping: 0.7, sale: 0.7, gifting: 0.6, new_year: 0.6, family: 0.4 },
};

export function scoreRelevance(event: CalendarEvent, profile: BusinessProfile, now: Date | string = new Date()): RelevanceResult {
  const today = toIsoDate(now);
  const daysUntil = diffDaysIso(today, event.date);
  const reasons: string[] = [];
  if (event.sensitivity === "mourning") {
    return { score: 0, recommendation: "skip", reasons: ["ایام سوگواری؛ کمپین تبلیغاتی توصیه نمی‌شود."], daysUntil };
  }
  if (daysUntil + event.durationDays - 1 < 0) {
    return { score: 0, recommendation: "skip", reasons: ["مناسبت گذشته است."], daysUntil };
  }
  const aff = INDUSTRY_AFFINITY[profile.industry] ?? INDUSTRY_AFFINITY.general;
  const weights = event.tags.map((t) => ({ t, w: aff[t] ?? 0 })).sort((a, b) => b.w - a.w);
  const top = weights.slice(0, 3);
  const affinity = Math.min(1, top.reduce((s, x) => s + x.w, 0) / 2);
  const matched = top.filter((x) => x.w >= 0.5).map((x) => x.t);
  if (matched.length) reasons.push(`تناسب حوزهٔ کسب‌وکار با موضوعات: ${matched.join("، ")}`);
  else reasons.push("ارتباط موضوعی ضعیف با حوزهٔ کسب‌وکار");

  let timing = 1;
  const lead = event.leadDays;
  if (daysUntil > Math.max(lead * 2, 14)) {
    timing = 0.75;
    reasons.push(`هنوز زود است (${toPersianDigits(daysUntil)} روز مانده)؛ برنامه‌ریزی کنید و نزدیک‌تر اجرا کنید.`);
  } else if (daysUntil < Math.ceil(lead / 3)) {
    timing = 0.7;
    reasons.push("زمان کافی برای آماده‌سازی کامل نیست؛ نسخهٔ سبک و سریع پیشنهاد می‌شود.");
  } else reasons.push("زمان‌بندی مناسب برای شروع کمپین");

  let categoryBoost = event.category === "commercial" ? 0.1 : event.category === "cultural" ? 0.08 : event.category === "national" ? -0.15 : 0;
  if (event.sensitivity === "neutral") {
    categoryBoost -= 0.1;
    reasons.push("مناسبت رسمی/ملی؛ فقط پیام اطلاع‌رسانی یا تبریک ساده.");
  }
  if (event.approximate) reasons.push("تاریخ قمری تقریبی است؛ پیش از اجرا با تقویم رسمی تطبیق دهید.");
  const raw = (0.2 + 0.7 * affinity + categoryBoost) * timing;
  const score = Math.max(0, Math.min(100, Math.round(raw * 100)));
  const recommendation = score >= 60 ? "recommended" : score >= 35 ? "optional" : "skip";
  return { score, recommendation, reasons, daysUntil };
}

const roundTo5 = (v: number) => Math.round(v / 5) * 5;

export function discountCode(event: CalendarEvent, businessId: string): string {
  const slug = event.id.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 6) || "RAYAN";
  const yy = String(event.jalali.jy).slice(-2);
  const suffix = (fnv1a(`${event.instanceId}|${businessId}`) % 1296).toString(36).toUpperCase().padStart(2, "0");
  return `${slug}${yy}${suffix}`;
}

export function suggestDiscount(event: CalendarEvent, profile: BusinessProfile, theme: CampaignTheme = themeFor(event)): DiscountSuggestion {
  const validFrom = addDaysIso(event.date, -Math.min(event.leadDays, 7));
  const validTo = addDaysIso(event.date, event.durationDays - 1 + (theme === "sale" ? 1 : 0));
  if (theme === "respectful" || theme === "national") {
    return { type: "none", value: 0, code: null, validFrom, validTo, rationale: "برای این مناسبت پیشنهاد تخفیف مناسب نیست." };
  }
  if (profile.allowDiscounts === false) {
    return { type: "gift", value: 0, code: null, validFrom, validTo, rationale: "به‌جای تخفیف، بسته‌بندی هدیه یا هدیهٔ کوچک همراه خرید." };
  }
  const base: Record<CampaignTheme, number> = {
    sale: 30, new_year: 20, romance: 15, gifting: 15, family: 15, education: 15, nature: 10, generic: 10, national: 0, respectful: 0,
  };
  let pct = base[theme];
  if (profile.priceRange === "premium") pct -= 5;
  if (profile.priceRange === "budget") pct += 5;
  const cap = Math.max(0, Math.min(90, profile.maxDiscountPercent ?? 30));
  pct = Math.min(roundTo5(pct), cap);
  if (pct < 5) {
    return { type: "free_shipping", value: 0, code: discountCode(event, profile.id), validFrom, validTo, rationale: "سقف تخفیف پایین است؛ ارسال رایگان پیشنهاد می‌شود." };
  }
  return {
    type: "percent",
    value: pct,
    code: discountCode(event, profile.id),
    validFrom,
    validTo,
    rationale: `پایهٔ ${toPersianDigits(base[theme])}٪ برای این نوع مناسبت، تعدیل‌شده با سطح قیمت و سقف ${toPersianDigits(cap)}٪.`,
  };
}

export function offerPhrase(d: DiscountSuggestion): string {
  if (d.type === "percent") return `${toPersianDigits(d.value)}٪ تخفیف`;
  if (d.type === "free_shipping") return "ارسال رایگان";
  if (d.type === "gift") return "هدیهٔ ویژه";
  return "پیشنهادهای ویژه";
}

export function buildAudience(contacts: Contact[], def: AudienceDefinition, now: Date = new Date()): Audience {
  const excluded = { noConsent: 0, noAddress: 0, filteredOut: 0 };
  const ids: string[] = [];
  const exclude = new Set(def.excludeContactIds ?? []);
  const seen = new Set<string>();
  for (const c of contacts) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (!hasMarketingConsent(c, def.channel)) {
      excluded.noConsent += 1;
      continue;
    }
    if (!addressFor(c, def.channel)) {
      excluded.noAddress += 1;
      continue;
    }
    let ok = !exclude.has(c.id);
    if (ok && def.tagsAny?.length) ok = (c.tags ?? []).some((t) => def.tagsAny!.includes(t));
    if (ok && def.cities?.length) ok = !!c.city && def.cities.includes(c.city);
    if (ok && def.purchasedWithinDays !== undefined) {
      const last = c.lastPurchaseAt ? Date.parse(c.lastPurchaseAt) : NaN;
      ok = Number.isFinite(last) && now.getTime() - last <= def.purchasedWithinDays * 86_400_000;
    }
    if (!ok) {
      excluded.filteredOut += 1;
      continue;
    }
    ids.push(c.id);
  }
  return { definition: { ...def, consentRequired: true }, contactIds: ids, size: ids.length, excluded };
}

// ---------------- LLM handling ----------------

interface LlmCopy {
  idea_title: string;
  idea_summary: string;
  angle: string;
  headline: string;
  body: string;
  cta: string;
  sms: string;
  hashtags: string[];
}

const PERSIAN_RE = /[\u0600-\u06FF]/;
const PERCENT_RE = /([0-9۰-۹]{1,3})\s*(?:٪|%|درصد)/g;

function cleanText(s: string, max: number): string {
  return s
    .replace(/<[^>]*>/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function parseLlmCopy(raw: string, allowedPercent: number | null): { ok: true; copy: LlmCopy } | { ok: false; reason: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, reason: "no JSON object in LLM output" };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "invalid JSON from LLM" };
  }
  const str = (k: string, max: number) => (typeof obj[k] === "string" ? cleanText(obj[k] as string, max) : "");
  const copy: LlmCopy = {
    idea_title: str("idea_title", 80),
    idea_summary: str("idea_summary", 300),
    angle: str("angle", 60),
    headline: str("headline", 70),
    body: str("body", 420),
    cta: str("cta", 30),
    sms: str("sms", 160),
    hashtags: Array.isArray(obj.hashtags)
      ? (obj.hashtags as unknown[]).filter((x): x is string => typeof x === "string").map((x) => cleanText(x, 40)).filter(Boolean).slice(0, 6)
      : [],
  };
  for (const k of ["idea_title", "headline", "body", "cta", "sms"] as const) {
    if (!copy[k]) return { ok: false, reason: `LLM output missing "${k}"` };
    if (!PERSIAN_RE.test(copy[k])) return { ok: false, reason: `LLM field "${k}" is not Persian` };
  }
  // Guard against hallucinated offers: any percentage mentioned must equal the approved discount.
  const all = `${copy.headline} ${copy.body} ${copy.sms} ${copy.cta}`;
  for (const m of all.matchAll(PERCENT_RE)) {
    const v = Number(m[1]!.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)));
    if (allowedPercent === null || v !== allowedPercent) return { ok: false, reason: `LLM invented a ${v}% offer` };
  }
  if (/https?:\/\//i.test(all)) return { ok: false, reason: "LLM output contains URLs" };
  copy.hashtags = copy.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/\s+/g, "_"));
  return { ok: true, copy };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`LLM timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------- Planner ----------------

export interface PlanOptions {
  now?: Date;
  contacts?: Contact[];
  channel?: Channel;
  audience?: Partial<Omit<AudienceDefinition, "consentRequired" | "channel">>;
  /** Override the injected LLM for this call; pass null to force templates. */
  llm?: LlmFn | null;
  campaignId?: string;
  bannerFormats?: { banner?: BannerFormat; poster?: BannerFormat };
}

export interface CampaignPlannerOptions {
  llm?: LlmFn;
  llmTimeoutMs?: number;
  fontFamily?: string;
}

const hashtagify = (s: string) => `#${s.replace(/[\s\u200c()/]+/g, "_").replace(/^_+|_+$/g, "")}`;

export class CampaignPlanner {
  private readonly llm: LlmFn | undefined;
  private readonly llmTimeoutMs: number;
  private readonly fontFamily: string;

  constructor(opts: CampaignPlannerOptions = {}) {
    this.llm = opts.llm;
    this.llmTimeoutMs = opts.llmTimeoutMs ?? 15_000;
    this.fontFamily = opts.fontFamily ?? "Vazirmatn, Vazir, Tahoma, 'DejaVu Sans', sans-serif";
  }

  /** Produce a campaign DRAFT. Never publishes or sends anything; status is always "pending_approval". */
  async plan(event: CalendarEvent, profile: BusinessProfile, opts: PlanOptions = {}): Promise<CampaignDraft> {
    validateProfile(profile);
    const now = opts.now ?? new Date();
    const warnings: string[] = [];
    const theme = themeFor(event);
    const relevance = scoreRelevance(event, profile, now);
    if (relevance.recommendation === "skip") warnings.push(`اجرای کمپین توصیه نمی‌شود (امتیاز ${relevance.score}).`);
    if (event.approximate) warnings.push("تاریخ مناسبت قمری و تقریبی است؛ با تقویم رسمی ایران تطبیق دهید.");
    const discount = suggestDiscount(event, profile, theme);
    const id = opts.campaignId ?? `cmp_${(fnv1a(`${event.instanceId}|${profile.id}`) >>> 0).toString(36)}_${event.date.replace(/-/g, "")}`;
    const tone = profile.tone ?? "formal";
    const vars = {
      brand: profile.name,
      event: event.titleFa,
      offer: offerPhrase(discount),
      code_line: "",
      city_line: profile.city ? ` در ${profile.city}` : "",
    };
    const variants = COPY_TEMPLATES[theme];
    const tpl = variants[fnv1a(`${event.id}|${profile.id}`) % variants.length]!;
    const templateIdea: CampaignIdea = { title: fill(tpl.ideaTitle, vars), summary: fill(tpl.ideaSummary, vars), angle: tpl.angle };
    const ctaKey = theme === "respectful" ? "respectful" : theme === "national" ? "national" : "default";
    const templateCopy: CampaignCopy = {
      headline: fill(tpl.headline, vars),
      body: fill(tpl.body, { ...vars, code_line: discount.code && discount.type === "percent" ? ` کد تخفیف: ${discount.code}.` : "" }),
      cta: CTA_BY_TONE[tone][ctaKey],
      sms: fill(tpl.sms, { ...vars, code_line: discount.code && discount.type === "percent" ? ` با کد ${discount.code}` : "" }),
      hashtags: [hashtagify(event.titleFa), hashtagify(profile.name), ...(discount.type === "percent" ? ["#تخفیف"] : [])],
    };

    let idea = templateIdea;
    let copy = templateCopy;
    let generator: CampaignDraft["generator"] = "template";
    const llm = opts.llm === null ? undefined : (opts.llm ?? this.llm);
    if (llm && theme !== "respectful") {
      try {
        const raw = await withTimeout(llm(buildLlmRequest(event, profile, discount, templateCopy, tone)), this.llmTimeoutMs);
        const parsed = parseLlmCopy(raw, discount.type === "percent" ? discount.value : null);
        if (parsed.ok) {
          const c = parsed.copy;
          idea = { title: c.idea_title, summary: c.idea_summary || templateIdea.summary, angle: c.angle || templateIdea.angle };
          copy = {
            headline: c.headline,
            body: discount.code && discount.type === "percent" && !c.body.includes(discount.code) ? `${c.body} کد تخفیف: ${discount.code}` : c.body,
            cta: c.cta,
            sms: c.sms,
            hashtags: c.hashtags.length ? c.hashtags : templateCopy.hashtags,
          };
          generator = "llm";
        } else warnings.push(`خروجی مدل زبانی رد شد (${parsed.reason})؛ از قالب پیش‌فرض استفاده شد.`);
      } catch (e) {
        warnings.push(`مدل زبانی در دسترس نبود (${e instanceof Error ? e.message : String(e)})؛ از قالب پیش‌فرض استفاده شد.`);
      }
    }
    if (copy.sms.length > 70) warnings.push(`متن پیامک ${toPersianDigits(copy.sms.length)} نویسه است و بیش از یک بخش (۷۰ نویسه) هزینه دارد.`);

    // Visuals
    const palette = THEME_PALETTES[theme];
    let accent = palette.accent;
    let bgFrom = palette.from;
    let bgTo = palette.to;
    if (theme === "generic" && profile.brandColors?.primary && isHexColor(profile.brandColors.primary)) {
      const p = normalizeHex(profile.brandColors.primary);
      bgFrom = mix(p, "#000000", 0.35);
      bgTo = p;
      accent = profile.brandColors.secondary && isHexColor(profile.brandColors.secondary) ? normalizeHex(profile.brandColors.secondary) : "#ffffff";
    }
    const textColor = bestTextColor(mix(bgFrom, bgTo, 0.5));
    const dateLabel = `${formatJalali(event.jalali, { persianDigits: true, monthName: true })}${event.approximate ? " (تقریبی)" : ""}`;
    const badge = discount.type === "percent" ? `${toPersianDigits(discount.value)}٪ تخفیف` : discount.type === "free_shipping" ? "ارسال رایگان" : discount.type === "gift" ? "هدیه ویژه" : null;
    const specFor = (format: BannerFormat): BannerSpec => ({
      format,
      ...BANNER_SIZES[format],
      lang: "fa",
      direction: "rtl",
      fontFamily: this.fontFamily,
      background: { from: bgFrom, to: bgTo },
      textColor,
      accentColor: accent,
      ctaTextColor: bestTextColor(accent),
      brand: profile.name,
      headline: copy.headline,
      subline: idea.title !== copy.headline ? idea.title : event.titleFa,
      cta: copy.cta,
      badge,
      code: discount.type === "percent" ? discount.code : null,
      motif: palette.motif,
      dateLabel,
    });
    const banner = specFor(opts.bannerFormats?.banner ?? "social_banner");
    const poster = specFor(opts.bannerFormats?.poster ?? "story_poster");
    const bannerSvg = renderBannerSvg(banner);
    const posterSvg = renderBannerSvg(poster);
    if (profile.websiteUrl && !safeHttpUrl(profile.websiteUrl)) warnings.push("آدرس وب‌سایت معتبر نیست (فقط http/https)؛ لینک دکمه خالی ماند.");
    const landingHtml = renderLandingHtml({
      campaignId: id,
      business: profile,
      eventTitleFa: event.titleFa,
      dateLabel: formatJalali(jalaliOf(discount.validTo), { persianDigits: true, monthName: true }),
      copy,
      discount,
      bannerSvg,
      colors: { primary: bgTo, background: "#fffdf8", text: "#1f1f1f" },
    });

    // Audience — consented contacts only
    const channel = opts.channel ?? profile.channels?.[0] ?? "sms";
    const audience = buildAudience(opts.contacts ?? [], { channel, consentRequired: true, ...opts.audience }, now);
    if (audience.size === 0) warnings.push("هیچ مخاطبِ دارای رضایت دریافت پیام تبلیغاتی در این مخاطبان نیست.");

    const today = toIsoDate(now);
    const maxDate = (a: string, b: string) => (a > b ? a : b);
    const startDate = maxDate(today, addDaysIso(event.date, -event.leadDays));
    const suggestedSendDate = maxDate(today, addDaysIso(event.date, -Math.min(3, event.leadDays)));

    return {
      id,
      version: 1,
      status: "pending_approval",
      businessId: profile.id,
      event: {
        id: event.id,
        instanceId: event.instanceId,
        titleFa: event.titleFa,
        date: event.date,
        jalaliDate: formatJalali(event.jalali),
        approximate: event.approximate,
      },
      createdAt: now.toISOString(),
      relevance,
      idea,
      copy,
      discount,
      audience,
      banner,
      poster,
      assets: { bannerSvg, posterSvg, landingHtml },
      schedule: { startDate, suggestedSendDate, suggestedSendLocalTime: "10:00 Asia/Tehran" },
      generator,
      warnings,
      tags: [...event.tags],
    };
  }
}

function jalaliOf(iso: string) {
  return jdnToJalali(isoToJdn(iso));
}

function validateProfile(p: BusinessProfile): void {
  if (!p.id?.trim()) throw new Error("BusinessProfile.id is required");
  if (!p.name?.trim()) throw new Error("BusinessProfile.name is required");
  if (!(p.industry in INDUSTRY_AFFINITY)) throw new Error(`Unknown industry "${p.industry}"`);
}

function buildLlmRequest(
  event: CalendarEvent,
  profile: BusinessProfile,
  discount: DiscountSuggestion,
  example: CampaignCopy,
  tone: "formal" | "friendly",
) {
  const offer =
    discount.type === "percent" ? `${discount.value}% discount with code ${discount.code}` : discount.type === "none" ? "no discount — do not mention any discount" : offerPhrase(discount);
  return {
    system:
      "You are a careful Persian (Farsi) marketing copywriter for Iranian small businesses. Write natural, culturally appropriate Persian. Never invent discounts, prices, URLs or claims. Output ONLY a JSON object.",
    prompt: [
      `Business: ${profile.name} (industry: ${profile.industry}${profile.city ? `, city: ${profile.city}` : ""}${profile.description ? `, about: ${profile.description}` : ""})`,
      `Occasion: ${event.titleFa} (${event.title}) on ${event.date}`,
      `Approved offer: ${offer}`,
      `Tone: ${tone === "formal" ? "polite/formal (شما)" : "friendly/warm"}`,
      `Return JSON with keys: idea_title, idea_summary, angle, headline (<= 60 chars), body (<= 350 chars), cta (<= 25 chars), sms (<= 70 chars), hashtags (array, <= 5).`,
      `Example of acceptable output style: ${JSON.stringify({ headline: example.headline, body: example.body, cta: example.cta, sms: example.sms })}`,
    ].join("\n"),
    temperature: 0.7,
    maxTokens: 700,
  };
}
