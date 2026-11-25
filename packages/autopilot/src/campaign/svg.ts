import type { BannerFormat, BannerMotif, BannerSpec } from "./types.js";

export const BANNER_SIZES: Record<BannerFormat, { width: number; height: number }> = {
  social_banner: { width: 1200, height: 628 },
  story_poster: { width: 1080, height: 1920 },
  square_post: { width: 1080, height: 1080 },
};

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // strip XML-invalid control characters
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** Approximate average advance width of Persian glyphs, in em. */
const AVG_CHAR_EM = 0.5;

/** Word-wrap text to fit maxWidth px at fontSize; returns lines (RTL logical order). */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * AVG_CHAR_EM)));
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitText(text: string, fontSize: number, maxWidth: number, maxLines: number): { lines: string[]; fontSize: number } {
  let size = fontSize;
  for (let i = 0; i < 4; i += 1) {
    const lines = wrapText(text, size, maxWidth);
    if (lines.length <= maxLines) return { lines, fontSize: size };
    size = Math.round(size * 0.88);
  }
  const lines = wrapText(text, size, maxWidth).slice(0, maxLines);
  lines[maxLines - 1] = `${lines[maxLines - 1]}…`;
  return { lines, fontSize: size };
}

function motifShape(motif: BannerMotif, x: number, y: number, r: number, color: string): string {
  const f = `fill="${color}"`;
  switch (motif) {
    case "pomegranate":
      return `<g ${f}><circle cx="${x}" cy="${y}" r="${r}"/><path d="M${x - r * 0.3} ${y - r * 0.85} L${x - r * 0.15} ${y - r * 1.25} L${x} ${y - r * 0.95} L${x + r * 0.15} ${y - r * 1.25} L${x + r * 0.3} ${y - r * 0.85} Z"/></g>`;
    case "heart":
      return `<path ${f} d="M${x} ${y + r * 0.9} C ${x - r * 1.6} ${y - r * 0.2}, ${x - r * 0.6} ${y - r * 1.4}, ${x} ${y - r * 0.45} C ${x + r * 0.6} ${y - r * 1.4}, ${x + r * 1.6} ${y - r * 0.2}, ${x} ${y + r * 0.9} Z"/>`;
    case "sabzeh": {
      const blades = [-0.6, -0.3, 0, 0.3, 0.6]
        .map((dx) => `<path d="M${x + dx * r} ${y + r * 0.5} Q ${x + dx * r * 1.6} ${y - r * 0.4} ${x + dx * r * 2} ${y - r * 1.2}" stroke="${color}" stroke-width="${r * 0.12}" fill="none" stroke-linecap="round"/>`)
        .join("");
      return `<g>${blades}<ellipse cx="${x}" cy="${y + r * 0.6}" rx="${r * 0.9}" ry="${r * 0.3}" ${f}/></g>`;
    }
    case "tag":
      return `<g ${f}><path d="M${x - r} ${y - r * 0.6} H${x + r * 0.4} L${x + r} ${y} L${x + r * 0.4} ${y + r * 0.6} H${x - r} Z"/></g>`;
    case "book":
      return `<g ${f}><rect x="${x - r}" y="${y - r * 0.7}" width="${r * 0.95}" height="${r * 1.4}" rx="${r * 0.08}"/><rect x="${x + r * 0.05}" y="${y - r * 0.7}" width="${r * 0.95}" height="${r * 1.4}" rx="${r * 0.08}"/></g>`;
    case "star": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const rad = i % 2 === 0 ? r : r * 0.45;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        pts.push(`${(x + rad * Math.cos(a)).toFixed(1)},${(y + rad * Math.sin(a)).toFixed(1)}`);
      }
      return `<polygon ${f} points="${pts.join(" ")}"/>`;
    }
    case "leaf":
      return `<ellipse ${f} cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.45}" transform="rotate(-35 ${x} ${y})"/>`;
    case "none":
      return "";
  }
}

const n = (v: number) => Math.round(v * 10) / 10;

/**
 * Wrap a line in RLE…PDF (U+202B / U+202C) so mixed Persian/Latin/digit lines keep RTL
 * order even in renderers that ignore the SVG `direction` attribute (e.g. resvg).
 */
export const rtlEmbed = (s: string): string => `\u202B${s}\u202C`;

/**
 * Renders a real RTL SVG (xml:lang="fa", direction="rtl").
 * Text is center-anchored so layout is identical in renderers with partial bidi/`direction`
 * support (browsers, librsvg, ImageMagick); bidi order within each line is still resolved
 * as RTL thanks to `direction="rtl"`.
 */
