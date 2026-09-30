import { describe, it, expect } from 'vitest';
import {
  ArtistBalance,
  ArtistIntent,
  BALANCE_MIN_CANDIDATES,
  NO_ARTIST_INTENT,
  fairCap,
  normalizeArtist,
  primaryArtistKey,
} from '../../../src/aiPlaylistBalance';

/** `count` candidates by `artist`. */
const songs = (artist: string, count: number) =>
  Array.from({ length: count }, () => ({ artist }));

/** `artists` different artists with `each` candidates. */
const field = (artists: number, each: number, prefix = 'Artist') =>
  Array.from({ length: artists }, (_, i) => songs(`${prefix} ${i}`, each)).flat();

const intent = (overrides: Partial<ArtistIntent>): ArtistIntent => ({
  ...NO_ARTIST_INTENT,
  ...overrides,
});

describe('normalizeArtist', () => {
  it('folds case, accents, punctuation and a leading "The"', () => {
    expect(normalizeArtist('The Beatles')).toBe('beatles');
    expect(normalizeArtist('BEATLES')).toBe('beatles');
    expect(normalizeArtist('Böhse Onkelz')).toBe('bohse onkelz');
    expect(normalizeArtist('AC/DC')).toBe('ac dc');
    expect(normalizeArtist('  Guns N\' Roses ')).toBe('guns n roses');
    expect(normalizeArtist(null)).toBe('');
  });
});

describe('primaryArtistKey', () => {
  it('counts a collaboration towards the first artist', () => {
    expect(primaryArtistKey('AFROJACK & David Guetta')).toBe('afrojack');
    expect(primaryArtistKey('2Pac, Roger & Dr. Dre')).toBe('2pac');
    expect(primaryArtistKey('Eminem feat. Rihanna')).toBe('eminem');
    expect(primaryArtistKey('Queen')).toBe('queen');
  });

  it('gives a band with a separator in its name one stable key', () => {
    expect(primaryArtistKey('Earth, Wind & Fire')).toBe(
      primaryArtistKey('Earth, Wind & Fire & The Emotions')
    );
  });
});

describe('fairCap', () => {
  it('is the smallest cap that leaves enough to choose from', () => {
    // 60 artists with 50 songs each, 113 needed: 2 each gives 120.
    expect(fairCap(Array(60).fill(50), 113)).toBe(2);
    expect(fairCap(Array(60).fill(50), 121)).toBe(3);
  });

  it('only counts what an artist really has', () => {
    // One artist with 50 songs and 63 with one: 49 + 63 = 112.
    expect(fairCap([50, ...Array(63).fill(1)], 112)).toBe(49);
  });

  it('is Infinity when the whole pool is too small to hold anything back', () => {
    expect(fairCap([50, 10], 61)).toBe(Infinity);
    expect(fairCap([], 1)).toBe(Infinity);
  });
});

