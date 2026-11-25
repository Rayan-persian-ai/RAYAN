import { describe, expect, it } from "vitest";
import {
  EventCalendar,
  BUILTIN_EVENTS,
  toJalali,
  toGregorian,
  isLeapJalaliYear,
  jalaliMonthLength,
  gregorianToJdn,
  jdnToGregorian,
  jdnToJalali,
  formatJalali,
  toPersianDigits,
  toLatinDigits,
  isoToJdn,
  jdnToIso,
  weekdayOfJdn,
  toIsoDate,
  nthWeekdayOfMonth,
  hijriCivilToJdn,
  jdnToHijriCivil,
  jdnToHijri,
  hasIntlHijri,
  hijriOccurrencesInGregorianYear,
} from "../src/index.js";

describe("Jalali conversion", () => {
  it("converts known dates", () => {
    expect(toJalali(2026, 3, 21)).toEqual({ jy: 1405, jm: 1, jd: 1 });
    expect(toJalali(2025, 3, 21)).toEqual({ jy: 1404, jm: 1, jd: 1 });
    expect(toJalali(2024, 3, 20)).toEqual({ jy: 1403, jm: 1, jd: 1 });
    expect(toJalali(2026, 11, 25)).toEqual({ jy: 1405, jm: 9, jd: 4 });
    expect(toJalali(1979, 2, 11)).toEqual({ jy: 1357, jm: 11, jd: 22 });
    expect(toGregorian(1405, 9, 30)).toEqual({ gy: 2026, gm: 12, gd: 21 });
    expect(toGregorian(1403, 12, 30)).toEqual({ gy: 2025, gm: 3, gd: 20 });
  });

  it("handles leap years and month lengths", () => {
    expect(isLeapJalaliYear(1399)).toBe(true);
    expect(isLeapJalaliYear(1403)).toBe(true);
    expect(isLeapJalaliYear(1404)).toBe(false);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliMonthLength(1404, 6)).toBe(31);
    expect(jalaliMonthLength(1404, 7)).toBe(30);
    expect(() => toGregorian(1404, 12, 30)).toThrow(RangeError);
  });

  it("round-trips every day 1390..1415 and agrees with Intl persian calendar", () => {
    const fmt = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
    const start = gregorianToJdn(2011, 3, 21);
    const end = gregorianToJdn(2036, 3, 20);
    let checkedIntl = 0;
    for (let jdn = start; jdn <= end; jdn += 1) {
      const j = jdnToJalali(jdn);
      const g = jdnToGregorian(jdn);
      expect(toGregorian(j.jy, j.jm, j.jd)).toEqual(g);
      if (jdn % 7 === 0) {
        const parts = fmt.formatToParts(new Date(Date.UTC(g.gy, g.gm - 1, g.gd)));
        const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
        expect({ jy: get("year") || get("relatedYear"), jm: get("month"), jd: get("day") }).toEqual(j);
        checkedIntl += 1;
      }
    }
    expect(checkedIntl).toBeGreaterThan(1000);
  });

  it("formats with Persian digits and month names", () => {
    expect(formatJalali({ jy: 1405, jm: 9, jd: 30 })).toBe("1405/09/30");
    expect(formatJalali({ jy: 1405, jm: 9, jd: 30 }, { persianDigits: true, monthName: true })).toBe("۳۰ آذر ۱۴۰۵");
    expect(toPersianDigits("2026")).toBe("۲۰۲۶");
    expect(toLatinDigits("۱۴۰۵/٠٩")).toBe("1405/09");
  });
});

