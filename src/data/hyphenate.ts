import { LOCALES } from './shared/shared-data.generated';

const Hypher = require('hypher');

// `hyphenation` per language in src/data/shared/locales.json (Norwegian uses
// the Danish patterns).
const patternModules: Record<string, string> = Object.fromEntries(
  LOCALES.filter((l) => l.hyphenation).map((l) => [l.code, l.hyphenation!])
);

const hyphenatorCache = new Map<string, any | null>();

function getHyphenator(locale: string): any | null {
  const key = (locale || 'en').toLowerCase();
  if (hyphenatorCache.has(key)) return hyphenatorCache.get(key)!;

  const moduleName = patternModules[key];
  if (!moduleName) {
    hyphenatorCache.set(key, null);
    return null;
  }
  try {
    const patterns = require(moduleName);
    const h = new Hypher(patterns);
    hyphenatorCache.set(key, h);
    return h;
  } catch {
    hyphenatorCache.set(key, null);
    return null;
  }
}

function chunkFixed(word: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < word.length; i += maxLen) {
    chunks.push(word.slice(i, i + maxLen));
  }
  return chunks;
}

export function splitLongWord(
  word: string,
  locale: string,
  maxLen: number
): string[] {
  if (word.length <= maxLen) return [word];

  const h = getHyphenator(locale);
  const syllables: string[] = h ? h.hyphenate(word) : [];

  if (syllables.length < 2 || syllables.join('') !== word) {
    return chunkFixed(word, maxLen);
  }

  const merged: string[] = [];
  let current = '';
  for (const syl of syllables) {
    if (syl.length > maxLen) {
      if (current) {
        merged.push(current);
        current = '';
      }
      merged.push(...chunkFixed(syl, maxLen));
      continue;
    }
    if ((current + syl).length > maxLen) {
      merged.push(current);
      current = syl;
    } else {
      current += syl;
    }
  }
  if (current) merged.push(current);
  return merged;
}
