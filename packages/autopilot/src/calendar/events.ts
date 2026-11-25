import { isoToJdn, jdnToIso, nthWeekdayOfMonth, toIsoDate, weekdayOfJdn, type IsoDate } from "./civil.js";
import { gregorianToJdn, jalaliToJdn, jdnToJalali, jalaliMonthLength, type JalaliDate } from "./jalali.js";
import { hijriOccurrencesInGregorianYear } from "./hijri.js";

export type EventCategory = "cultural" | "national" | "religious" | "commercial" | "occasion" | "custom";
export type EventSensitivity = "celebration" | "neutral" | "mourning";

/** Marketing-relevant topic tags used by the campaign planner's relevance scoring. */
export type EventTag =
  | "gifting" | "family" | "food" | "shopping" | "romance" | "travel" | "nature" | "education"
  | "tech" | "fashion" | "beauty" | "home" | "health" | "kids" | "new_year" | "sale" | "national_pride"
  | "religious" | "mourning" | "women" | "men" | "career";

export type EventRule =
  | { type: "jalali"; month: number; day: number }
  | { type: "gregorian"; month: number; day: number }
  | { type: "nth_weekday"; month: number; weekday: number; n: number; offsetDays?: number }
  | { type: "hijri"; month: number; day: number }
  | { type: "chaharshanbe_suri" }
  | { type: "once"; date: IsoDate };

export interface EventDefinition {
  id: string;
  title: string;
  titleFa: string;
  category: EventCategory;
  rule: EventRule;
  tags: EventTag[];
  sensitivity?: EventSensitivity;
  holiday?: boolean;
  durationDays?: number;
  /** Ideal campaign lead time in days (planner uses it). */
  leadDays?: number;
  notes?: string;
  /** Added by an admin (custom events). */
  custom?: boolean;
}

export interface CalendarEvent {
  id: string;
  instanceId: string;
  title: string;
  titleFa: string;
  date: IsoDate;
  jalali: JalaliDate;
  category: EventCategory;
  tags: EventTag[];
  sensitivity: EventSensitivity;
  holiday: boolean;
  durationDays: number;
  leadDays: number;
  approximate: boolean;
  source: "jalali" | "gregorian" | "computed" | "hijri-intl" | "hijri-tabular" | "custom";
  notes?: string;
}

const j = (month: number, day: number): EventRule => ({ type: "jalali", month, day });
const g = (month: number, day: number): EventRule => ({ type: "gregorian", month, day });
const h = (month: number, day: number): EventRule => ({ type: "hijri", month, day });