describe("civil date helpers", () => {
  it("JDN / ISO / weekday", () => {
    expect(gregorianToJdn(2000, 1, 1)).toBe(2451545);
    expect(jdnToIso(isoToJdn("2024-02-29"))).toBe("2024-02-29");
    expect(weekdayOfJdn(isoToJdn("2026-11-25"))).toBe(3); // Wednesday
    expect(() => isoToJdn("2025-02-29")).toThrow();
    expect(nthWeekdayOfMonth(2026, 11, 4, 4)).toBe("2026-11-26");
    expect(nthWeekdayOfMonth(2026, 5, 1, -1)).toBe("2026-05-25");
  });
  it("converts instants to the Tehran calendar date", () => {
    // 2026-03-20T21:00Z is 00:30 on 21 March in Tehran (UTC+3:30)
    expect(toIsoDate(new Date("2026-03-20T21:00:00Z"))).toBe("2026-03-21");
    expect(toIsoDate(new Date("2026-03-20T21:00:00Z"), "UTC")).toBe("2026-03-20");
  });
});

describe("Hijri", () => {
  it("tabular civil round-trips", () => {
    for (let jdn = 2450000; jdn < 2470000; jdn += 37) {
      const h = jdnToHijriCivil(jdn);
      expect(hijriCivilToJdn(h.hy, h.hm, h.hd)).toBe(jdn);
    }
  });
  it("uses Intl Umm al-Qura when available", () => {
    expect(hasIntlHijri()).toBe(true);
    const h = jdnToHijri(isoToJdn("2026-12-10"));
    expect(h.source).toBe("intl-umalqura");
    expect([h.hm, h.hd]).toEqual([7, 1]);
  });
  it("finds 20 Jumada al-Thani (Iran Mother's Day) near the official date", () => {
    // Official Iranian Mother's Day 1404 = 20 Azar 1404 = 2025-12-11
    const occ = hijriOccurrencesInGregorianYear(2025, 6, 20);
    expect(occ).toHaveLength(1);
    expect(Math.abs(occ[0]!.jdn - isoToJdn("2025-12-11"))).toBeLessThanOrEqual(1);
  });
});

