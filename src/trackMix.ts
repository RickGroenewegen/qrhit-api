/**
 * Year-mixed card order for business decks.
 *
 * Business clients often hand us a playlist sorted from old to new, and the
 * printer (Schneiders) delivers the cards in deck order, so the first box
 * compartment held only the sixties. A playlist with Playlist.trackMixSeed set
 * gets this order instead of the streaming service's:
 *
 * 1. The deck is cut into stacks of CARDS_PER_STACK (the boundaries the admin
 *    track-order page shows). Walking the tracks from oldest to newest, each
 *    one goes to the stack that is least full for its size, so every stack
 *    holds its share of every era.
 * 2. Each stack is shuffled.
 * 3. A repair pass swaps cards within their stack so that neighbours do not
 *    share a year or an artist, wherever the deck allows it.
 *
 * The result depends only on the set of tracks, their years and artists and
 * the seed, never on the order they come in, so a regeneration reproduces the
 * same deck (and the same print fingerprint) until something on it changes.
 */

import { PRINTER_TYPE } from './config/constants';

export const CARDS_PER_STACK = 48;

/**
 * Business decks get the year mix on generation: the ones we print through
 * Schneiders or Tromp. Consumer decks keep the streaming service's order.
 */
export function isBusinessDeck(
  printerType: string | null | undefined
): boolean {
  return (
    printerType === PRINTER_TYPE.SCHNEIDERS ||
    printerType === PRINTER_TYPE.TROMP
  );
}

/** Swaps strictly reduce the clashes, so this is a cap, not a requirement. */
const MAX_REPAIR_PASSES = 5;

export interface MixTrack {
  /** tracks.id */
  id: number;
  year: number | null;
  artist: string | null;
}

interface Card {
  id: number;
  year: number | null;
  artist: string;
}

/** mulberry32: a small seedable PRNG, good enough for shuffling cards. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Neighbours clash when they share a year or an artist. */
function clash(a: Card | undefined, b: Card | undefined): boolean {
  if (!a || !b) return false;
  if (a.year !== null && a.year === b.year) return true;
  return a.artist !== '' && a.artist === b.artist;
}

/**
 * The tracks' ids in year-mixed deck order. Pure: the same tracks and seed
 * always give the same order.
 */
export function mixTrackOrder(
  tracks: MixTrack[],
  seed: number,
  stackSize: number = CARDS_PER_STACK
): number[] {
  if (tracks.length === 0) return [];

  const random = seededRandom(seed);
  const cards: Card[] = [...tracks]
    .sort((a, b) => a.id - b.id)
    .map((track) => ({
      id: track.id,
      year: track.year,
      artist: (track.artist ?? '').trim().toLowerCase(),
    }));
  const n = cards.length;

  // 1. Stacks, each with its share of every era. Unknown years come last in
  // the walk, so they are spread over the stacks like everything else.
  const tiebreak = new Map(cards.map((card) => [card.id, random()]));
  const byYear = [...cards].sort((a, b) => {
    if (a.year !== b.year) {
      if (a.year === null) return 1;
      if (b.year === null) return -1;
      return a.year - b.year;
    }
    return tiebreak.get(a.id)! - tiebreak.get(b.id)!;
  });

  const capacities: number[] = [];
  for (let left = n; left > 0; left -= stackSize) {
    capacities.push(Math.min(stackSize, left));
  }
  const stacks: Card[][] = capacities.map(() => []);

  for (const card of byYear) {
    // The least full stack relative to its size; fill ratios are compared by
    // cross-multiplying to stay in integers. Ties go to a random one.
    let candidates: number[] = [];
    for (let s = 0; s < stacks.length; s++) {
      if (stacks[s].length >= capacities[s]) continue;
      if (candidates.length === 0) {
        candidates = [s];
        continue;
      }
      const best = candidates[0];
      const diff =
        stacks[s].length * capacities[best] - stacks[best].length * capacities[s];
      if (diff < 0) candidates = [s];
      else if (diff === 0) candidates.push(s);
    }
    stacks[candidates[Math.floor(random() * candidates.length)]].push(card);
  }

  // 2. Shuffle every stack (Fisher-Yates).
  for (const stack of stacks) {
    for (let i = stack.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [stack[i], stack[j]] = [stack[j], stack[i]];
    }
  }

  const deck = stacks.flat();

  // 3. Repair: swap a clashing card with the nearest card in its own stack
  // that lowers the number of clashing neighbours around both positions.
  const clashesAround = (positions: number[]): number => {
    const pairs = new Set<number>();
    for (const p of positions) {
      if (p > 0) pairs.add(p - 1);
      if (p < n - 1) pairs.add(p);
    }
    let count = 0;
    for (const p of pairs) if (clash(deck[p], deck[p + 1])) count++;
    return count;
  };

  const trySwap = (i: number, j: number): boolean => {
    const before = clashesAround([i, j]);
    [deck[i], deck[j]] = [deck[j], deck[i]];
    if (clashesAround([i, j]) < before) return true;
    [deck[i], deck[j]] = [deck[j], deck[i]];
    return false;
  };

  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    let swapped = false;
    for (let i = 1; i < n; i++) {
      if (!clash(deck[i - 1], deck[i])) continue;
      const start = Math.floor(i / stackSize) * stackSize;
      const end = Math.min(start + stackSize, n);
      search: for (let distance = 1; distance < stackSize; distance++) {
        for (const j of [i + distance, i - distance]) {
          if (j < start || j >= end) continue;
          if (trySwap(i, j)) {
            swapped = true;
            break search;
          }
        }
      }
    }
    if (!swapped) break;
  }

  return deck.map((card) => card.id);
}
