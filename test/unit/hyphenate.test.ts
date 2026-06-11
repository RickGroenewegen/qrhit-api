import { describe, it, expect } from 'vitest';
import { splitLongWord } from '../../src/data/hyphenate';

describe('splitLongWord', () => {
  it('returns the word as-is when it fits', () => {
    expect(splitLongWord('cat', 'en', 10)).toEqual(['cat']);
    expect(splitLongWord('exact', 'en', 5)).toEqual(['exact']);
  });

  it('splits an English word on syllable boundaries, merged up to maxLen', () => {
    // hypher syllables: ex-tra-or-di-nary
    expect(splitLongWord('extraordinary', 'en', 5)).toEqual([
      'extra',
      'ordi',
      'nary',
    ]);
  });

  it('never produces a chunk longer than maxLen and preserves the word', () => {
    for (const [word, locale, maxLen] of [
      ['supercalifragilistic', 'en', 4],
      ['Geschwindigkeitsbegrenzung', 'de', 6],
      ['ziekenhuisopname', 'nl', 5],
    ] as const) {
      const parts = splitLongWord(word, locale, maxLen);
      expect(parts.join('')).toBe(word);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(maxLen);
      }
    }
  });

  it('hard-chunks a syllable that is itself longer than maxLen', () => {
    // 'ifrag' (5 chars) exceeds maxLen 4 and must be fixed-chunked
    const parts = splitLongWord('supercalifragilistic', 'en', 4);
    expect(parts.join('')).toBe('supercalifragilistic');
    expect(parts).toContain('ifra');
  });

  it('falls back to fixed-size chunks for unsupported locales', () => {
    expect(splitLongWord('abcdefghij', 'xx', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('caches the unsupported-locale decision (repeat call is consistent)', () => {
    expect(splitLongWord('abcdefgh', 'zz', 3)).toEqual(['abc', 'def', 'gh']);
    expect(splitLongWord('abcdefgh', 'zz', 3)).toEqual(['abc', 'def', 'gh']);
  });

  it('treats an empty/missing locale as English', () => {
    const parts = splitLongWord('extraordinary', '', 5);
    expect(parts).toEqual(['extra', 'ordi', 'nary']);
  });

  it('uses Danish patterns for Norwegian (locale mapping)', () => {
    const parts = splitLongWord('arbeidsledighet', 'no', 6);
    expect(parts.join('')).toBe('arbeidsledighet');
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(6);
    }
  });

  it('falls back to fixed chunks when hyphenation yields a single syllable', () => {
    // 'strength' is one syllable; with maxLen 4 it must be hard-chunked
    expect(splitLongWord('strength', 'en', 4)).toEqual(['stre', 'ngth']);
  });
});