export function renderBannerSvg(spec: BannerSpec): string {
  const { width: w, height: h } = spec;
  const portrait = h > w * 1.2;
  const cx = w / 2;
  const maxTextW = w * (portrait ? 0.84 : 0.6);
  const base = Math.min(w, h * 1.9);
  const headlineFit = fitText(spec.headline, base * (portrait ? 0.085 : 0.052), maxTextW, portrait ? 3 : 2);
  const sublineFit = fitText(spec.subline, base * (portrait ? 0.042 : 0.026), maxTextW, portrait ? 3 : 1);
  const font = escapeXml(spec.fontFamily);
  const t = escapeXml(spec.textColor);
  const parts: string[] = [];

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xml:lang="fa" direction="rtl" font-family="${font}" role="img" aria-label="${escapeXml(spec.headline)}">`,
  );
  parts.push(`<title>${escapeXml(`${spec.brand} — ${spec.headline}`)}</title>`);
  parts.push(
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${escapeXml(spec.background.from)}"/><stop offset="1" stop-color="${escapeXml(spec.background.to)}"/></linearGradient></defs>`,
  );
  parts.push(`<rect width="${w}" height="${h}" fill="url(#bg)"/>`);

  // Decorative motifs (low opacity, corners away from text)
  const mr = Math.min(w, h) * 0.09;
  parts.push(
    `<g opacity="0.22">${motifShape(spec.motif, w - mr * 1.6, h - mr * 1.5, mr, spec.accentColor)}${motifShape(spec.motif, mr * 1.4, h - mr * 1.2, mr * 0.7, spec.accentColor)}${motifShape(spec.motif, w - mr * 1.2, mr * 1.6, mr * 0.6, spec.accentColor)}</g>`,
  );

  const text = (x: number, y: number, size: number, content: string, extra = "") =>
    `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" fill="${t}" text-anchor="middle" direction="rtl" unicode-bidi="embed" ${extra}>${escapeXml(rtlEmbed(content))}</text>`;

  // Brand
  let y = h * (portrait ? 0.1 : 0.13);
  parts.push(text(cx, y, base * (portrait ? 0.045 : 0.03), spec.brand, `font-weight="700" opacity="0.92"`));

  // Headline
  y = h * (portrait ? 0.34 : 0.33);
  const hl = headlineFit.fontSize * 1.3;
  for (const line of headlineFit.lines) {
    parts.push(text(cx, y, headlineFit.fontSize, line, `font-weight="800"`));
    y += hl;
  }
  // Subline
  y += sublineFit.fontSize * 0.3;
  for (const line of sublineFit.lines) {
    parts.push(text(cx, y, sublineFit.fontSize, line, `opacity="0.95"`));
    y += sublineFit.fontSize * 1.45;
  }

  // Footer stack: CTA button, discount code, date.
  const ctaSize = base * (portrait ? 0.045 : 0.028);
  const ctaW = Math.min(maxTextW, Math.max(ctaSize * 6, spec.cta.length * ctaSize * AVG_CHAR_EM + ctaSize * 2.4));
  const ctaH = ctaSize * 2.2;
  const lineGap = ctaSize * 1.35;
  let ctaY: number;
  if (portrait) {
    // flow under the text block, but keep the block in the upper ~2/3
    ctaY = Math.max(y + ctaSize * 1.2, h * 0.56);
  } else {
    // bottom-anchored so code/date never collide
    const dateY = h - ctaSize * 0.9;
    const codeY = spec.code ? dateY - lineGap : dateY;
    ctaY = codeY - ctaSize * 1.25 - ctaH;
  }
  parts.push(`<rect x="${n(cx - ctaW / 2)}" y="${n(ctaY)}" width="${n(ctaW)}" height="${n(ctaH)}" rx="${n(ctaH / 2)}" fill="${escapeXml(spec.accentColor)}"/>`);
  parts.push(
    `<text x="${n(cx)}" y="${n(ctaY + ctaH / 2 + ctaSize * 0.35)}" font-size="${n(ctaSize)}" font-weight="700" fill="${escapeXml(spec.ctaTextColor)}" text-anchor="middle" direction="rtl" unicode-bidi="embed">${escapeXml(rtlEmbed(spec.cta))}</text>`,
  );
  let footY = ctaY + ctaH + ctaSize * 1.25;
  if (spec.code) {
    parts.push(text(cx, footY, ctaSize * 0.85, `کد تخفیف: ${spec.code}`, `font-weight="600"`));
    footY += lineGap;
  }
  parts.push(text(cx, footY, ctaSize * 0.7, spec.dateLabel, `opacity="0.85"`));

  // Badge (top-left; for RTL readers the start of the eye path is top-right with the brand)
  if (spec.badge) {
    const br = Math.min(w, h) * (portrait ? 0.12 : 0.15);
    const bx = br * 1.25;
    const by = portrait ? h * 0.17 : br * 1.3;
    const [first, ...rest] = spec.badge.split(" ");
    parts.push(`<circle cx="${n(bx)}" cy="${n(by)}" r="${n(br)}" fill="${escapeXml(spec.accentColor)}"/>`);
    parts.push(
      `<text x="${n(bx)}" y="${n(by + (rest.length ? -br * 0.05 : br * 0.15))}" font-size="${n(br * 0.5)}" font-weight="800" fill="${escapeXml(spec.ctaTextColor)}" text-anchor="middle" direction="rtl" unicode-bidi="embed">${escapeXml(rtlEmbed(first ?? ""))}</text>`,
    );
    if (rest.length)
      parts.push(
        `<text x="${n(bx)}" y="${n(by + br * 0.45)}" font-size="${n(br * 0.28)}" font-weight="700" fill="${escapeXml(spec.ctaTextColor)}" text-anchor="middle" direction="rtl" unicode-bidi="embed">${escapeXml(rtlEmbed(rest.join(" ")))}</text>`,
      );
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}
