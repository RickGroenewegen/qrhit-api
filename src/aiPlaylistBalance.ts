/**
 * How the AI playlist generator divides a playlist over artists
 * (`ArtistBalance`) and over release years (`YearSpread`, at the end).
 *
 * Without this, a broad theme ends up dominated by whoever has the most songs
 * in the catalogue: "klassik" gave 13 Beethoven pieces out of 75, and a
 * customer who wrote "at most two songs per band" got 19 of one. The keyword
 * search returns up to 50 random songs per artist, and the curation LLM sees
 * them spread over many batches, so nothing ever counted per artist.
 *
 * Three rules, in this order:
 *   1. A limit the customer states ("one song per band") is hard: never
 *      exceeded, the playlist comes out shorter instead.
 *   2. Artists the customer names are what they asked for, so they are not
 *      held to the share everyone else gets (see `ArtistBalance.plan`).
 *   3. Everyone else gets a fair share, but only when there is enough to
 *      choose from (`BALANCE_MIN_CANDIDATES`). That cap is soft: when the
 *      playlist comes up short it is lifted.
 */

/** Below this many candidates there is nothing to be picky about. */
export const BALANCE_MIN_CANDIDATES = 90;
/** A fair share never drops below this: two songs of one artist is not too many. */
const FAIR_SHARE_FLOOR = 2;
/**
 * The curation LLM rejects part of what it sees, so the capped pool has to
 * stay this much larger than the playlist.
 */
const POOL_SLACK = 1.5;
/** Songs by a named artist nearly all fit the theme, so less slack is needed. */
const REQUESTED_POOL_SLACK = 1.15;
/**
 * In a mixed theme ("80s rock like Queen") a named artist may fill up to this
 * part of the playlist, and all named artists together half of it.
 */
const REQUESTED_MAX_SHARE = 0.25;
const REQUESTED_TOTAL_SHARE = 0.5;
const MAX_USER_LIMIT = 50;

export interface ArtistIntent {
  /** Artists the customer named in the theme. */
  requestedArtists: string[];
  /** The playlist should hold the named artists and nothing else. */
  onlyRequested: boolean;
  /** "At most N songs per artist", when the customer says so. */
  maxPerArtist: number | null;
  /** The customer said the named artists may go over that limit. */
  requestedExempt: boolean;
}

export const NO_ARTIST_INTENT: ArtistIntent = {
  requestedArtists: [],
  onlyRequested: false,
  maxPerArtist: null,
  requestedExempt: false,
};

export interface BalancePlan {
  /** Normalised names of the artists the customer asked for. */
  requested: string[];
  /** Songs per artist for everyone else; Infinity means no cap. */
  cap: number;
  /** True when the customer set `cap`; a hard cap is never lifted. */
  capIsHard: boolean;
  /** Songs per named artist; Infinity means no cap. */
  requestedCap: number;
  requestedCapIsHard: boolean;
}

/**
 * Lowercase, accents folded, punctuation to spaces, leading "the" dropped,
 * so "The Beatles", "Beatles" and "BEATLES" agree.
 */
export function normalizeArtist(value: string | null | undefined): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}

/**
 * The artist a song counts towards. The catalogue writes collaborations as
 * "A, B & C", so everything after the first separator is a guest. A band with
 * a separator in its name ("Earth, Wind & Fire") still gets one stable key.
 */
export function primaryArtistKey(artist: string | null | undefined): string {
  const first = String(artist || '').split(
    /\s*,\s*|\s+&\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i
  )[0];
  return normalizeArtist(first) || normalizeArtist(artist);
}

/** Whether `artist` (as stored on a track) names the requested artist as whole words. */
function namesArtist(artist: string, requested: string): boolean {
  return ` ${artist} `.includes(` ${requested} `);
}

/**
 * The smallest per-artist cap that still leaves `needed` songs to choose
 * from, given how many songs each artist has in the pool. Infinity when the
 * whole pool is smaller than that: nothing can be held back then.
 */
