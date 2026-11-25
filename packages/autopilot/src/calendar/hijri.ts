/**
 * Hijri (lunar Islamic) calendar support.
 *
 * Iran's official lunar dates are set by moon sighting (Iranian Calendar Center) and are
 * published only shortly in advance, so ANY computed Hijri date here is approximate
 * (typically ±1–2 days). Strategy:
 *  1. Tabular "islamic-civil" arithmetic for an estimate (always available, pure math).
 *  2. When the runtime's Intl supports `islamic-umalqura` (Node/V8 with full ICU, Cloudflare
 *     Workers), refine the estimate to the Umm al-Qura date within ±3 days.
 *  3. An optional admin offset (days) lets operators align with the official Iranian date.
 */
import { gregorianToJdn, jdnToGregorian } from "./jalali.js";

export interface HijriDate {
  hy: number;
  hm: number; // 1..12
  hd: number; // 1..30
}

const CIVIL_EPOCH_JDN = 1948440; // 1 Muharram 1 AH (civil), Julian 16 July 622

export function hijriCivilToJdn(hy: number, hm: number, hd: number): number {
  return hd + Math.ceil(29.5 * (hm - 1)) + (hy - 1) * 354 + Math.floor((3 + 11 * hy) / 30) + CIVIL_EPOCH_JDN - 1;
}

export function jdnToHijriCivil(jdn: number): HijriDate {
  const hy = Math.floor((30 * (jdn - CIVIL_EPOCH_JDN) + 10646) / 10631);
  const hm = Math.min(12, Math.ceil((jdn - (29 + hijriCivilToJdn(hy, 1, 1))) / 29.5) + 1);
  const hd = jdn - hijriCivilToJdn(hy, hm, 1) + 1;
  return { hy, hm, hd };
}

let cachedFormatter: Intl.DateTimeFormat | null | undefined;

function umalquraFormatter(): Intl.DateTimeFormat | null {
  if (cachedFormatter !== undefined) return cachedFormatter;
  try {
    const f = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura-nu-latn", {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    const cal = f.resolvedOptions().calendar;
    cachedFormatter = cal === "islamic-umalqura" || cal === "islamic" ? f : null;
  } catch {
    cachedFormatter = null;
  }
  return cachedFormatter;
}

/** True when this runtime can compute Umm al-Qura dates through Intl. */
export function hasIntlHijri(): boolean {
  return umalquraFormatter() !== null;
}

/** Hijri date for a JDN using Intl Umm al-Qura when available, else tabular civil. */
export function jdnToHijri(jdn: number): HijriDate & { source: "intl-umalqura" | "tabular-civil" } {
  const f = umalquraFormatter();
  if (f) {
    const g = jdnToGregorian(jdn);
    const parts = f.formatToParts(new Date(Date.UTC(g.gy, g.gm - 1, g.gd, 12)));
    const num = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const hy = num("year") || num("relatedYear");
    const hm = num("month");
    const hd = num("day");
    if (Number.isFinite(hm) && Number.isFinite(hd) && hm > 0 && hd > 0) {
      return { hy: Number.isFinite(hy) && hy > 0 ? hy : jdnToHijriCivil(jdn).hy, hm, hd, source: "intl-umalqura" };
    }
  }
  return { ...jdnToHijriCivil(jdn), source: "tabular-civil" };
}

/**
 * All JDNs within Gregorian year `gy` on which Hijri month/day (hm, hd) falls.
 * A Hijri date occurs once or (rarely) twice per Gregorian year.
 */
export function hijriOccurrencesInGregorianYear(
  gy: number,
  hm: number,
  hd: number,
  offsetDays = 0,
): { jdn: number; source: "intl-umalqura" | "tabular-civil" }[] {
  const start = gregorianToJdn(gy, 1, 1);
  const end = gregorianToJdn(gy, 12, 31);
  const hyStart = jdnToHijriCivil(start).hy;
  const hyEnd = jdnToHijriCivil(end).hy;
  const out: { jdn: number; source: "intl-umalqura" | "tabular-civil" }[] = [];
  for (let hy = hyStart - 1; hy <= hyEnd + 1; hy += 1) {
    const est = hijriCivilToJdn(hy, hm, hd);
    let found: { jdn: number; source: "intl-umalqura" | "tabular-civil" } = { jdn: est, source: "tabular-civil" };
    if (hasIntlHijri()) {
      for (const delta of [0, -1, 1, -2, 2, -3, 3]) {
        const h = jdnToHijri(est + delta);
        if (h.hm === hm && h.hd === hd) {
          found = { jdn: est + delta, source: "intl-umalqura" };
          break;
        }
      }
    }
    const jdn = found.jdn + offsetDays;
    if (jdn >= start && jdn <= end && !out.some((o) => o.jdn === jdn)) out.push({ jdn, source: found.source });
  }
  return out.sort((a, b) => a.jdn - b.jdn);
}