describe("EventCalendar", () => {
  const cal = new EventCalendar();
  const find = (year: number, id: string) => cal.occurrencesInYear(year).filter((e) => e.id === id);

  it("resolves fixed Jalali events", () => {
    expect(find(2026, "nowruz")[0]!.date).toBe("2026-03-21");
    expect(find(2026, "nowruz")[0]!.durationDays).toBe(4);
    expect(find(2025, "nowruz")[0]!.date).toBe("2025-03-21");
    expect(find(2026, "sizdah_bedar")[0]!.date).toBe("2026-04-02");
    expect(find(2026, "yalda")[0]!.date).toBe("2026-12-21");
    expect(find(2026, "yalda")[0]!.jalali).toEqual({ jy: 1405, jm: 9, jd: 30 });
    expect(find(2026, "revolution_day")[0]!.date).toBe("2026-02-11");
    expect(find(2026, "school_opening")[0]!.date).toBe("2026-09-23");
  });

  it("computes Chaharshanbe Suri as the Tuesday before the last Wednesday of the year", () => {
    const cs26 = find(2026, "chaharshanbe_suri")[0]!;
    expect(cs26.date).toBe("2026-03-17");
    expect(weekdayOfJdn(isoToJdn(cs26.date))).toBe(2);
    expect(find(2025, "chaharshanbe_suri")[0]!.date).toBe("2025-03-18");
  });

  it("computes Black Friday / Cyber Monday / fixed Gregorian days", () => {
    expect(find(2026, "black_friday")[0]!.date).toBe("2026-11-27");
    expect(find(2025, "black_friday")[0]!.date).toBe("2025-11-28");
    expect(find(2024, "black_friday")[0]!.date).toBe("2024-11-29");
    expect(find(2026, "cyber_monday")[0]!.date).toBe("2026-11-30");
    expect(find(2027, "new_year_gregorian")[0]!.date).toBe("2027-01-01");
    expect(find(2027, "valentines_day")[0]!.date).toBe("2027-02-14");
  });

  it("marks lunar events approximate and mourning days sensitive", () => {
    const md = find(2026, "mothers_day_ir");
    expect(md.length).toBeGreaterThanOrEqual(1);
    expect(md.every((e) => e.approximate && e.source === "hijri-intl")).toBe(true);
    expect(jdnToHijri(isoToJdn(md[0]!.date))).toMatchObject({ hm: 6, hd: 20 });
    const ashura = find(2026, "ashura")[0]!;
    expect(ashura.sensitivity).toBe("mourning");
    expect(find(2026, "nowruz")[0]!.approximate).toBe(false);
  });

  it("upcoming(fromDate, days) returns sorted events within an inclusive window", () => {
    const up = cal.upcoming("2026-11-25", 30);
    const ids = up.map((e) => e.id);
    expect(ids).toContain("black_friday");
    expect(ids).toContain("cyber_monday");
    expect(ids).toContain("students_day");
    expect(ids).toContain("yalda");
    expect(ids).not.toContain("nowruz");
    const dates = up.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
    expect(cal.upcoming("2026-11-27", 0).map((e) => e.id)).toEqual(["black_friday"]);
  });

  it("includes a multi-day event already in progress", () => {
    expect(cal.upcoming("2026-03-23", 1).map((e) => e.id)).toContain("nowruz");
    expect(cal.upcoming("2026-03-25", 1).map((e) => e.id)).not.toContain("nowruz");
  });

  it("upcoming() across the year boundary and from a JS Date (Tehran time)", () => {
    const up = cal.upcoming(new Date("2026-12-30T22:00:00Z"), 3); // already Dec 31 in Tehran
    expect(up.map((e) => e.date)).toContain("2027-01-01");
  });

  it("supports admin-defined custom events", () => {
    const c = new EventCalendar({
      custom: [
        { id: "shop_anniversary", title: "Shop anniversary", titleFa: "سالگرد فروشگاه", category: "custom", rule: { type: "jalali", month: 8, day: 10 }, tags: ["sale"] },
        { id: "launch_2027", title: "Launch", titleFa: "رونمایی", category: "custom", rule: { type: "once", date: "2027-01-15" }, tags: ["tech"] },
      ],
    });
    const anniv = c.occurrencesInYear(2026).find((e) => e.id === "shop_anniversary")!;
    expect(anniv.date).toBe(jdnToIso(gregorianToJdn(toGregorian(1405, 8, 10).gy, toGregorian(1405, 8, 10).gm, toGregorian(1405, 8, 10).gd)));
    expect(anniv.source).toBe("custom");
    expect(c.next("launch_2027", "2026-11-25")!.date).toBe("2027-01-15");
    expect(() => c.addCustomEvent({ id: "nowruz", title: "x", titleFa: "x", category: "custom", rule: { type: "gregorian", month: 1, day: 1 }, tags: [] })).toThrow(/clashes/);
    expect(() => c.addCustomEvent({ id: "Bad Id", title: "x", titleFa: "x", category: "custom", rule: { type: "gregorian", month: 1, day: 1 }, tags: [] })).toThrow();
    expect(() => c.addCustomEvent({ id: "bad_day", title: "x", titleFa: "x", category: "custom", rule: { type: "jalali", month: 9, day: 31 }, tags: [] })).toThrow();
    expect(c.removeCustomEvent("shop_anniversary")).toBe(true);
    expect(c.removeCustomEvent("nowruz")).toBe(false);
  });

  it("can disable built-ins and every built-in resolves for several years", () => {
    const c = new EventCalendar({ disabled: ["valentines_day"] });
    expect(c.definitions().some((d) => d.id === "valentines_day")).toBe(false);
    for (let y = 2024; y <= 2030; y += 1) {
      const ids = new Set(cal.occurrencesInYear(y).map((e) => e.id));
      for (const d of BUILTIN_EVENTS) expect(ids.has(d.id), `${d.id} in ${y}`).toBe(true);
    }
  });
});