export function fairCap(counts: number[], needed: number): number {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total < needed) return Infinity;
  const highest = counts.reduce((max, n) => Math.max(max, n), 0);
  for (let cap = 1; cap < highest; cap++) {
    const available = counts.reduce((sum, n) => sum + Math.min(n, cap), 0);
    if (available >= needed) return cap;
  }
  return highest;
}

function userLimit(intent: ArtistIntent): number | null {
  const n = intent.maxPerArtist;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const limit = Math.floor(n);
  return limit >= 1 && limit <= MAX_USER_LIMIT ? limit : null;
}

export class ArtistBalance {
  private counts = new Map<string, number>();
  private keys = new Map<string, string>();
  private lifted = false;

  constructor(public readonly plan: BalancePlan) {}

  /**
   * Work out the caps for one run from the candidate pool, the size of the
   * playlist and what the customer asked for.
   */
  static plan(
    candidates: { artist: string }[],
    target: number,
    intent: ArtistIntent
  ): ArtistBalance {
    const requested = Array.from(
      new Set(intent.requestedArtists.map(normalizeArtist).filter(Boolean))
    );
    const balance = new ArtistBalance({
      requested,
      cap: Infinity,
      capIsHard: false,
      requestedCap: Infinity,
      requestedCapIsHard: false,
    });

    const pool = new Map<string, number>();
    for (const c of candidates) {
      const key = balance.keyOf(c.artist);
      if (key) pool.set(key, (pool.get(key) || 0) + 1);
    }
    const isRequested = new Set(requested);
    const requestedCounts: number[] = [];
    const otherCounts: number[] = [];
    for (const [key, count] of pool) {
      (isRequested.has(key) ? requestedCounts : otherCounts).push(count);
    }

    const plan = balance.plan;
    const limit = userLimit(intent);
    const enoughToChoose = candidates.length >= BALANCE_MIN_CANDIDATES;

    if (limit !== null) {
      plan.cap = limit;
      plan.capIsHard = true;
    } else if (enoughToChoose) {
      const fair = fairCap(otherCounts, target * POOL_SLACK);
      plan.cap = Number.isFinite(fair) ? Math.max(FAIR_SHARE_FLOOR, fair) : Infinity;
    }

    if (requested.length > 0) {
      if (limit !== null && !intent.requestedExempt) {
        plan.requestedCap = limit;
        plan.requestedCapIsHard = true;
      } else if (!enoughToChoose) {
        plan.requestedCap = Infinity;
      } else if (intent.onlyRequested) {
        // Only the named artists: divide the playlist evenly among them.
        plan.requestedCap =
          requested.length === 1
            ? Infinity
            : fairCap(requestedCounts, target * REQUESTED_POOL_SLACK);
      } else {
        const share = Math.min(
          REQUESTED_MAX_SHARE,
          REQUESTED_TOTAL_SHARE / requested.length
        );
        plan.requestedCap = Math.max(
          Math.ceil(target * share),
          Number.isFinite(plan.cap) ? plan.cap : 0
        );
      }
    }

    return balance;
  }

  /** The artist this song counts towards: a named artist when it is one of theirs. */
  keyOf(artist: string | null | undefined): string {
    const raw = String(artist || '');
    const known = this.keys.get(raw);
    if (known !== undefined) return known;
    const full = normalizeArtist(raw);
    const key =
      this.plan.requested.find((r) => namesArtist(full, r)) ||
      primaryArtistKey(raw);
    this.keys.set(raw, key);
    return key;
  }

  private isRequested(key: string): boolean {
    return this.plan.requested.includes(key);
  }

  /** Songs per artist as it stands: the planned cap, or none once it is lifted. */
  get cap(): number {
    return this.lifted && !this.plan.capIsHard ? Infinity : this.plan.cap;
  }

  /** The same for an artist the customer named. */
  get requestedCap(): number {
    return this.lifted && !this.plan.requestedCapIsHard
      ? Infinity
      : this.plan.requestedCap;
  }