/** Built-in events. Admins extend this with custom definitions. */
export const BUILTIN_EVENTS: readonly EventDefinition[] = [
  // ---- Persian cultural ----
  { id: "nowruz", title: "Nowruz", titleFa: "نوروز", category: "cultural", rule: j(1, 1), tags: ["new_year", "family", "gifting", "fashion", "travel", "shopping", "home", "food"], holiday: true, durationDays: 4, leadDays: 30 },
  { id: "sizdah_bedar", title: "Sizdah Bedar (Nature Day)", titleFa: "سیزده‌بدر (روز طبیعت)", category: "cultural", rule: j(1, 13), tags: ["nature", "family", "food", "travel"], holiday: true, leadDays: 7 },
  { id: "chaharshanbe_suri", title: "Chaharshanbe Suri", titleFa: "چهارشنبه‌سوری", category: "cultural", rule: { type: "chaharshanbe_suri" }, tags: ["family", "food"], leadDays: 7, notes: "Celebrated on the evening of the last Tuesday before Nowruz; date is that Tuesday." },
  { id: "yalda", title: "Yalda Night", titleFa: "شب یلدا", category: "cultural", rule: j(9, 30), tags: ["family", "food", "gifting", "home"], leadDays: 14, notes: "Night between 30 Azar and 1 Dey." },
  { id: "tirgan", title: "Tirgan", titleFa: "جشن تیرگان", category: "cultural", rule: j(4, 13), tags: ["family", "nature"], leadDays: 5 },
  { id: "mehregan", title: "Mehregan", titleFa: "جشن مهرگان", category: "cultural", rule: j(7, 16), tags: ["family", "gifting"], leadDays: 5 },
  { id: "sepandarmazgan", title: "Sepandarmazgan (Persian Day of Love)", titleFa: "سپندارمذگان (روز عشق ایرانی)", category: "cultural", rule: j(11, 29), tags: ["romance", "gifting", "women", "beauty"], leadDays: 10 },
  // ---- Iranian national days ----
  { id: "islamic_republic_day", title: "Islamic Republic Day", titleFa: "روز جمهوری اسلامی", category: "national", rule: j(1, 12), tags: ["national_pride"], holiday: true, sensitivity: "neutral", leadDays: 3 },
  { id: "teachers_day", title: "Teachers' Day", titleFa: "روز معلم", category: "occasion", rule: j(2, 12), tags: ["education", "gifting", "career"], leadDays: 7 },
  { id: "ferdowsi_day", title: "Ferdowsi Day / Persian Language Day", titleFa: "روز بزرگداشت فردوسی و پاسداشت زبان فارسی", category: "national", rule: j(2, 25), tags: ["education", "national_pride"], leadDays: 5 },
  { id: "khomeini_passing", title: "Death anniversary of Imam Khomeini", titleFa: "رحلت امام خمینی", category: "national", rule: j(3, 14), tags: ["mourning"], holiday: true, sensitivity: "mourning", leadDays: 0 },
  { id: "khordad_15", title: "15 Khordad Uprising", titleFa: "قیام ۱۵ خرداد", category: "national", rule: j(3, 15), tags: ["national_pride"], holiday: true, sensitivity: "neutral", leadDays: 0 },
  { id: "physicians_day", title: "Physicians' Day (Avicenna)", titleFa: "روز پزشک (بزرگداشت ابن‌سینا)", category: "occasion", rule: j(6, 1), tags: ["health", "career", "gifting"], leadDays: 5 },
  { id: "school_opening", title: "Back to School (1 Mehr)", titleFa: "بازگشایی مدارس (اول مهر)", category: "commercial", rule: j(7, 1), tags: ["education", "kids", "shopping", "fashion", "tech"], leadDays: 21 },
  { id: "students_day", title: "Students' Day", titleFa: "روز دانشجو", category: "occasion", rule: j(9, 16), tags: ["education", "tech"], leadDays: 5 },
  { id: "revolution_day", title: "Islamic Revolution Victory Day", titleFa: "پیروزی انقلاب اسلامی (۲۲ بهمن)", category: "national", rule: j(11, 22), tags: ["national_pride"], holiday: true, sensitivity: "neutral", leadDays: 0 },
  { id: "engineers_day", title: "Engineers' Day", titleFa: "روز مهندس", category: "occasion", rule: j(12, 5), tags: ["career", "tech", "gifting"], leadDays: 5 },
  { id: "oil_nationalization_day", title: "Oil Nationalization Day", titleFa: "روز ملی شدن صنعت نفت", category: "national", rule: j(12, 29), tags: ["national_pride"], holiday: true, sensitivity: "neutral", leadDays: 0 },
  // ---- Religious (lunar Hijri — approximate) ----
  { id: "mothers_day_ir", title: "Mother's Day / Women's Day (Iran)", titleFa: "روز مادر و روز زن", category: "occasion", rule: h(6, 20), tags: ["gifting", "women", "family", "beauty", "fashion"], leadDays: 14, notes: "Birth anniversary of Fatimah (20 Jumada al-Thani). Lunar: approximate." },
  { id: "fathers_day_ir", title: "Father's Day / Men's Day (Iran)", titleFa: "روز پدر و روز مرد", category: "occasion", rule: h(7, 13), tags: ["gifting", "men", "family", "fashion", "tech"], leadDays: 14, notes: "Birth anniversary of Imam Ali (13 Rajab). Lunar: approximate." },
  { id: "eid_al_fitr", title: "Eid al-Fitr", titleFa: "عید سعید فطر", category: "religious", rule: h(10, 1), tags: ["religious", "family", "food", "gifting"], holiday: true, durationDays: 2, leadDays: 10 },
  { id: "eid_al_ghadir", title: "Eid al-Ghadir", titleFa: "عید غدیر خم", category: "religious", rule: h(12, 18), tags: ["religious", "family", "gifting"], holiday: true, leadDays: 5 },
  { id: "tasua", title: "Tasua", titleFa: "تاسوعای حسینی", category: "religious", rule: h(1, 9), tags: ["mourning", "religious"], holiday: true, sensitivity: "mourning", leadDays: 0 },
  { id: "ashura", title: "Ashura", titleFa: "عاشورای حسینی", category: "religious", rule: h(1, 10), tags: ["mourning", "religious"], holiday: true, sensitivity: "mourning", leadDays: 0 },
  // ---- International / commercial (Gregorian) ----
  { id: "new_year_gregorian", title: "New Year's Day", titleFa: "آغاز سال نو میلادی", category: "commercial", rule: g(1, 1), tags: ["new_year", "gifting", "shopping"], leadDays: 10 },
  { id: "valentines_day", title: "Valentine's Day", titleFa: "روز ولنتاین", category: "commercial", rule: g(2, 14), tags: ["romance", "gifting", "beauty", "fashion"], leadDays: 10 },
  { id: "black_friday", title: "Black Friday", titleFa: "بلک فرایدی (جمعه سیاه)", category: "commercial", rule: { type: "nth_weekday", month: 11, weekday: 4, n: 4, offsetDays: 1 }, tags: ["sale", "shopping", "tech", "fashion", "beauty", "home"], leadDays: 14, notes: "Day after the 4th Thursday of November." },
  { id: "cyber_monday", title: "Cyber Monday", titleFa: "سایبر ماندی", category: "commercial", rule: { type: "nth_weekday", month: 11, weekday: 4, n: 4, offsetDays: 4 }, tags: ["sale", "shopping", "tech"], leadDays: 7, notes: "Monday after Black Friday." },
];

