/** Color helpers (hex parsing, WCAG 2.x contrast). */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(v: string): boolean {
  return HEX_RE.test(v.trim());
}

export function normalizeHex(v: string): string {
  const m = HEX_RE.exec(v.trim());
  if (!m) throw new Error(`Invalid hex color "${v}"`);
  let h = m[1]!.toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return `#${h}`;
}

export function hexToRgb(v: string): [number, number, number] {
  const h = normalizeHex(v).slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Picks whichever of the candidates contrasts best with the background. */
export function bestTextColor(background: string, candidates: string[] = ["#ffffff", "#111111"]): string {
  return [...candidates].sort((x, y) => contrastRatio(y, background) - contrastRatio(x, background))[0]!;
}

/** Mix two hex colors; t=0 -> a, t=1 -> b. */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return `#${ca.map((c, i) => Math.round(c + (cb[i]! - c) * t).toString(16).padStart(2, "0")).join("")}`;
}
