import type { CalendarEvent } from "../calendar/events.js";
import type { BannerMotif } from "./types.js";

export type CampaignTheme =
  | "sale" | "new_year" | "romance" | "education" | "nature" | "gifting" | "family" | "national" | "respectful" | "generic";

/** Events whose mood is better served by a specific theme than by tag priority. */
export const EVENT_THEME_OVERRIDES: Record<string, CampaignTheme> = {
  yalda: "family",
  chaharshanbe_suri: "family",
  eid_al_fitr: "family",
};

export function themeFor(event: Pick<CalendarEvent, "tags" | "sensitivity" | "category"> & { id?: string }): CampaignTheme {
  const t = new Set(event.tags);
  if (event.sensitivity === "mourning" || t.has("mourning")) return "respectful";
  const override = event.id ? EVENT_THEME_OVERRIDES[event.id] : undefined;
  if (override) return override;
  if (t.has("sale")) return "sale";
  if (t.has("new_year")) return "new_year";
  if (t.has("romance")) return "romance";
  if (t.has("education")) return "education";
  if (t.has("nature")) return "nature";
  if (t.has("gifting")) return "gifting";
  if (t.has("family") || t.has("food")) return "family";
  if (t.has("national_pride")) return "national";
  return "generic";
}

export interface ThemePalette {
  from: string;
  to: string;
  accent: string;
  motif: BannerMotif;
}

export const THEME_PALETTES: Record<CampaignTheme, ThemePalette> = {
  family: { from: "#5c0b16", to: "#b3122e", accent: "#f4c542", motif: "pomegranate" },
  new_year: { from: "#0b5e45", to: "#2f9e57", accent: "#ffd166", motif: "sabzeh" },
  romance: { from: "#7d1840", to: "#d63a72", accent: "#ffe3ee", motif: "heart" },
  sale: { from: "#0b0b0b", to: "#2e2e2e", accent: "#f5c518", motif: "tag" },
  education: { from: "#15305a", to: "#2a62a8", accent: "#ffcc4d", motif: "book" },
  nature: { from: "#1f5a43", to: "#4fa77d", accent: "#ffe066", motif: "leaf" },
  gifting: { from: "#3f2466", to: "#7f4fb8", accent: "#ffd166", motif: "star" },
  national: { from: "#1d3557", to: "#36577f", accent: "#f1faee", motif: "none" },
  respectful: { from: "#262626", to: "#3d3d3d", accent: "#bdbdbd", motif: "none" },
  generic: { from: "#243b55", to: "#4b6584", accent: "#ffd166", motif: "star" },
};

export interface CopyTemplate {
  ideaTitle: string;
  ideaSummary: string;
  angle: string;
  headline: string;
  body: string;
  sms: string;
}

/**
 * Placeholders: {brand} {event} {offer} {code_line} {city_line}
 * {offer} is e.g. "۲۰٪ تخفیف" / "ارسال رایگان" / "هدیهٔ ویژه" / "پیشنهادهای ویژه".
 */