  private capOf(key: string): number {
    return this.isRequested(key) ? this.requestedCap : this.cap;
  }

  countOf(artist: string | null | undefined): number {
    return this.counts.get(this.keyOf(artist)) || 0;
  }

  hasRoom(artist: string | null | undefined): boolean {
    const key = this.keyOf(artist);
    // A song without an artist cannot over-represent anyone.
    if (!key) return true;
    return (this.counts.get(key) || 0) < this.capOf(key);
  }

  /** Count a song for its artist; false (and nothing counted) when the artist is full. */
  take(artist: string | null | undefined): boolean {
    if (!this.hasRoom(artist)) return false;
    const key = this.keyOf(artist);
    if (key) this.counts.set(key, (this.counts.get(key) || 0) + 1);
    return true;
  }

  /** Whether the cap that holds this artist back is one `lift()` removes. */
  isSoftCapped(artist: string | null | undefined): boolean {
    const key = this.keyOf(artist);
    return !(this.isRequested(key)
      ? this.plan.requestedCapIsHard
      : this.plan.capIsHard);
  }

  /**
   * Drop the fair-share caps because the playlist came up short. A limit the
   * customer set stays.
   */
  lift(): void {
    this.lifted = true;
  }

  /** True when some artist can actually be held back. */
  get limits(): boolean {
    return (
      Number.isFinite(this.plan.cap) ||
      (this.plan.requested.length > 0 && Number.isFinite(this.plan.requestedCap))
    );
  }
}

/**
 * How many songs one release year may get.
 *
 * The cards are played by guessing when a song came out and putting it in
 * order on a timeline. A deck with twelve songs from 1985 is a worse game
 * than one that runs through the years, and left alone the picks bunch up
 * where the catalogue is thickest.
 *
 * The same fair share as for artists, per year: the smallest cap that still
 * leaves enough to choose from. It follows whatever years the theme has. A
 * theme of one decade is spread over its ten years, a theme without a period
 * over every year there are songs for, and a theme of a single year is left
 * alone because there is nothing to spread. Always soft: it is lifted when
 * the playlist comes up short. A song without a known year is never held
 * back.
 */
export class YearSpread {
  private counts = new Map<number, number>();
  private lifted = false;

  constructor(private readonly plannedCap: number) {}

  static plan(
    candidates: { year?: number | null }[],
    target: number
  ): YearSpread {
    if (candidates.length < BALANCE_MIN_CANDIDATES) return new YearSpread(Infinity);
    const perYear = new Map<number, number>();
    for (const c of candidates) {
      const year = YearSpread.known(c.year);
      if (year !== null) perYear.set(year, (perYear.get(year) || 0) + 1);
    }
    return new YearSpread(fairCap(Array.from(perYear.values()), target * POOL_SLACK));
  }

  private static known(year: number | null | undefined): number | null {
    const n = Number(year);
    return year !== null && year !== undefined && Number.isInteger(n) && n > 0 ? n : null;
  }

  /** Songs per year as it stands: the planned cap, or none once it is lifted. */
  get cap(): number {
    return this.lifted ? Infinity : this.plannedCap;
  }

  /** True when a year can actually be held back. */
  get limits(): boolean {
    return Number.isFinite(this.plannedCap);
  }

  countOf(year: number | null | undefined): number {
    const known = YearSpread.known(year);
    return known === null ? 0 : this.counts.get(known) || 0;
  }

  hasRoom(year: number | null | undefined): boolean {
    return this.countOf(year) < this.cap;
  }

  /** Count a song for its year; false (and nothing counted) when the year is full. */
  take(year: number | null | undefined): boolean {
    if (!this.hasRoom(year)) return false;
    const known = YearSpread.known(year);
    if (known !== null) this.counts.set(known, (this.counts.get(known) || 0) + 1);
    return true;
  }

  /** Drop the cap because the playlist came up short. */
  lift(): void {
    this.lifted = true;
  }
}