/** Built-in events with a holiday/celebration flag but used only to suppress promos. */
export function isPromotionSuppressed(ev: Pick<CalendarEvent, "sensitivity">): boolean {
  return ev.sensitivity === "mourning";
}

export interface EventCalendarOptions {
  /** Extra admin-defined events. */
  custom?: EventDefinition[];
  /** Set to false to start empty (only custom). Default true. */
  includeBuiltins?: boolean;
  /** Builtin ids to disable. */
  disabled?: string[];
  /** Days to add to every Hijri-computed date (aligns Umm al-Qura with Iran's official sighting). */
  hijriOffsetDays?: number;
  /** IANA zone used when a JS Date is passed to upcoming(). Default Asia/Tehran. */
  timeZone?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export class EventCalendar {
  private defs = new Map<string, EventDefinition>();
  private readonly hijriOffsetDays: number;
  private readonly timeZone: string;

  constructor(opts: EventCalendarOptions = {}) {
    this.hijriOffsetDays = opts.hijriOffsetDays ?? 0;
    this.timeZone = opts.timeZone ?? "Asia/Tehran";
    if (opts.includeBuiltins !== false) {
      const disabled = new Set(opts.disabled ?? []);
      for (const d of BUILTIN_EVENTS) if (!disabled.has(d.id)) this.defs.set(d.id, d);
    }
    for (const c of opts.custom ?? []) this.addCustomEvent(c);
  }

  /** Register an admin-defined event. Throws on invalid input or id clash with a builtin. */
  addCustomEvent(def: Omit<EventDefinition, "custom"> & { custom?: boolean }): void {
    validateDefinition(def);
    const existing = this.defs.get(def.id);
    if (existing && !existing.custom) throw new Error(`Event id "${def.id}" clashes with a built-in event`);
    this.defs.set(def.id, { ...def, category: def.category ?? "custom", custom: true });
  }

  removeCustomEvent(id: string): boolean {
    const d = this.defs.get(id);
    if (!d?.custom) return false;
    return this.defs.delete(id);
  }

  definitions(): EventDefinition[] {
    return [...this.defs.values()];
  }

  /** All occurrences within Gregorian year gy. */
  occurrencesInYear(gy: number): CalendarEvent[] {
    const out: CalendarEvent[] = [];
    for (const def of this.defs.values()) out.push(...this.resolve(def, gy));
    return out.sort(compareEvents);
  }

  /**
   * Events whose date lies in [fromDate, fromDate + days] (inclusive), sorted by date.
   * A multi-day event already in progress on fromDate is included.
   */
  upcoming(fromDate: Date | IsoDate, days: number): CalendarEvent[] {
    if (!Number.isFinite(days) || days < 0) throw new RangeError("days must be >= 0");
    const from = toIsoDate(fromDate, this.timeZone);
    const fromJdn = isoToJdn(from);
    const toJdn = fromJdn + Math.floor(days);
    const gyFrom = Number(from.slice(0, 4)) - 1; // previous year: multi-day events spanning New Year
    const gyTo = Number(jdnToIso(toJdn).slice(0, 4));
    const out: CalendarEvent[] = [];
    for (let gy = gyFrom; gy <= gyTo; gy += 1) {
      for (const ev of this.occurrencesInYear(gy)) {
        const start = isoToJdn(ev.date);
        const end = start + ev.durationDays - 1;
        if (end >= fromJdn && start <= toJdn) out.push(ev);
      }
    }
    return out.sort(compareEvents);
  }

  /** Next occurrence of an event id on/after fromDate (searches ~2 years). */
  next(id: string, fromDate: Date | IsoDate): CalendarEvent | undefined {
    return this.upcoming(fromDate, 800).find((e) => e.id === id && isoToJdn(e.date) >= isoToJdn(toIsoDate(fromDate, this.timeZone)));
  }

  private resolve(def: EventDefinition, gy: number): CalendarEvent[] {
    const rule = def.rule;
    const mk = (jdn: number, approximate: boolean, source: CalendarEvent["source"]): CalendarEvent => {
      const date = jdnToIso(jdn);
      return {
        id: def.id,
        instanceId: `${def.id}@${date}`,
        title: def.title,
        titleFa: def.titleFa,
        date,
        jalali: jdnToJalali(jdn),
        category: def.category,
        tags: [...def.tags],
        sensitivity: def.sensitivity ?? (def.tags.includes("mourning") ? "mourning" : "celebration"),
        holiday: def.holiday ?? false,
        durationDays: Math.max(1, def.durationDays ?? 1),
        leadDays: def.leadDays ?? 7,
        approximate,
        source: def.custom ? "custom" : source,
        ...(def.notes ? { notes: def.notes } : {}),
      };
    };
    switch (rule.type) {
      case "gregorian": {
        if (rule.month === 2 && rule.day === 29 && !isGregorianLeap(gy)) return [];
        return [mk(gregorianToJdn(gy, rule.month, rule.day), false, "gregorian")];
      }
      case "jalali": {
        // A Gregorian year overlaps Jalali years gy-622 (Jan..Mar) and gy-621 (Mar..Dec).
        const res: CalendarEvent[] = [];
        for (const jy of [gy - 622, gy - 621]) {
          if (rule.month === 12 && rule.day === 30 && jalaliMonthLength(jy, 12) < 30) continue;
          const jdn = jalaliToJdn(jy, rule.month, rule.day);
          if (jdnToIso(jdn).startsWith(`${gy}-`)) res.push(mk(jdn, false, "jalali"));
        }
        return res;
      }
      case "nth_weekday": {
        const base = isoToJdn(nthWeekdayOfMonth(gy, rule.month, rule.weekday, rule.n));
        return [mk(base + (rule.offsetDays ?? 0), false, "computed")];
      }
      case "hijri":
        return hijriOccurrencesInGregorianYear(gy, rule.month, rule.day, this.hijriOffsetDays).map((o) =>
          mk(o.jdn, true, o.source === "intl-umalqura" ? "hijri-intl" : "hijri-tabular"),
        );
      case "chaharshanbe_suri": {
        // Nowruz falling in this Gregorian year: jy = gy - 621.
        const nowruz = jalaliToJdn(gy - 621, 1, 1);
        // Last Wednesday strictly before Nowruz, then the evening before (Tuesday).
        let wed = nowruz - 1;
        while (weekdayOfJdn(wed) !== 3) wed -= 1;
        return [mk(wed - 1, false, "computed")];
      }
      case "once":
        return rule.date.startsWith(`${gy}-`) ? [mk(isoToJdn(rule.date), false, "custom")] : [];
    }
  }
}

function isGregorianLeap(gy: number): boolean {
  return (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
}

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id);
}

