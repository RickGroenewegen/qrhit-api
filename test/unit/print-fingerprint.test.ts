import { describe, it, expect } from 'vitest';

import { computePrintFingerprint } from '../../src/printFingerprint';

/**
 * This hash decides whether a printer PDF is rebuilt before it is verified and
 * shipped. A false "unchanged" sends stale artwork to a print run that costs
 * real money, so the cases below are mostly about making sure edits that reach
 * the card do move the hash.
 */

const playlist = {
  name: 'Road Trip',
  productType: 'physical',
  subType: 'none',
  template: 'printer',
  theme: null,
  themeName: null,
  printerType: 'default',
  eco: false,
  doubleSided: true,
  addHowToCard: false,
  addHowToCardLocale: 'en',
  emoji: null,
  background: 'bg1.webp',
  logo: null,
  selectedFont: 'Inter',
  selectedFontSize: 12,
  qrColor: '#000000',
  qrBackgroundColor: '#ffffff',
  qrBackgroundType: 'solid',
  qrLogo: null,
  qrLogoScale: 50,
  hideCircle: false,
  backgroundFrontType: 'image',
  backgroundFrontColor: '#ffffff',
  useFrontGradient: false,
  gradientFrontColor: null,
  gradientFrontDegrees: 0,
  gradientFrontPosition: 0,
  backgroundBackType: 'solid',
  backgroundBack: null,
  backgroundBackColor: '#ffffff',
  fontColor: '#000000',
  useGradient: false,
  gradientBackgroundColor: null,
  gradientDegrees: 0,
  gradientPosition: 0,
  frontOpacity: 100,
  backOpacity: 100,
  allowDuplicates: false,
  // Deliberately present and deliberately not hashed.
  price: 42.5,
  boxQuantity: 1,
  printerHold: false,
};

const tracks = [
  { id: 1, trackId: 'a1', name: 'Song A', artist: 'Artist A', year: 1975 },
  { id: 2, trackId: 'b2', name: 'Song B', artist: 'Artist B', year: 1988 },
];

describe('computePrintFingerprint', () => {
  it('is stable for identical input', () => {
    expect(computePrintFingerprint(playlist, tracks)).toBe(
      computePrintFingerprint(playlist, tracks)
    );
  });

  it('changes when a release year is corrected', () => {
    const corrected = [tracks[0], { ...tracks[1], year: 1987 }];
    expect(computePrintFingerprint(playlist, corrected)).not.toBe(
      computePrintFingerprint(playlist, tracks)
    );
  });

  it.each([
    ['background', 'bg2.webp'],
    ['subType', 'sheets'],
    ['eco', true],
    ['fontColor', '#ff0000'],
    ['printerType', 'schneiders'],
    ['hideCircle', true],
    ['allowDuplicates', true],
    ['addHowToCard', true],
    ['addHowToCardLocale', 'de'],
  ])('changes when %s changes', (field, value) => {
    const changed = { ...playlist, [field]: value };
    expect(computePrintFingerprint(changed, tracks)).not.toBe(
      computePrintFingerprint(playlist, tracks)
    );
  });

  it('ignores fields that cannot reach the printed card', () => {
    const sameCard = {
      ...playlist,
      price: 99.99,
      boxQuantity: 4,
      printerHold: true,
    };
    expect(computePrintFingerprint(sameCard, tracks)).toBe(
      computePrintFingerprint(playlist, tracks)
    );
  });

  it('changes when tracks are reordered', () => {
    const reordered = [tracks[1], tracks[0]];
    expect(computePrintFingerprint(playlist, reordered)).not.toBe(
      computePrintFingerprint(playlist, tracks)
    );
  });

  it('changes when a track is added or removed', () => {
    const fewer = [tracks[0]];
    const more = [
      ...tracks,
      { id: 3, trackId: 'c3', name: 'Song C', artist: 'Artist C', year: 1999 },
    ];
    const base = computePrintFingerprint(playlist, tracks);
    expect(computePrintFingerprint(playlist, fewer)).not.toBe(base);
    expect(computePrintFingerprint(playlist, more)).not.toBe(base);
  });

  it('changes when a track title or artist is edited', () => {
    const retitled = [{ ...tracks[0], name: 'Song A (Remaster)' }, tracks[1]];
    const reattributed = [{ ...tracks[0], artist: 'Someone Else' }, tracks[1]];
    const base = computePrintFingerprint(playlist, tracks);
    expect(computePrintFingerprint(playlist, retitled)).not.toBe(base);
    expect(computePrintFingerprint(playlist, reattributed)).not.toBe(base);
  });

  it('treats null and undefined the same, so a schema default cannot fake drift', () => {
    const withNull = { ...playlist, logo: null };
    const withUndefined = { ...playlist, logo: undefined };
    expect(computePrintFingerprint(withNull, tracks)).toBe(
      computePrintFingerprint(withUndefined, tracks)
    );
  });

  it('does not collide across adjacent field boundaries', () => {
    // "a" + "b" vs "" + "ab" must not hash alike.
    const a = { ...playlist, background: 'a', logo: 'b' };
    const b = { ...playlist, background: '', logo: 'ab' };
    expect(computePrintFingerprint(a, tracks)).not.toBe(
      computePrintFingerprint(b, tracks)
    );
  });

  it('handles an empty track list', () => {
    expect(computePrintFingerprint(playlist, [])).toMatch(/^[0-9a-f]{64}$/);
  });
});
