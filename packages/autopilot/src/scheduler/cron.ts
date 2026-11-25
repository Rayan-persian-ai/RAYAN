/**
 * 5-field cron parser (minute hour day-of-month month day-of-week) + next-run computation.
 *
 * Supports: `*`, lists `1,2,5`, ranges `1-5`, steps `*\/15` and `10-40/5`, month names
 * (jan..dec), weekday names (sun..sat, 7 = Sunday), and macros @yearly @annually @monthly
 * @weekly @daily @midnight @hourly.
 * Vixie semantics: when BOTH day-of-month and day-of-week are restricted, a day matches if
 * EITHER matches.
 *
 * Times are evaluated in UTC shifted by a fixed `utcOffsetMinutes` (Iran has had no DST since
 * 2022, so Asia/Tehran = +210). Cloudflare Cron Triggers themselves always fire in UTC.
 */

export interface CronSchedule {
  source: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>; // 1..12
  daysOfWeek: ReadonlySet<number>; // 0..6, Sunday = 0
  domRestricted: boolean;
  dowRestricted: boolean;
}

export class CronParseError extends Error {
  override name = "CronParseError";
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseValue(token: string, names: string[] | undefined, nameBase: number, field: string): number {
  const lower = token.toLowerCase();
  if (names) {
    const idx = names.indexOf(lower);
    if (idx >= 0) return idx + nameBase;
  }
  if (!/^\d+$/.test(token)) throw new CronParseError(`Invalid value "${token}" in ${field} field`);
  return Number(token);
}

function parseField(expr: string, min: number, max: number, field: string, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    if (part === "") throw new CronParseError(`Empty list item in ${field} field`);
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length > 0 || rangePart === undefined) throw new CronParseError(`Invalid step in ${field}: "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw new CronParseError(`Invalid step "${stepPart}" in ${field}`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b, ...more] = rangePart.split("-");
      if (more.length || a === undefined || b === undefined) throw new CronParseError(`Invalid range "${rangePart}" in ${field}`);
      lo = parseValue(a, names, nameBase, field);
      hi = parseValue(b, names, nameBase, field);
    } else {
      lo = parseValue(rangePart, names, nameBase, field);
      hi = stepPart !== undefined ? max : lo;
    }
    if (field === "day-of-week") {
      // allow 7 as Sunday
      if (lo === 7 && hi === 7) {
        lo = 0;
        hi = 0;
      }
      if (lo < 0 || hi > 7 || lo > hi) throw new CronParseError(`Out of range ${lo}-${hi} in ${field}`);
      for (let v = lo; v <= hi; v += step) out.add(v % 7);
      continue;
    }
    if (lo < min || hi > max || lo > hi) throw new CronParseError(`Out of range ${lo}-${hi} in ${field} (allowed ${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expression: string): CronSchedule {
  const src = expression.trim().replace(/\s+/g, " ");
  const expanded = MACROS[src.toLowerCase()] ?? src;
  if (expanded.startsWith("@")) throw new CronParseError(`Unknown macro "${src}"`);
  const fields = expanded.split(" ");
  if (fields.length !== 5) throw new CronParseError(`Expected 5 fields, got ${fields.length}: "${expression}"`);
  const [mi, ho, dom, mo, dow] = fields as [string, string, string, string, string];
  return {
    source: src,
    minutes: parseField(mi, 0, 59, "minute"),
    hours: parseField(ho, 0, 23, "hour"),
    daysOfMonth: parseField(dom, 1, 31, "day-of-month"),
    months: parseField(mo, 1, 12, "month", MONTH_NAMES, 1),
    daysOfWeek: parseField(dow, 0, 7, "day-of-week", DOW_NAMES, 0),
    domRestricted: dom !== "*" && !dom.startsWith("*/"),
    dowRestricted: dow !== "*" && !dow.startsWith("*/"),
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(s: CronSchedule, d: Date): boolean {
  const domOk = s.daysOfMonth.has(d.getUTCDate());
  const dowOk = s.daysOfWeek.has(d.getUTCDay());
  if (s.domRestricted && s.dowRestricted) return domOk || dowOk;
  if (s.domRestricted) return domOk;
  if (s.dowRestricted) return dowOk;
  return domOk && dowOk;
}

/**
 * Next fire time strictly after `after`.
 * @returns a UTC Date, or null if nothing matches within ~5 years (e.g. "0 0 31 2 *").
 */
export function nextRun(cron: string | CronSchedule, after: Date, utcOffsetMinutes = 0): Date | null {
  const s = typeof cron === "string" ? parseCron(cron) : cron;
  const offsetMs = utcOffsetMinutes * 60_000;
  // Work in "wall clock as UTC" space.
  const t = new Date(after.getTime() + offsetMs);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = t.getTime() + 5 * 366 * 24 * 3600_000;
  while (t.getTime() <= limit) {
    if (!s.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(t.getTime() - offsetMs);
  }
  return null;
}

/** The next `count` fire times after `after`. */
export function nextRuns(cron: string, after: Date, count: number, utcOffsetMinutes = 0): Date[] {
  const s = parseCron(cron);
  const out: Date[] = [];
  let cur = after;
  for (let i = 0; i < count; i += 1) {
    const n = nextRun(s, cur, utcOffsetMinutes);
    if (!n) break;
    out.push(n);
    cur = n;
  }
  return out;
}