function validateDefinition(def: EventDefinition | (Omit<EventDefinition, "custom"> & { custom?: boolean })): void {
  if (!ID_RE.test(def.id)) throw new Error(`Invalid event id "${def.id}" (use a-z, 0-9, _ or -)`);
  if (!def.title?.trim() || !def.titleFa?.trim()) throw new Error("title and titleFa are required");
  const r = def.rule;
  const inRange = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  switch (r.type) {
    case "jalali":
      if (!inRange(r.month, 1, 12) || !inRange(r.day, 1, r.month <= 6 ? 31 : 30)) throw new Error("Invalid Jalali month/day");
      break;
    case "gregorian":
      if (!inRange(r.month, 1, 12) || !inRange(r.day, 1, [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][r.month - 1]!))
        throw new Error("Invalid Gregorian month/day");
      break;
    case "hijri":
      if (!inRange(r.month, 1, 12) || !inRange(r.day, 1, 30)) throw new Error("Invalid Hijri month/day");
      break;
    case "nth_weekday":
      if (!inRange(r.month, 1, 12) || !inRange(r.weekday, 0, 6) || !(inRange(r.n, 1, 5) || r.n === -1))
        throw new Error("Invalid nth_weekday rule");
      break;
    case "once":
      isoToJdn(r.date);
      break;
    case "chaharshanbe_suri":
      break;
    default:
      throw new Error("Unknown event rule");
  }
}

