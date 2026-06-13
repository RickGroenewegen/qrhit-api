import { describe, it, expect } from 'vitest';

/**
 * Unit tests for src/fonts.ts.
 *
 * Pure functions — no mocks needed.
 */

import { FONTS, getYearFontSize, getGoogleFontWeights } from '../../src/fonts';

// ──────────────────────────────────────────────
// FONTS array
// ──────────────────────────────────────────────

describe('FONTS array', () => {
  it('contains at least 10 font entries', () => {
    expect(FONTS.length).toBeGreaterThanOrEqual(10);
  });

  it('every entry has required fields', () => {
    for (const font of FONTS) {
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
