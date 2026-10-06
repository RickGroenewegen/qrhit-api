import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CURRENCIES,
  LOCALES,
  MARKETS,
  SITE_LOCALES,
} from '../../src/data/shared/shared-data.generated';

const ROOT = path.resolve(__dirname, '../..');

describe('shared languages, markets and currencies', () => {
  it('matches the generated copies in this repo and the sibling repos', () => {
    // Skips a sibling that is not checked out; fails on any drift.
    expect(() =>
      execFileSync('node', ['scripts/sync-shared-data.mjs', '--check'], {
        cwd: ROOT,
        stdio: 'pipe',
      })
    ).not.toThrow();
  });

  it('has a database column for every site language', () => {
    // A language in LOCALE_DATA is read from these columns at once, in raw SQL
    // and Prisma selects: a missing one breaks the API, not just the language.
    const schema = readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
    const columns: Record<string, string[]> = {
      genre: ['name'],
      Playlist: ['description'],
      CompanyList: ['description'],
      EventBase: ['name', 'description', 'body'],
    };
    const missing: string[] = [];
    for (const [model, fields] of Object.entries(columns)) {
      const body = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
      for (const field of fields) {
        for (const l of SITE_LOCALES) {
          if (!new RegExp(`^\\s+${field}_${l.code}\\s`, 'm').test(body)) {
            missing.push(`${model}.${field}_${l.code}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('only refers to languages, markets and currencies it defines', () => {
    const locales = new Set(LOCALES.map((l) => l.code));
    const markets = new Set(MARKETS.map((m) => m.code));
    const currencies = new Set(CURRENCIES.map((c) => c.code));
    const bad: string[] = [];
    for (const l of LOCALES) {
      if (l.country && !markets.has(l.country)) bad.push(`${l.code}.country ${l.country}`);
      if (l.occasionCountry && !markets.has(l.occasionCountry)) bad.push(`${l.code}.occasionCountry`);
      if (l.currency && !currencies.has(l.currency)) bad.push(`${l.code}.currency ${l.currency}`);
      for (const c of l.shippingCountries) if (!markets.has(c as never)) bad.push(`${l.code}.shippingCountries ${c}`);
    }
    for (const m of MARKETS) {
      if (m.currency && !currencies.has(m.currency)) bad.push(`${m.code}.currency ${m.currency}`);
      for (const l of m.locales ?? []) if (!locales.has(l)) bad.push(`${m.code}.locales ${l}`);
      if (m.feed && !LOCALES.find((l) => l.code === m.feed)?.feedNumber) bad.push(`${m.code}.feed ${m.feed} has no feedNumber`);
    }
    expect(bad).toEqual([]);
  });

  it('never gives two feed languages the same number', () => {
    const numbers = LOCALES.filter((l) => l.feedNumber).map((l) => l.feedNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
