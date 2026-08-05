import { describe, it, expect } from 'vitest';

/**
 * Unit tests for src/fonts.ts.
 *
 * Pure functions — no mocks needed.
 */

import {
  FONTS,
  getYearFontSize,
  getGoogleFontWeights,
  getGoogleFontName,
  getFontWeight,
} from '../../src/fonts';

// ──────────────────────────────────────────────
// FONTS array
// ──────────────────────────────────────────────

describe('FONTS array', () => {
  it('contains at least 10 font entries', () => {
    expect(FONTS.length).toBeGreaterThanOrEqual(10);
  });

  it('every entry has required fields', () => {
    for (const font of FONTS) {
      expect(typeof font.id).toBe('string');
      expect(typeof font.family).toBe('string');
      expect(typeof font.displayName).toBe('string');
      expect(typeof font.defaultSize).toBe('string');
      expect(typeof font.yearSize).toBe('string');
      expect(typeof font.googleFontName).toBe('string');
      expect(typeof font.googleFontWeights).toBe('string');
    }
  });

  it('includes Arial as the first/classic entry', () => {
    expect(FONTS[0].family).toContain('Arial');
  });

  it('all yearSize values end with px', () => {
    for (const font of FONTS) {
      expect(font.yearSize).toMatch(/^\d+px$/);
    }
  });

  it('all defaultSize values end with px', () => {
    for (const font of FONTS) {
      expect(font.defaultSize).toMatch(/^\d+px$/);
    }
  });

  it('ids are unique — the reseller API keys fonts by id', () => {
    const ids = FONTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('families are unique — selectedFont is stored as the family string', () => {
    const families = FONTS.map((f) => f.family);
    expect(new Set(families).size).toBe(families.length);
  });

  it('every weight variant leads with an alias and names a real Google family', () => {
    for (const font of FONTS.filter((f) => f.fontWeight)) {
      const leadingFamily = font.family.split(',')[0].trim().replace(/["']/g, '');
      expect(leadingFamily).toBe(font.id);
      expect(font.family).toContain(font.googleFontName);
      expect(font.googleFontWeights.split(';')).toContain(font.fontWeight);
    }
  });
});

// ──────────────────────────────────────────────
// getYearFontSize
// ──────────────────────────────────────────────

describe('getYearFontSize', () => {
  it('returns 44px (default) for empty string', () => {
    expect(getYearFontSize('')).toBe('44px');
  });

  it('returns 44px for unknown font family', () => {
    expect(getYearFontSize('Unknown Font, sans-serif')).toBe('44px');
  });

  it('returns 44px for Arial (no googleFontName)', () => {
    // Arial has empty googleFontName so it never matches
    expect(getYearFontSize('Arial, sans-serif')).toBe('44px');
  });

  it('returns correct yearSize for Oswald', () => {
    expect(getYearFontSize('Oswald, Arial, sans-serif')).toBe('42px');
  });

  it('returns correct yearSize for Bebas Neue', () => {
    expect(getYearFontSize('Bebas Neue, Arial, sans-serif')).toBe('46px');
  });

  it('returns correct yearSize for Pacifico (smallest at 36px)', () => {
    expect(getYearFontSize('Pacifico, Arial, cursive')).toBe('36px');
  });

  it('returns correct yearSize for Montserrat', () => {
    expect(getYearFontSize('Montserrat, Arial, sans-serif')).toBe('42px');
  });

  it('matches by substring (font name anywhere in string)', () => {
    // selectedFont might just be the name
    expect(getYearFontSize('Caveat')).toBe('44px');
  });

  it('returns 44px when input is undefined-like falsy', () => {
    expect(getYearFontSize(undefined as any)).toBe('44px');
    expect(getYearFontSize(null as any)).toBe('44px');
  });
});

// ──────────────────────────────────────────────
// getGoogleFontWeights
// ──────────────────────────────────────────────

describe('getGoogleFontWeights', () => {
  it('returns default 400;700 for empty string', () => {
    expect(getGoogleFontWeights('')).toBe('400;700');
  });

  it('returns default 400;700 for unknown font', () => {
    expect(getGoogleFontWeights('Unknown Font')).toBe('400;700');
  });

  it('returns single weight for Righteous (400 only)', () => {
    expect(getGoogleFontWeights('Righteous, Arial, sans-serif')).toBe('400');
  });

  it('returns multiple weights for Raleway', () => {
    expect(getGoogleFontWeights('Raleway, Arial, sans-serif')).toBe('400;700;800;900');
  });

  it('returns multiple weights for Teko', () => {
    expect(getGoogleFontWeights('Teko, Arial, sans-serif')).toBe('300;400;500;600;700');
  });

  it('returns 400;700 for Oswald', () => {
    expect(getGoogleFontWeights('Oswald, Arial, sans-serif')).toBe('400;700');
  });

  it('returns default for Arial (empty googleFontName)', () => {
    expect(getGoogleFontWeights('Arial, sans-serif')).toBe('400;700');
  });

  it('returns 400;700 for null/undefined input', () => {
    expect(getGoogleFontWeights(null as any)).toBe('400;700');
    expect(getGoogleFontWeights(undefined as any)).toBe('400;700');
  });
});

// ──────────────────────────────────────────────
// Weight variants (Roboto Condensed vs Roboto Condensed Bold)
// ──────────────────────────────────────────────

describe('weight variants', () => {
  const regular = '"Roboto Condensed", Arial, sans-serif';
  const bold = '"Roboto Condensed Bold", "Roboto Condensed", Arial, sans-serif';

  it('resolves the regular and the bold cut to different entries', () => {
    expect(getFontWeight(regular)).toBe('');
    expect(getFontWeight(bold)).toBe('700');
  });

  it('requests the real Google family for both', () => {
    expect(getGoogleFontName(regular)).toBe('Roboto Condensed');
    expect(getGoogleFontName(bold)).toBe('Roboto Condensed');
  });

  it('shares the year size with the regular cut', () => {
    expect(getYearFontSize(bold)).toBe(getYearFontSize(regular));
  });

  it('loads weight 700 for the bold cut', () => {
    expect(getGoogleFontWeights(bold).split(';')).toContain('700');
  });

  it('leaves other fonts without a weight', () => {
    expect(getFontWeight('Oswald, Arial, sans-serif')).toBe('');
    expect(getFontWeight('Arial, sans-serif')).toBe('');
    expect(getFontWeight('')).toBe('');
  });

  it('falls back to the leading family name for unknown fonts', () => {
    expect(getGoogleFontName('Unknown Font, sans-serif')).toBe('Unknown Font');
    expect(getGoogleFontName('')).toBe('');
  });
});
