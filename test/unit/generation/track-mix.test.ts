import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  CARDS_PER_STACK,
  isBusinessDeck,
  mixTrackOrder,
  MixTrack,
} from '../../../src/trackMix';
import { writeMixedTrackOrder } from '../../../src/data/trackOrder';

/**
 * The year mix for business decks (src/trackMix.ts) and the data function
 * that writes it (src/data/trackOrder.ts).
 */

/** Flatten a tagged-template $queryRaw/$executeRaw call into { sql, values }. */
function flatten(call: any[]) {
  const [strings, ...values] = call;
  const q = (Prisma.sql as any)(strings, ...values);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), values: q.values };
}

/** A deck the way business clients send it: sorted from old to new. */
function sortedDeck(n: number, from = 1960, to = 2020, artists = 50): MixTrack[] {
  const span = to - from + 1;
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    year: from + Math.floor((i * span) / n),
    artist: `Artist ${i % artists}`,
  }));
}

function inDeckOrder(tracks: MixTrack[], order: number[]): MixTrack[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return order.map((id) => byId.get(id)!);
}

function neighbourClashes(deck: MixTrack[]) {
  const artist = (t: MixTrack) => (t.artist ?? '').trim().toLowerCase();
  let sameYear = 0;
  let sameArtist = 0;
  for (let i = 1; i < deck.length; i++) {
    if (deck[i].year !== null && deck[i].year === deck[i - 1].year) sameYear++;
    if (artist(deck[i]) === artist(deck[i - 1])) sameArtist++;
  }
  return { sameYear, sameArtist };
}

describe('mixTrackOrder', () => {
  it('returns every track exactly once', () => {
    const tracks = sortedDeck(192);
    const order = mixTrackOrder(tracks, 42);

    expect(order).toHaveLength(192);
    expect([...order].sort((a, b) => a - b)).toEqual(tracks.map((t) => t.id));
  });

  it('gives the same deck for the same seed, whatever order the tracks come in', () => {
    const tracks = sortedDeck(192);

    const first = mixTrackOrder(tracks, 42);
    const again = mixTrackOrder([...tracks].reverse(), 42);

    expect(again).toEqual(first);
  });

  it('gives a different deck for a different seed', () => {
    const tracks = sortedDeck(192);

    expect(mixTrackOrder(tracks, 1)).not.toEqual(mixTrackOrder(tracks, 2));
  });

  it('breaks up an old-to-new deck: no neighbours share a year or an artist', () => {
    const tracks = sortedDeck(192);
    const deck = inDeckOrder(tracks, mixTrackOrder(tracks, 42));

    expect(neighbourClashes(deck)).toEqual({ sameYear: 0, sameArtist: 0 });
  });

  it('treats artists case-insensitively', () => {
    // 14 of 40 cards are Abba, written three ways.
    const spellings = ['ABBA', 'abba', ' Abba '];
    const tracks: MixTrack[] = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      year: 1960 + i,
      artist: i % 3 === 0 ? spellings[(i / 3) % 3] : `Other ${i}`,
    }));
    const deck = inDeckOrder(tracks, mixTrackOrder(tracks, 7));

    expect(neighbourClashes(deck).sameArtist).toBe(0);
  });

  it('gives every stack of 48 its share of every decade', () => {
    const tracks = sortedDeck(192);
    const deck = inDeckOrder(tracks, mixTrackOrder(tracks, 42));
    const decade = (t: MixTrack) => Math.floor(t.year! / 10) * 10;

    const deckCounts = new Map<number, number>();
    for (const t of tracks) deckCounts.set(decade(t), (deckCounts.get(decade(t)) ?? 0) + 1);
    const stacks = tracks.length / CARDS_PER_STACK;

    // Dealing whole cards, a stack can be off its exact share (7.75 cards,
    // say) by less than a card and a half, never more.
    for (let s = 0; s < stacks; s++) {
      const stack = deck.slice(s * CARDS_PER_STACK, (s + 1) * CARDS_PER_STACK);
      for (const [d, total] of deckCounts) {
        const inStack = stack.filter((t) => decade(t) === d).length;
        expect(Math.abs(inStack - total / stacks)).toBeLessThan(1.5);
      }
    }
  });

  it('balances a short last stack by its size', () => {
    const tracks = sortedDeck(120); // 48 + 48 + 24
    const deck = inDeckOrder(tracks, mixTrackOrder(tracks, 3));
    const last = deck.slice(96);
    const average = (cards: MixTrack[]) =>
      cards.reduce((sum, t) => sum + t.year!, 0) / cards.length;

    expect(last).toHaveLength(24);
    expect(Math.min(...last.map((t) => t.year!))).toBeLessThan(1970);
    expect(Math.max(...last.map((t) => t.year!))).toBeGreaterThan(2010);
    expect(Math.abs(average(last) - average(tracks))).toBeLessThan(3);
  });

  it('spreads a deck heavy on one decade without leaving a clump at the end', () => {
    const tracks: MixTrack[] = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      year: i < 350 ? 1980 + (i % 10) : 1960 + (i % 60),
      artist: `A${i % 120}`,
    }));
    const deck = inDeckOrder(tracks, mixTrackOrder(tracks, 11));

    expect(neighbourClashes(deck)).toEqual({ sameYear: 0, sameArtist: 0 });
    const tail = deck.slice(-48);
    expect(tail.filter((t) => t.year! >= 1980 && t.year! < 1990).length).toBeLessThan(48 * 0.85);
  });

  it('copes with a deck from a single year', () => {
    const tracks: MixTrack[] = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      year: 1985,
      artist: `A${i}`,
    }));
    const order = mixTrackOrder(tracks, 5);

    expect([...order].sort((a, b) => a - b)).toEqual(tracks.map((t) => t.id));
  });

  it('spreads tracks without a year over the deck like any other', () => {
    const tracks: MixTrack[] = Array.from({ length: 96 }, (_, i) => ({
      id: i + 1,
      year: i % 4 === 0 ? null : 1970 + (i % 40),
      artist: `A${i % 30}`,
    }));
    const deck = inDeckOrder(tracks, mixTrackOrder(tracks, 9));

    expect(deck.slice(0, 48).filter((t) => t.year === null)).toHaveLength(12);
    expect(deck.slice(48).filter((t) => t.year === null)).toHaveLength(12);
    expect(neighbourClashes(deck).sameYear).toBe(0);
  });

  it('handles an empty and a one-card deck', () => {
    expect(mixTrackOrder([], 1)).toEqual([]);
    expect(mixTrackOrder([{ id: 5, year: 1999, artist: 'X' }], 1)).toEqual([5]);
  });
});

