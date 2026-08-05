import { describe, it, expect } from 'vitest';

/**
 * Unit tests for src/qr-logo.ts geometry.
 *
 * The rect these return is what the generator clears from the QR bitmap, so a
 * span that does not land on module boundaries shows up on the card as half
 * squares around the logo.
 */

import {
  getQrLogoRect,
  clampScale,
  sanitizeLogoFilename,
  resolveLogoPath,
  DEFAULT_SCALE,
  MIN_SCALE,
  MAX_SCALE,
  MAX_AREA_FRACTION,
} from '../../src/qr-logo';

// Totals a QR can have, quiet zone included: the symbol is always odd, and the
// 4-module quiet zone on each side keeps it odd.
const TOTALS = [33, 37, 41, 45, 49, 53];
const ASPECTS = [1, 170 / 466, 2.5];

describe('clampScale', () => {
  it('defaults when the scale is missing or not a number', () => {
    expect(clampScale(undefined)).toBe(DEFAULT_SCALE);
    expect(clampScale(null)).toBe(DEFAULT_SCALE);
    expect(clampScale(NaN)).toBe(DEFAULT_SCALE);
  });

  it('clamps to the range the designer offers', () => {
    expect(clampScale(1)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(22)).toBe(22);
  });

  it('rounds fractional scales', () => {
    expect(clampScale(22.4)).toBe(22);
    expect(clampScale(22.6)).toBe(23);
  });
});

describe('sanitizeLogoFilename', () => {
  it('accepts the filenames the upload produces', () => {
    expect(sanitizeLogoFilename('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.png')).toBe(
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.png'
    );
    expect(sanitizeLogoFilename('logo-2.jpeg')).toBe('logo-2.jpeg');
    expect(sanitizeLogoFilename('  logo.webp  ')).toBe('logo.webp');
  });

  it('rejects traversal and absolute paths', () => {
    // qrLogo becomes a path sharp reads, so these must never survive.
    expect(sanitizeLogoFilename('../../private/invoices/secret.png')).toBeNull();
    expect(sanitizeLogoFilename('..\\..\\secret.png')).toBeNull();
    expect(sanitizeLogoFilename('/etc/passwd')).toBeNull();
    expect(sanitizeLogoFilename('sub/dir/logo.png')).toBeNull();
  });

  it('rejects non-image and empty values', () => {
    expect(sanitizeLogoFilename('logo.pdf')).toBeNull();
    expect(sanitizeLogoFilename('logo')).toBeNull();
    expect(sanitizeLogoFilename('')).toBeNull();
    expect(sanitizeLogoFilename(null)).toBeNull();
    expect(sanitizeLogoFilename(undefined)).toBeNull();
    expect(sanitizeLogoFilename(42 as any)).toBeNull();
  });
});

describe('resolveLogoPath', () => {
  it('resolves a valid filename inside the logo directory', () => {
    const resolved = resolveLogoPath('/srv/public', 'logo.png');
    expect(resolved).toBe('/srv/public/logo/logo.png');
  });

  it('returns null rather than escaping the logo directory', () => {
    for (const bad of [
      '../../etc/passwd',
      '../background/other.png',
      '/etc/passwd',
      'a/../../b.png',
    ]) {
      expect(resolveLogoPath('/srv/public', bad)).toBeNull();
    }
  });

  it('returns null for a missing filename', () => {
    expect(resolveLogoPath('/srv/public', null)).toBeNull();
    expect(resolveLogoPath('/srv/public', undefined)).toBeNull();
  });
});

describe('getQrLogoRect', () => {
  it('lands on module boundaries for every grid, scale and aspect', () => {
    for (const total of TOTALS) {
      for (const scale of [MIN_SCALE, DEFAULT_SCALE, MAX_SCALE]) {
        for (const aspect of ASPECTS) {
          const rect = getQrLogoRect(total, scale, aspect);
          // A centred box only sits on boundaries when its span shares the
          // grid's parity, which is what makes these whole numbers.
          expect(Number.isInteger(rect.x)).toBe(true);
          expect(Number.isInteger(rect.y)).toBe(true);
          expect(Number.isInteger(rect.width)).toBe(true);
          expect(Number.isInteger(rect.height)).toBe(true);
        }
      }
    }
  });

  it('stays inside the QR', () => {
    for (const total of TOTALS) {
      for (const aspect of ASPECTS) {
        const rect = getQrLogoRect(total, MAX_SCALE, aspect);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(total);
        expect(rect.y + rect.height).toBeLessThanOrEqual(total);
      }
    }
  });

  it('is centred on both axes', () => {
    for (const total of TOTALS) {
      const rect = getQrLogoRect(total, DEFAULT_SCALE, 0.5);
      expect(rect.x * 2 + rect.width).toBe(total);
      expect(rect.y * 2 + rect.height).toBe(total);
    }
  });

  it('never clears more than error correction can absorb', () => {
    // Measured: a square logo clearing 14.3% of the symbol still decodes,
    // 17.8% does not. Every scale and shape has to stay inside that.
    for (const total of TOTALS) {
      for (const scale of [MIN_SCALE, DEFAULT_SCALE, MAX_SCALE]) {
        for (const aspect of ASPECTS) {
          const rect = getQrLogoRect(total, scale, aspect);
          const covered = (rect.width * rect.height) / (total * total);
          expect(covered).toBeLessThanOrEqual(MAX_AREA_FRACTION);
        }
      }
    }
  });

  it('lets a wide logo use the full slider, since it costs little area', () => {
    const wide = getQrLogoRect(45, MAX_SCALE, 170 / 466);
    const atThirty = getQrLogoRect(45, 30, 170 / 466);
    expect(wide.width).toBeGreaterThan(atThirty.width);
  });

  it('holds a square logo back before it stops scanning', () => {
    // The slider still reads its maximum, but the area budget shrinks the rect.
    const square = getQrLogoRect(45, MAX_SCALE, 1);
    expect(square.width).toBe(getQrLogoRect(45, 30, 1).width);
  });

  it('grows with the scale', () => {
    const small = getQrLogoRect(45, MIN_SCALE, 1);
    const large = getQrLogoRect(45, MAX_SCALE, 1);
    expect(large.width).toBeGreaterThan(small.width);
  });

  it('shapes the rect to the logo, so a wide mark gets a wide rect', () => {
    const wide = getQrLogoRect(45, DEFAULT_SCALE, 170 / 466);
    expect(wide.width).toBeGreaterThan(wide.height);

    const square = getQrLogoRect(45, DEFAULT_SCALE, 1);
    expect(square.width).toBe(square.height);
  });

  it('clamps an out-of-range scale rather than trusting it', () => {
    expect(getQrLogoRect(45, 999, 1)).toEqual(getQrLogoRect(45, MAX_SCALE, 1));
  });
});
