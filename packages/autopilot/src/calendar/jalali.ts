/**
 * Jalali (Solar Hijri / Persian) <-> Gregorian conversion.
 *
 * Algorithm ported from jalaali-js (MIT License, Copyright (c) Behrang Noruzi Niya),
 * itself based on Kazimierz M. Borkowski's "The Persian calendar for 3000 years".
 * Valid for Jalali years -61 .. 3177. Pure integer arithmetic — no Intl dependency.
 *
 * All "days" in this module are Julian Day Numbers (JDN, integer, noon-based), which
 * makes date arithmetic timezone-free.
 */

export interface JalaliDate {
  jy: number;
  jm: number; // 1..12
  jd: number; // 1..31
}

export interface GregorianDate {
  gy: number;
  gm: number; // 1..12
  gd: number; // 1..31
}

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
  2456, 3178,
] as const;

const div = (a: number, b: number): number => ~~(a / b);
const mod = (a: number, b: number): number => a - ~~(a / b) * b;

export const JALALI_MONTHS_FA = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
] as const;

function assertJalaliYear(jy: number): void {
  if (!Number.isInteger(jy) || jy < BREAKS[0] || jy >= BREAKS[BREAKS.length - 1]!) {
    throw new RangeError(`Invalid Jalali year ${jy}`);
  }
}

interface JalCalResult {
  leap: number; // 0 => leap year
  gy: number;
  march: number; // day of March on which Farvardin 1 falls
}

function jalCal(jy: number): JalCalResult {
  assertJalaliYear(jy);
  const gy = jy + 621;
  let leapJ = -14;
  let jp: number = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i]!;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

/** Gregorian -> Julian Day Number. */
export function gregorianToJdn(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/** Julian Day Number -> Gregorian. */
export function jdnToGregorian(jdn: number): GregorianDate {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export function jalaliToJdn(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return gregorianToJdn(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

export function jdnToJalali(jdn: number): JalaliDate {
  const gy = jdnToGregorian(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = gregorianToJdn(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export function isLeapJalaliYear(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalaliYear(jy) ? 30 : 29;
}

export function isValidJalaliDate(jy: number, jm: number, jd: number): boolean {
  try {
    assertJalaliYear(jy);
  } catch {
    return false;
  }
  return jm >= 1 && jm <= 12 && jd >= 1 && jd <= jalaliMonthLength(jy, jm);
}

export function toJalali(gy: number, gm: number, gd: number): JalaliDate {
  return jdnToJalali(gregorianToJdn(gy, gm, gd));
}

export function toGregorian(jy: number, jm: number, jd: number): GregorianDate {
  if (!isValidJalaliDate(jy, jm, jd)) throw new RangeError(`Invalid Jalali date ${jy}/${jm}/${jd}`);
  return jdnToGregorian(jalaliToJdn(jy, jm, jd));
}

/** Format a Jalali date like "۱۴۰۵/۰۱/۰۱" (Persian digits) or "1405/01/01". */
export function formatJalali(d: JalaliDate, opts: { persianDigits?: boolean; monthName?: boolean } = {}): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = opts.monthName
    ? `${d.jd} ${JALALI_MONTHS_FA[d.jm - 1]} ${d.jy}`
    : `${d.jy}/${pad(d.jm)}/${pad(d.jd)}`;
  return opts.persianDigits ? toPersianDigits(s) : s;
}

export function toPersianDigits(input: string | number): string {
  return String(input).replace(/[0-9]/g, (c) => "۰۱۲۳۴۵۶۷۸۹"[Number(c)]!);
}

export function toLatinDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}