describe('ArtistBalance.plan', () => {
  it('sets no cap on a pool under the threshold', () => {
    const pool = [...songs('Queen', 60), ...field(10, 2)];
    expect(pool.length).toBeLessThan(BALANCE_MIN_CANDIDATES);
    const balance = ArtistBalance.plan(pool, 25, NO_ARTIST_INTENT);
    expect(balance.limits).toBe(false);
    expect(balance.cap).toBe(Infinity);
  });

  it('gives every artist a fair share of a large pool', () => {
    const balance = ArtistBalance.plan(field(60, 50), 75, NO_ARTIST_INTENT);
    expect(balance.cap).toBe(2);
    expect(balance.plan.capIsHard).toBe(false);
    expect(balance.limits).toBe(true);
  });

  it('never drops the fair share below two', () => {
    // 400 artists with one song each would allow a cap of one.
    const balance = ArtistBalance.plan(
      [...field(400, 1), ...songs('Mariah Carey', 20)],
      75,
      NO_ARTIST_INTENT
    );
    expect(balance.cap).toBe(2);
  });

  it('sets no cap when a large pool is still too small for the playlist', () => {
    // 120 candidates for 500 tracks: everything is needed.
    const balance = ArtistBalance.plan(field(12, 10), 500, NO_ARTIST_INTENT);
    expect(balance.cap).toBe(Infinity);
  });

  it('takes a limit from the customer as it is, whatever the pool size', () => {
    const balance = ArtistBalance.plan(field(3, 2), 5, intent({ maxPerArtist: 1 }));
    expect(balance.cap).toBe(1);
    expect(balance.plan.capIsHard).toBe(true);
  });

  it('ignores a limit that makes no sense', () => {
    for (const maxPerArtist of [0, -2, 51, NaN]) {
      expect(
        ArtistBalance.plan(field(3, 2), 5, intent({ maxPerArtist })).limits
      ).toBe(false);
    }
  });

  it('does not cap the one artist the customer asked for', () => {
    const balance = ArtistBalance.plan(
      songs('Taylor Swift', 200),
      100,
      intent({ requestedArtists: ['Taylor Swift'], onlyRequested: true })
    );
    expect(balance.requestedCap).toBe(Infinity);
    expect(balance.limits).toBe(false);
  });

  it('divides a playlist of only named artists evenly among them', () => {
    const pool = [
      ...songs('Taylor Swift', 188),
      ...songs('One Direction', 100),
      ...songs('Harry Styles', 60),
      ...songs('Olivia Rodrigo', 40),
      ...songs('Bruno Mars', 80),
    ];
    const balance = ArtistBalance.plan(
      pool,
      188,
      intent({
        requestedArtists: [
          'Taylor Swift',
          'One Direction',
          'Harry Styles',
          'Olivia Rodrigo',
          'Bruno Mars',
        ],
        onlyRequested: true,
      })
    );
    // 188 * 1.15 = 217 needed: 45 each (40 for the smallest) gives 220.
    expect(balance.requestedCap).toBe(45);
    expect(balance.plan.requestedCapIsHard).toBe(false);
  });

  it('lets a named artist have more than the rest in a wider theme', () => {
    // "80s rock like Queen": fair share for the field, a quarter for Queen.
    const pool = [...songs('Queen', 50), ...field(60, 50)];
    const balance = ArtistBalance.plan(
      pool,
      100,
      intent({ requestedArtists: ['Queen'] })
    );
    expect(balance.cap).toBe(3);
    expect(balance.requestedCap).toBe(25);
  });

  it('shares half the playlist among many named artists', () => {
    const named = ['A One', 'B Two', 'C Three', 'D Four', 'E Five'];
    const pool = [...named.flatMap((n) => songs(n, 50)), ...field(60, 50)];
    const balance = ArtistBalance.plan(pool, 100, intent({ requestedArtists: named }));
    expect(balance.requestedCap).toBe(10);
  });

  it('applies the customer limit to the named artists too', () => {
    const balance = ArtistBalance.plan(
      [...songs('Queen', 50), ...field(60, 50)],
      100,
      intent({ requestedArtists: ['Queen'], maxPerArtist: 2 })
    );
    expect(balance.cap).toBe(2);
    expect(balance.requestedCap).toBe(2);
    expect(balance.plan.requestedCapIsHard).toBe(true);
  });

  it('exempts the named artists from the limit when the customer says so', () => {
    // "everyone once, only Jule X often"
    const balance = ArtistBalance.plan(
      [...songs('Jule X', 50), ...field(100, 5)],
      200,
      intent({ requestedArtists: ['Jule X'], maxPerArtist: 1, requestedExempt: true })
    );
    expect(balance.cap).toBe(1);
    expect(balance.plan.capIsHard).toBe(true);
    expect(balance.requestedCap).toBe(50);
    expect(balance.plan.requestedCapIsHard).toBe(false);
  });
});

describe('ArtistBalance counting', () => {
  const capped = (cap: number, hard = false, requested: string[] = [], requestedCap = Infinity) =>
    new ArtistBalance({
      requested,
      cap,
      capIsHard: hard,
      requestedCap,
      requestedCapIsHard: false,
    });

  it('counts per artist and refuses a song over the cap', () => {
    const balance = capped(2);
    expect(balance.take('Queen')).toBe(true);
    expect(balance.take('QUEEN')).toBe(true);
    expect(balance.hasRoom('Queen')).toBe(false);
    expect(balance.take('Queen')).toBe(false);
    expect(balance.countOf('Queen')).toBe(2);
    expect(balance.take('ABBA')).toBe(true);
  });

  it('counts a collaboration towards its first artist', () => {
    const balance = capped(1);
    expect(balance.take('AFROJACK & David Guetta')).toBe(true);
    expect(balance.take('AFROJACK')).toBe(false);
    expect(balance.take('David Guetta')).toBe(true);
  });

  it('counts a guest appearance towards the named artist', () => {
    const balance = capped(1, false, ['david guetta'], 2);
    expect(balance.keyOf('AFROJACK & David Guetta')).toBe('david guetta');
    expect(balance.take('AFROJACK & David Guetta')).toBe(true);
    expect(balance.take('David Guetta')).toBe(true);
    expect(balance.take('David Guetta, Sia')).toBe(false);
    // Whole words only: another band is not Queen.
    expect(capped(1, false, ['queen']).keyOf('Queensrÿche')).toBe('queensryche');
  });

  it('never refuses a song without an artist', () => {
    const balance = capped(1);
    expect(balance.take('')).toBe(true);
    expect(balance.take(null)).toBe(true);
    expect(balance.hasRoom(undefined)).toBe(true);
  });

  it('lift() removes a fair share but not a limit the customer set', () => {
    const soft = capped(1);
    soft.take('Queen');
    expect(soft.isSoftCapped('Queen')).toBe(true);
    soft.lift();
    expect(soft.cap).toBe(Infinity);
    expect(soft.take('Queen')).toBe(true);

    const hard = capped(1, true);
    hard.take('Queen');
    expect(hard.isSoftCapped('Queen')).toBe(false);
    hard.lift();
    expect(hard.cap).toBe(1);
    expect(hard.take('Queen')).toBe(false);
  });
});
