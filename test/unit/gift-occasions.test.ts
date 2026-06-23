import { describe, it, expect } from 'vitest';
import {
  easterSunday,
  nthWeekdayOfMonth,
  addDays,
  utcDate,
  OCCASION_MATCHERS,
  SUPPLEMENT_RULES,
  TARGET_COUNTRIES,
} from '../../src/data/giftOccasions';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const matcher = (key: string) => OCCASION_MATCHERS.find((m) => m.key === key)!;
const supplement = (key: string) => SUPPLEMENT_RULES.find((r) => r.key === key)!;

describe('gift occasion date helpers', () => {
  it('computes Easter Sunday (Gregorian)', () => {
    expect(iso(easterSunday(2025))).toBe('2025-04-20');
    expect(iso(easterSunday(2026))).toBe('2026-04-05');
    expect(iso(easterSunday(2027))).toBe('2027-03-28');
  });

  it('computes Ascension Day as Easter + 39 (German Father\'s Day)', () => {
    expect(iso(addDays(easterSunday(2026), 39))).toBe('2026-05-14');
  });

  it('computes the n-th weekday of a month', () => {
    // 3rd Sunday of June 2026
    expect(iso(nthWeekdayOfMonth(2026, 6, 0, 3))).toBe('2026-06-21');
    // 2nd Sunday of May 2026
    expect(iso(nthWeekdayOfMonth(2026, 5, 0, 2))).toBe('2026-05-10');
    // 2nd Sunday of November 2026
    expect(iso(nthWeekdayOfMonth(2026, 11, 0, 2))).toBe('2026-11-08');
  });

  it('builds UTC-midnight dates from a 1-based month', () => {
    expect(iso(utcDate(2026, 3, 19))).toBe('2026-03-19');
    expect(utcDate(2026, 2, 14).getUTCHours()).toBe(0);
  });
});

describe('occasion matchers are anchored against false positives', () => {
  it('matches the intended holiday names', () => {
    expect(matcher('mothers_day').match.test("Mother's Day")).toBe(true);
    expect(matcher('fathers_day').match.test("Father's Day")).toBe(true);
    expect(matcher('christmas').match.test('Christmas Day')).toBe(true);
    expect(matcher('new_year').match.test("New Year's Day")).toBe(true);
    expect(matcher('kings_day').match.test("King's Day")).toBe(true);
    expect(matcher('thanksgiving').match.test('Thanksgiving Day')).toBe(true);
    expect(matcher('sinterklaas').match.test("St Nicholas' Eve")).toBe(true);
    expect(matcher('sinterklaas').match.test('Saint Nicholas')).toBe(true);
  });

  it('rejects look-alike holiday names', () => {
    expect(matcher('kings_day').match.test('Kingdom Day')).toBe(false);
    expect(matcher('kings_day').match.test('Martin Luther King Jr. Day')).toBe(false);
    expect(matcher('thanksgiving').match.test('Day after Thanksgiving Day')).toBe(false);
    expect(matcher('new_year').match.test("New Year's Eve")).toBe(false);
    expect(matcher('christmas').match.test('Christmas Eve')).toBe(false);
  });
});

describe('supplement rules fill library gaps', () => {
  it("resolves Father's Day per country", () => {
    const f = supplement('fathers_day');
    expect(iso(f.resolve(2026, 'DE')!)).toBe('2026-05-14'); // Ascension
    expect(iso(f.resolve(2026, 'IT')!)).toBe('2026-03-19'); // St Joseph
    expect(iso(f.resolve(2026, 'AT')!)).toBe('2026-06-14'); // 2nd Sun June
    expect(iso(f.resolve(2026, 'FR')!)).toBe('2026-06-21'); // 3rd Sun June
    expect(iso(f.resolve(2026, 'SE')!)).toBe('2026-11-08'); // 2nd Sun Nov
  });

  it("only supplements Mother's Day for JP/CN (library covers the rest)", () => {
    const m = supplement('mothers_day');
    expect(m.resolve(2026, 'NL')).toBeNull();
    expect(iso(m.resolve(2026, 'JP')!)).toBe('2026-05-10');
  });

  it("supplements Valentine's Day on Feb 14 everywhere", () => {
    const v = supplement('valentines_day');
    expect(iso(v.resolve(2026, 'NL')!)).toBe('2026-02-14');
    expect(iso(v.resolve(2026, 'US')!)).toBe('2026-02-14');
  });
});

describe('target countries', () => {
  it('covers the configured store markets', () => {
    expect(TARGET_COUNTRIES).toContain('NL');
    expect(TARGET_COUNTRIES).toContain('US');
    expect(TARGET_COUNTRIES.length).toBe(15);
  });
});