describe('isBusinessDeck', () => {
  it('is true for Schneiders, Tromp and company-list (vibe) orders', () => {
    expect(isBusinessDeck('schneiders', false)).toBe(true);
    expect(isBusinessDeck('tromp', false)).toBe(true);
    expect(isBusinessDeck('printnbind', true)).toBe(true);
  });

  it('is false for consumer decks', () => {
    expect(isBusinessDeck('printnbind', false)).toBe(false);
    expect(isBusinessDeck(undefined, undefined)).toBe(false);
    expect(isBusinessDeck('reseller', false)).toBe(false);
    expect(isBusinessDeck('musicmatch', null)).toBe(false);
  });
});

describe('writeMixedTrackOrder', () => {
  function makeDeps(rows: any[]) {
    const prisma = {
      $queryRaw: vi.fn(async () => rows),
      $executeRaw: vi.fn(async () => rows.length),
    };
    return { deps: { prisma, logger: { log: vi.fn() } } as any, prisma };
  }

  it('mixes on the printed year and artist and writes a 0-based order', async () => {
    const rows = sortedDeck(10).map((t) => ({ ...t }));
    const { deps, prisma } = makeDeps(rows);

    const order = await writeMixedTrackOrder(deps, 42, 1234);

    expect(order).toEqual(mixTrackOrder(rows, 1234));

    const select = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(select.sql).toContain('COALESCE(tei.year, tracks.year) as year');
    expect(select.sql).toContain("COALESCE(NULLIF(tei.artist, ''), tracks.artist) as artist");
    expect(select.values).toEqual([42, 42]);

    const update = flatten(prisma.$executeRaw.mock.calls[0]);
    expect(update.sql).toContain('UPDATE playlist_has_tracks SET `order` = CASE trackId');
    const expected = order.flatMap((id, index) => [id, index]);
    expect(update.values).toEqual([...expected, 42]);
  });

  it('turns bigints from the driver into numbers', async () => {
    const { deps } = makeDeps([
      { id: 2n, year: 1990n, artist: 'A' },
      { id: 1n, year: null, artist: 'B' },
    ]);

    const order = await writeMixedTrackOrder(deps, 42, 1);

    expect([...order].sort()).toEqual([1, 2]);
  });

  it('writes nothing for a playlist without tracks', async () => {
    const { deps, prisma } = makeDeps([]);

    expect(await writeMixedTrackOrder(deps, 42, 1)).toEqual([]);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
