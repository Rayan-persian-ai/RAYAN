import { gregorianToJdn, jdnToGregorian } from "./jalali.js";

/** A calendar date with no time/zone, as ISO "YYYY-MM-DD". */
export type IsoDate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(iso: IsoDate): { gy: number; gm: number; gd: number } {
  const m = ISO_RE.exec(iso);
  if (!m) throw new RangeError(`Invalid ISO date "${iso}" (expected YYYY-MM-DD)`);
  const gy = Number(m[1]);
  const gm = Number(m[2]);
  const gd = Number(m[3]);
  const back = jdnToGregorian(gregorianToJdn(gy, gm, gd));
  if (back.gy !== gy || back.gm !== gm || back.gd !== gd) throw new RangeError(`Invalid calendar date "${iso}"`);
  return { gy, gm, gd };
}

export function isoToJdn(iso: IsoDate): number {
  const { gy, gm, gd } = parseIsoDate(iso);
  return gregorianToJdn(gy, gm, gd);
}

export function jdnToIso(jdn: number): IsoDate {
  const { gy, gm, gd } = jdnToGregorian(jdn);
  return `${String(gy).padStart(4, "0")}-${String(gm).padStart(2, "0")}-${String(gd).padStart(2, "0")}`;
}

export function ymdToIso(gy: number, gm: number, gd: number): IsoDate {
  return jdnToIso(gregorianToJdn(gy, gm, gd));
}

/** 0 = Sunday ... 6 = Saturday (JS convention). */
export function weekdayOfJdn(jdn: number): number {
  return (((jdn + 1) % 7) + 7) % 7;
}

export function addDaysIso(iso: IsoDate, days: number): IsoDate {
  return jdnToIso(isoToJdn(iso) + days);
}

export function diffDaysIso(from: IsoDate, to: IsoDate): number {
  return isoToJdn(to) - isoToJdn(from);
}

/**
 * Converts an instant to the calendar date in a given IANA zone (default Asia/Tehran).
 * Accepts an ISO date string as-is.
 */
export function toIsoDate(input: Date | IsoDate, timeZone = "Asia/Tehran"): IsoDate {
  if (typeof input === "string") {
    parseIsoDate(input);
    return input;
  }
  if (Number.isNaN(input.getTime())) throw new RangeError("Invalid Date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(input);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** n-th (1-based) given weekday of a Gregorian month; n = -1 for the last one. */
export function nthWeekdayOfMonth(gy: number, gm: number, weekday: number, n: number): IsoDate {
  if (n > 0) {
    const first = gregorianToJdn(gy, gm, 1);
    const offset = (weekday - weekdayOfJdn(first) + 7) % 7;
    return jdnToIso(first + offset + (n - 1) * 7);
  }
  const nextMonth = gm === 12 ? gregorianToJdn(gy + 1, 1, 1) : gregorianToJdn(gy, gm + 1, 1);
  const last = nextMonth - 1;
  const back = (weekdayOfJdn(last) - weekday + 7) % 7;
  return jdnToIso(last - back);
}