export const COPY_TEMPLATES: Record<CampaignTheme, CopyTemplate[]> = {
  sale: [
    {
      ideaTitle: "حراج محدود {event}",
      ideaSummary: "حراج زمان‌دار روی محصولات منتخب با شمارش معکوس و موجودی محدود.",
      angle: "فوریت و کمیابی",
      headline: "{event} در {brand} شروع شد!",
      body: "فقط برای مدت محدود، {offer} روی محصولات منتخب {brand}.{code_line} موجودی محدود است؛ زودتر انتخاب کنید.",
      sms: "{brand}: {event} با {offer}{code_line}",
    },
    {
      ideaTitle: "بزرگ‌ترین فروش سال {brand}",
      ideaSummary: "معرفی پرفروش‌ترین محصولات با بهترین قیمت سال برای {event}.",
      angle: "بهترین قیمت سال",
      headline: "بهترین قیمت‌های سال در {brand}",
      body: "{event} امسال را از دست ندهید: {offer} برای خریدهای آنلاین از {brand}.{code_line}",
      sms: "{brand}: بهترین قیمت سال، {offer}{code_line}",
    },
  ],
  new_year: [
    {
      ideaTitle: "سال نو، حال نو با {brand}",
      ideaSummary: "پیشنهاد ویژهٔ آغاز سال برای نو کردن خانه، استایل و هدیه‌های عید.",
      angle: "نوشدن و شروع تازه",
      headline: "{event} مبارک؛ سال نو، حال نو",
      body: "{brand} آغاز سال را به شما تبریک می‌گوید. به مناسبت {event}، {offer} برای خریدهای عید در نظر گرفته‌ایم.{code_line}",
      sms: "{brand}: {event} مبارک! {offer}{code_line}",
    },
    {
      ideaTitle: "سبد هدیهٔ {event}",
      ideaSummary: "بسته‌های هدیهٔ آماده برای عیدی دادن به خانواده و دوستان.",
      angle: "عیدی و هدیه",
      headline: "عیدی‌تان را از {brand} انتخاب کنید",
      body: "برای {event}، بسته‌های هدیهٔ {brand} آماده‌اند؛ همراه با {offer}.{code_line} سالی پر از شادی برایتان آرزو می‌کنیم.",
      sms: "{brand}: عیدی {event} با {offer}{code_line}",
    },
  ],
  romance: [
    {
      ideaTitle: "هدیهٔ عاشقانهٔ {event}",
      ideaSummary: "پیشنهاد هدیه‌های دونفره و بسته‌بندی ویژه برای {event}.",
      angle: "احساس و هدیه",
      headline: "برای کسی که دوستش دارید",
      body: "به مناسبت {event}، هدیه‌ای خاص از {brand} انتخاب کنید؛ با {offer} و بسته‌بندی ویژه.{code_line}",
      sms: "{brand}: هدیهٔ {event} با {offer}{code_line}",
    },
    {
      ideaTitle: "{event} به سبک {brand}",
      ideaSummary: "مجموعهٔ محدود محصولات دونفره با پیام شخصی روی بسته.",
      angle: "شخصی‌سازی",
      headline: "{event} را خاص‌تر کنید",
      body: "مجموعهٔ ویژهٔ {event} در {brand} آماده است؛ {offer} برای هدیه‌ای که فراموش نمی‌شود.{code_line}",
      sms: "{brand}: {event} با {offer}{code_line}",
    },
  ],
  education: [
    {
      ideaTitle: "همراه {event}",
      ideaSummary: "پیشنهاد ویژه برای دانش‌آموزان، دانشجویان و معلمان.",
      angle: "قدردانی و آمادگی",
      headline: "{event} با {brand}",
      body: "به مناسبت {event}، {brand} {offer} برای همهٔ اهالی آموزش در نظر گرفته است.{code_line}",
      sms: "{brand}: {event} با {offer}{code_line}",
    },
  ],
  nature: [
    {
      ideaTitle: "بستهٔ طبیعت‌گردی {event}",
      ideaSummary: "محصولات مناسب پیک‌نیک و گردش خانوادگی در طبیعت.",
      angle: "طبیعت و خانواده",
      headline: "{event}، یک روز در طبیعت",
      body: "برای {event} آماده‌اید؟ {brand} با {offer} همراه گردش خانوادگی شماست.{code_line}",
      sms: "{brand}: {event} با {offer}{code_line}",
    },
  ],
  gifting: [
    {
      ideaTitle: "هدیهٔ {event}",
      ideaSummary: "راهنمای انتخاب هدیه با پیشنهاد ویژه و کارت تبریک رایگان.",
      angle: "قدردانی",
      headline: "{event} مبارک",
      body: "به مناسبت {event}، هدیه‌ای ماندگار از {brand} انتخاب کنید؛ همراه با {offer}.{code_line}",
      sms: "{brand}: هدیهٔ {event} با {offer}{code_line}",
    },
    {
      ideaTitle: "قدردانی در {event}",
      ideaSummary: "مجموعهٔ هدیه در بازه‌های قیمتی مختلف با بسته‌بندی هدیه.",
      angle: "سپاس‌گزاری",
      headline: "با یک هدیه، سپاسگزاری کنید",
      body: "{event} فرصتی برای قدردانی است. {brand} {offer} روی مجموعهٔ هدیه‌ها در نظر گرفته است.{code_line}",
      sms: "{brand}: {event}، {offer}{code_line}",
    },
  ],
  family: [
    {
      ideaTitle: "بستهٔ ویژهٔ {event}",
      ideaSummary: "بستهٔ خانوادگی آماده برای دورهمی {event}.",
      angle: "دورهمی خانوادگی",
      headline: "{event} را کنار هم جشن بگیریم",
      body: "{brand} برای دورهمی {event} شما {offer} آماده کرده است.{code_line} شبی گرم و خاطره‌انگیز برایتان آرزو می‌کنیم.",
      sms: "{brand}: {event} با {offer}{code_line}",
    },
    {
      ideaTitle: "سفرهٔ {event}",
      ideaSummary: "پیشنهاد محصولات برای تکمیل سفره و هدیهٔ {event}.",
      angle: "سنت و گرما",
      headline: "گرم‌ترین دورهمی‌ها با {brand}",
      body: "به مناسبت {event}، {offer} برای خریدهای شما از {brand}.{code_line}",
      sms: "{brand}: {event}، {offer}{code_line}",
    },
  ],
  national: [
    {
      ideaTitle: "پیام مناسبتی {event}",
      ideaSummary: "پیام اطلاع‌رسانی/تبریک ساده بدون پیشنهاد فروش؛ مناسب شبکه‌های اجتماعی.",
      angle: "اطلاع‌رسانی",
      headline: "{event}",
      body: "{brand} فرارسیدن {event} را گرامی می‌دارد. ساعات کاری این روز در صفحهٔ ما اعلام می‌شود.",
      sms: "{brand}: ساعات کاری {event} را در سایت ببینید",
    },
  ],
  respectful: [
    {
      ideaTitle: "اطلاع‌رسانی ساعات کاری ({event})",
      ideaSummary: "در ایام سوگواری کمپین تبلیغاتی پیشنهاد نمی‌شود؛ فقط اطلاع‌رسانی ساعات کاری.",
      angle: "احترام",
      headline: "{event}",
      body: "{brand} در ایام {event} ساعات کاری خود را در صفحهٔ رسمی اعلام می‌کند.",
      sms: "{brand}: ساعات کاری ایام {event} در سایت",
    },
  ],
  generic: [
    {
      ideaTitle: "پیشنهاد ویژهٔ {event}",
      ideaSummary: "کمپین مناسبتی کوتاه با پیشنهاد ویژه برای مشتریان وفادار.",
      angle: "مناسبت و وفاداری",
      headline: "{event} با {brand}",
      body: "به مناسبت {event}، {offer} برای مشتریان {brand}.{code_line}",
      sms: "{brand}: {event} با {offer}{code_line}",
    },
  ],
};

export const CTA_BY_TONE: Record<"formal" | "friendly", Record<"default" | "respectful" | "national", string>> = {
  formal: { default: "مشاهده و خرید", respectful: "مشاهدهٔ ساعات کاری", national: "اطلاعات بیشتر" },
  friendly: { default: "همین حالا ببین!", respectful: "ساعات کاری", national: "بیشتر بدانید" },
};

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "").replace(/\s{2,}/g, " ").replace(/\s+([.،؛!؟])/g, "$1").trim();
}
