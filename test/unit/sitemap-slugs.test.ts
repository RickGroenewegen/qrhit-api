import { describe, it, expect } from 'vitest';
import { isDegenerateProductSlug } from '../../src/data/misc';

/**
 * These guard the conservative half of the rule. Excluding a real product from
 * the sitemap is a worse failure than leaving an ugly URL in it, so the
 * "keeps" list matters more than the "drops" list.
 */
describe('isDegenerateProductSlug', () => {
  it('drops uniqueness counters left behind by an empty slugify', () => {
    // Live examples: /en/product/-2, -3, -4 came from playlist names that
    // slugified to nothing (CJK, emoji, punctuation).
    expect(isDegenerateProductSlug('-2')).toBe(true);
    expect(isDegenerateProductSlug('-3')).toBe(true);
    expect(isDegenerateProductSlug('-4')).toBe(true);
  });

  it('drops empty and dash-only slugs', () => {
    expect(isDegenerateProductSlug('')).toBe(true);
    expect(isDegenerateProductSlug('-')).toBe(true);
    expect(isDegenerateProductSlug('---')).toBe(true);
  });

  it('drops single-character slugs', () => {
    expect(isDegenerateProductSlug('a')).toBe(true);
    expect(isDegenerateProductSlug('my-')).toBe(false); // 'my' is 2 chars, kept
  });

  it('keeps short but plausible band and album names', () => {
    // 'pur' is a German band, 'am' an Arctic Monkeys album. Guessing that a
    // two-letter slug is junk would silently deindex real products.
    expect(isDegenerateProductSlug('pur')).toBe(false);
    expect(isDegenerateProductSlug('am')).toBe(false);
    expect(isDegenerateProductSlug('jk')).toBe(false);
    expect(isDegenerateProductSlug('qr')).toBe(false);
  });

  it('keeps year and decade playlists', () => {
    expect(isDegenerateProductSlug('2016')).toBe(false);
    expect(isDegenerateProductSlug('1920-2000')).toBe(false);
    expect(isDegenerateProductSlug('1955-2026')).toBe(false);
  });

  it('keeps ordinary slugs, trailing dash included', () => {
    expect(isDegenerateProductSlug('happy-birthday-')).toBe(false);
    expect(isDegenerateProductSlug('music-brasileiras-1')).toBe(false);
    expect(isDegenerateProductSlug('van-alles-wat-')).toBe(false);
  });
});
