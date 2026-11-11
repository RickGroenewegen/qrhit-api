import { describe, it, expect } from 'vitest';
import { isValidListSlug, parseOrderNumber, pickLineTheme } from '../../src/howtoTheme';

/**
 * The personal how-to page (www.qrsong.io/how-to/<list slug>) wears the theme
 * an admin put on the list's order line.
 */
describe('pickLineTheme', () => {
  it('takes the theme of the first line that has one', () => {
    expect(
      pickLineTheme([
        { id: 12, theme: 'second', themeName: 'Second' },
        { id: 10, theme: null, themeName: null },
        { id: 11, theme: 'trimetal-rol-door-de-tijd', themeName: 'Trimetal Rol door de tijd' },
      ])
    ).toEqual({ slug: 'trimetal-rol-door-de-tijd', name: 'Trimetal Rol door de tijd' });
  });

  it('names the theme after its slug without a theme name', () => {
    expect(pickLineTheme([{ id: 1, theme: 'vanharen', themeName: '' }])).toEqual({
      slug: 'vanharen',
      name: 'vanharen',
    });
  });

  it('has no theme for an order without one', () => {
    expect(pickLineTheme([])).toBeNull();
    expect(pickLineTheme([{ id: 1, theme: '  ', themeName: 'x' }])).toBeNull();
  });
});

describe('isValidListSlug', () => {
  it('takes the slugs company lists have', () => {
    for (const slug of ['medienwerft-gmbh', 'breaker', '1800-cards-iq8u0', 'pimm1-bxnnv', 'Kerst_2026']) {
      expect(isValidListSlug(slug)).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const slug of ['', '-x', 'a/b', 'a.b', '../x', 'a b', 'x'.repeat(129), 5, null]) {
      expect(isValidListSlug(slug)).toBe(false);
    }
  });
});

describe('parseOrderNumber', () => {
  it('reads our order number as a string or a number', () => {
    expect(parseOrderNumber('100009357')).toEqual({ orderId: '100009357' });
    expect(parseOrderNumber(' 100009357 ')).toEqual({ orderId: '100009357' });
    expect(parseOrderNumber(100009357)).toEqual({ orderId: '100009357' });
  });

  it('clears the link on null or an empty string', () => {
    expect(parseOrderNumber(null)).toEqual({ orderId: null });
    expect(parseOrderNumber('')).toEqual({ orderId: null });
  });

  it('refuses what is not an order number', () => {
    for (const value of ['tr_abc', '12', 'toolkit_F6ZyWkNTPXvVjOoV', 9357.5, true, {}]) {
      expect('error' in parseOrderNumber(value)).toBe(true);
    }
  });
});
