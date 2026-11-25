import { escapeXml } from "./svg.js";
import type { BusinessProfile, CampaignCopy, DiscountSuggestion } from "./types.js";
import { bestTextColor } from "../util/color.js";

const esc = escapeXml;

/** Only http(s) URLs are allowed in generated pages. Returns null for anything else. */
export function safeHttpUrl(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

export function withUtm(url: URL, campaignId: string, medium: string): string {
  const u = new URL(url.toString());
  u.searchParams.set("utm_source", "rayan_autopilot");
  u.searchParams.set("utm_medium", medium);
  u.searchParams.set("utm_campaign", campaignId);
  return u.toString();
}

export interface LandingInput {
  campaignId: string;
  business: BusinessProfile;
  eventTitleFa: string;
  dateLabel: string;
  copy: CampaignCopy;
  discount: DiscountSuggestion;
  bannerSvg?: string;
  colors: { primary: string; background: string; text: string };
}

/**
 * Self-contained RTL landing page DRAFT (no external assets/scripts, noindex until published).
 */
export function renderLandingHtml(input: LandingInput): string {
  const { business, copy, discount, colors } = input;
  const target = safeHttpUrl(business.websiteUrl);
  const href = target ? withUtm(target, input.campaignId, "landing") : "#";
  const ctaText = bestTextColor(colors.primary);
  const banner = input.bannerSvg ? input.bannerSvg.replace(/^<\?xml[^>]*>\s*/, "") : "";
  const discountBlock =
    discount.type === "percent" && discount.code
      ? `<section class="offer" aria-label="پیشنهاد ویژه"><p class="pct">${esc(toFa(discount.value))}٪ تخفیف</p><p>با کد <code dir="ltr">${esc(discount.code)}</code></p><p class="valid">اعتبار تا ${esc(input.dateLabel)}</p></section>`
      : discount.type === "gift"
        ? `<section class="offer"><p class="pct">هدیهٔ ویژه</p><p>${esc(discount.rationale)}</p></section>`
        : discount.type === "free_shipping"
          ? `<section class="offer"><p class="pct">ارسال رایگان</p></section>`
          : "";
  const tags = copy.hashtags.map((h) => `<span>${esc(h)}</span>`).join(" ");
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="rayan:status" content="draft-pending-approval">
<title>${esc(copy.headline)} | ${esc(business.name)}</title>
<meta name="description" content="${esc(copy.body.slice(0, 155))}">
<style>
:root{--primary:${esc(colors.primary)};--bg:${esc(colors.background)};--text:${esc(colors.text)};--cta-text:${esc(ctaText)}}
*{box-sizing:border-box}
body{margin:0;font-family:Vazirmatn,Tahoma,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);line-height:1.9}
main{max-width:760px;margin:0 auto;padding:24px 20px 48px}
.draft{background:#fff4ce;color:#5c4400;border-radius:8px;padding:8px 12px;font-size:14px;margin-bottom:16px}
.hero svg{width:100%;height:auto;border-radius:16px;display:block}
h1{font-size:clamp(26px,5vw,40px);margin:24px 0 8px}
.brand{opacity:.8;font-weight:700}
.offer{border:2px dashed var(--primary);border-radius:16px;padding:16px;text-align:center;margin:24px 0}
.offer .pct{font-size:32px;font-weight:800;margin:0;color:var(--primary)}
code{font-size:20px;letter-spacing:2px}
.cta{display:inline-block;background:var(--primary);color:var(--cta-text);padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:18px}
.tags span{display:inline-block;margin-inline-end:8px;opacity:.7}
footer{margin-top:40px;font-size:13px;opacity:.7}
</style>
</head>
<body>
<main>
<p class="draft" role="note">پیش‌نویس — در انتظار تأیید. این صفحه هنوز منتشر نشده است.</p>
<p class="brand">${esc(business.name)} · ${esc(input.eventTitleFa)}</p>
${banner ? `<div class="hero">${banner}</div>` : ""}
<h1>${esc(copy.headline)}</h1>
<p>${esc(copy.body)}</p>
${discountBlock}
<p><a class="cta" href="${esc(href)}" rel="noopener">${esc(copy.cta)}</a></p>
<p class="tags">${tags}</p>
<footer>${esc(business.name)}${business.city ? ` · ${esc(business.city)}` : ""} — برای لغو دریافت پیام‌های تبلیغاتی، از لینک انصراف در پیام استفاده کنید.</footer>
</main>
</body>
</html>
`;
}

function toFa(v: number | string): string {
  return String(v).replace(/[0-9]/g, (c) => "۰۱۲۳۴۵۶۷۸۹"[Number(c)]!);
}
