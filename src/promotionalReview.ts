import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import Cache from './cache';
import Logger from './logger';
import PushoverClient from './pushover';
import Promotional from './promotional';
import Data from './data';
import { llm, LlmOutputError } from './llm';
import { SITE_LOCALES } from './data/shared/shared-data.generated';
import { normalizeFeaturedLocale } from './data/featuredLocale';
import FeaturedLinkCheck from './linkCheck';
import { sanitizeBrandName } from './brandName';

/**
 * The automatic review of a playlist a customer submits for the catalogue
 * (the promotional setup page): approve, decline, or leave it for the admin,
 * and the languages it is for. See CLAUDE.md, "Automatic review of submitted
 * playlists".
 *
 * Rick approved 649 of 668 submissions by hand (until 2026-11-20) and declined
 * when the playlist was gone from its service by the time he looked. So the
 * model approves the normal case and leaves doubt to the admin; a decline is
 * done only when the service says the playlist is gone (asked of the service,
 * not the model). A decline the model proposes on content waits for the admin.
 *
 * Everything above `PromotionalReview` is pure.
 */

export type ReviewVerdict = 'approve' | 'decline' | 'review';

export interface ReviewTrack {
  artist: string;
  name: string;
  year: number | null;
}

export interface ReviewInput {
  title: string;
  description: string;
  /** The site language the customer submitted in (`promotionalLocale`). */
  siteLanguage: string | null;
  trackCount: number;
  tracks: ReviewTrack[];
}

export interface ReviewAnswer {
  verdict: ReviewVerdict;
  reason: string;
  /** Site languages the songs are for, main one first; empty: for everyone. */
  languages: string[];
}

export interface ReviewDecision {
  /** What happens to the submission. */
  action: 'accept' | 'decline' | 'leave';
  verdict: ReviewVerdict;
  reason: string;
  /** The featuredLocale it gets, null for everyone. */
  featuredLocale: string | null;
}

/** Below this many songs nothing is approved without the admin. */
export const MIN_TRACKS_AUTO_APPROVE = 20;
/** Songs the model sees, spread over the list. */
export const MAX_SAMPLE_TRACKS = 150;
/** Submissions the sweep reviews per run. */
export const SWEEP_BATCH = 5;
/** A submission is left this long before the sweep takes it (the customer may still be editing). */
export const SWEEP_MIN_AGE_MINUTES = 5;

/**
 * `PROMOTIONAL_AUTO_REVIEW`: apply, suggest (store, change nothing else), off.
 * Unset: apply in production, off anywhere else (the crons also run in
 * development, where approving would mail customers from the dev database).
 */
export type ReviewMode = 'apply' | 'suggest' | 'off';
export function reviewMode(value: string | undefined, environment: string | undefined): ReviewMode {
  const v = (value || '').trim().toLowerCase();
  if (v === 'apply' || v === 'suggest' || v === 'off') return v;
  return environment === 'production' ? 'apply' : 'off';
}

/** The site's languages a playlist can be tagged with: two letters, never `en` (English music is international). */
export function taggableLocales(): string[] {
  return SITE_LOCALES.map((l) => l.code).filter((c) => /^[a-z]{2}$/.test(c) && c !== 'en');
}

/** At most `max` songs, spread evenly over the list so a long one is seen from start to end. */
export function sampleTracks<T>(tracks: T[], max: number = MAX_SAMPLE_TRACKS): T[] {
  if (tracks.length <= max) return tracks;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(tracks[Math.floor((i * tracks.length) / max)]);
  return out;
}

/**
 * The featuredLocale for the languages the model found. Only taggable codes,
 * each once, the main one first. A list for one language also gets the
 * language the customer submitted in when that is another site language: the
 * customer buys there, and so do the people like them (Russian songs bought on
 * the German site: "ru,de", 2026-11-20). An international list stays null.
 */
export function reviewLocales(
  languages: string[],
  siteLanguage: string | null,
  taggable: string[] = taggableLocales()
): string | null {
  const codes = [...new Set(languages.map((l) => String(l).trim().toLowerCase()))].filter((l) =>
    taggable.includes(l)
  );
  if (codes.length === 0) return null;
  const site = String(siteLanguage || '').trim().toLowerCase();
  if (taggable.includes(site) && !codes.includes(site)) codes.push(site);
  return normalizeFeaturedLocale(codes);
}

/**
 * What to do with a submission. A playlist gone from its service is declined
 * (what Rick did by hand). A short list is never approved without the admin.
 * Otherwise the model's verdict.
 */
export function decideReview(
  answer: ReviewAnswer,
  facts: { trackCount: number; gone: boolean; goneReason?: string; siteLanguage: string | null },
  taggable: string[] = taggableLocales()
): ReviewDecision {
  const featuredLocale = reviewLocales(answer.languages, facts.siteLanguage, taggable);
  if (facts.gone) {
    return {
      action: 'decline',
      verdict: 'decline',
      reason: `The playlist is no longer available at its service (${facts.goneReason || 'gone'}).`,
      featuredLocale,
    };
  }
  if (answer.verdict === 'decline') {
    // Shown to the admin as a decline, never done on the model's word: in the
    // calibration of 2026-11-20 it declined a list Rick had approved while
    // calling it borderline itself, and a wrong decline turns a customer down.
    return { action: 'leave', verdict: 'decline', reason: answer.reason, featuredLocale };
  }
  if (answer.verdict === 'approve' && facts.trackCount < MIN_TRACKS_AUTO_APPROVE) {
    return {
      action: 'leave',
      verdict: 'review',
      reason: `Only ${facts.trackCount} songs (fewer than ${MIN_TRACKS_AUTO_APPROVE}). ${answer.reason}`.trim(),
      featuredLocale,
    };
  }
  if (answer.verdict === 'approve') {
    return { action: 'accept', verdict: 'approve', reason: answer.reason, featuredLocale };
  }
  return { action: 'leave', verdict: 'review', reason: answer.reason, featuredLocale };
}

/** The model's answer made safe: a known verdict, a reason, languages as strings. */
export function parseAnswer(raw: any): ReviewAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const verdict = raw.verdict;
  if (verdict !== 'approve' && verdict !== 'decline' && verdict !== 'review') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 500) : '';
  const languages = Array.isArray(raw.languages)
    ? raw.languages.filter((l: unknown) => typeof l === 'string')
    : [];
  return { verdict, reason, languages };
}

export function reviewSystemPrompt(taggable: string[] = taggableLocales()): string {
  return (
    'You review a playlist a customer of QRSong! submitted for our public catalogue. QRSong! prints a playlist as ' +
    'music quiz cards: each card is a song, players scan it, listen and guess the year. Other customers can buy a ' +
    'catalogue playlist as their own cards, and it gets a public product page under the title the customer gave it.\n\n' +
    'verdict:\n' +
    '  • approve: the normal answer. About 97% of submissions are approved. Any coherent playlist other people could ' +
    'enjoy playing qualifies: a genre, an era, a country\'s music, a theme, an occasion (birthday, wedding, baby ' +
    'shower, Christmas), a broad mix of hits, a niche. A title that names the people it was made for is fine.\n' +
    '  • decline: only for a clear reason: the title, description or songs are hateful, sexually explicit, extremist ' +
    'or insulting to someone; the title or description is advertising or spam (links, shops, promo codes, contact ' +
    'details); or the list is mostly not music to play (podcasts, audiobooks, sound effects, white noise, comedy).\n' +
    '  • review: only for real doubt: the title cannot stand as a public product name (gibberish, only a URL, only a ' +
    'first name with nothing about the music), or most of the songs do not fit the title. A generic, playful or ' +
    'misspelled title is fine ("Pop-Mix", "Cooler Mix", "De lijst voor allemaal", "BlasTer"), and so are some songs ' +
    'that do not fit the theme and a few explicit song titles by known artists.\n' +
    'Title and description are shown as they will be published (a competing game\'s name already replaced by ' +
    'QRSong!).\n\n' +
    'reason: one short sentence in English for the admin.\n\n' +
    'languages: the languages this playlist is specifically for, judged from its songs only (never from the language ' +
    'of the title or description, or the site it was submitted on: a tag hides the list from other countries):\n' +
    '  • An empty list when it is for everyone: international hits, English-language music, a mix of several countries.\n' +
    '  • A code when most of the songs (roughly 40% or more) are in that language or from that country\'s own scene: ' +
    'German Schlager or Austropop → de, Dutch hits → nl, Turkish pop → tr, Russian songs → ru, Chilean artists → es, ' +
    'Québec chansons → fr. The main one first; a second only when a clear share of the songs is in it too.\n' +
    `  • Codes: ${taggable.join(', ')} (jp = Japanese, cn = Chinese, no = Norwegian, da = Danish, cs = Czech). Never "en". ` +
    'Music in a language without a code here (Serbo-Croatian, Arabic, Hindi, …) gets no tag; never pick a near one.'
  );
}

export function reviewUserMessage(input: ReviewInput): string {
  const sample = sampleTracks(input.tracks);
  const lines = sample.map((t) => `${t.artist} – ${t.name}${t.year ? ` (${t.year})` : ''}`);
  return (
    `Title: ${sanitizeBrandName(input.title)}\n` +
    `Description: ${sanitizeBrandName(input.description) || '(none)'}\n` +
    `Submitted on the site in: ${input.siteLanguage || 'unknown'}\n` +
    `Songs: ${input.trackCount}${sample.length < input.tracks.length ? ` (${sample.length} shown, spread over the list)` : ''}\n\n` +
    lines.join('\n')
  );
}

/** One line for the Pushover and the log. */
export function reviewNotice(title: string, trackCount: number, decision: ReviewDecision, mode: ReviewMode) {
  const what =
    mode === 'suggest'
      ? `would ${decision.action === 'accept' ? 'approve' : decision.action === 'decline' ? 'decline' : 'leave for you'}`
      : decision.action === 'accept'
        ? 'approved'
        : decision.action === 'decline'
          ? 'declined'
          : 'needs you';
  return {
    title: `Submitted playlist ${what}`,
    message: `${title} (${trackCount} songs, ${decision.featuredLocale ?? 'for everyone'}): ${decision.reason}`,
  };
}

/* ----------------------------------------------------------------------- */

/** The playlist's songs in list order (also scripts/promotional-review.ts). */
export async function loadTracks(prisma: any, playlistDbId: number): Promise<ReviewTrack[]> {
  const rows: Array<{ artist: string; name: string; year: number | null }> = await prisma.$queryRaw`
    SELECT t.artist, t.name, t.year
    FROM playlist_has_tracks pht JOIN tracks t ON t.id = pht.trackId
    WHERE pht.playlistId = ${playlistDbId}
    ORDER BY pht.\`order\`, t.id`;
  return rows.map((t) => ({
    artist: String(t.artist ?? ''),
    name: String(t.name ?? ''),
    year: t.year ? Number(t.year) : null,
  }));
}

export interface ReviewDeps {
  prisma: any;
  cache: { acquireLock(key: string, ttl?: number): Promise<boolean>; releaseLock(key: string): Promise<void> };
  logger: { log(message: string): void };
  ask(input: ReviewInput): Promise<ReviewAnswer | null>;
  probe(target: { playlistId: string; serviceType: string; featuredLocale: string | null }): Promise<{
    verdict: 'available' | 'gone' | 'unknown';
    reason: string;
    needsControl?: boolean;
  }>;
  accept(playlistId: string): Promise<{ success: boolean; error?: string }>;
  decline(playlistId: string): Promise<{ success: boolean; error?: string }>;
  notify(notice: { title: string; message: string }): Promise<void>;
  mode(): ReviewMode;
}

export interface ReviewOutcome extends ReviewDecision {
  playlistId: string;
  title: string;
  trackCount: number;
  /** What was done: the action, or why nothing was. */
  done: 'accepted' | 'declined' | 'left' | 'suggested' | 'skipped';
  skippedBecause?: string;
}

const LOCK_PREFIX = 'promotionalReview:';

export class PromotionalReview {
  private static instance: PromotionalReview;

  constructor(private deps: ReviewDeps) {}

  public static getInstance(): PromotionalReview {
    if (!PromotionalReview.instance) {
      const pushover = new PushoverClient();
      PromotionalReview.instance = new PromotionalReview({
        prisma: PrismaInstance.getInstance(),
        cache: Cache.getInstance(),
        logger: new Logger(),
        ask: askModel,
        probe: (target) => FeaturedLinkCheck.getInstance().probeOne(target),
        accept: (playlistId) => Promotional.getInstance().acceptPromotionalPlaylist(playlistId),
        decline: (playlistId) => Data.getInstance().declinePromotionalPlaylist(playlistId),
        notify: (notice) => pushover.sendMessage(notice, '', true),
        mode: () => reviewMode(process.env['PROMOTIONAL_AUTO_REVIEW'], process.env['ENVIRONMENT']),
      });
    }
    return PromotionalReview.instance;
  }

  /** Reviews in the background; the customer's save does not wait. */
  public queue(playlistId: string): void {
    if (this.deps.mode() === 'off') return;
    this.review(playlistId).catch((error) =>
      this.deps.logger.log(color.red.bold(`Review of submission ${white.bold(playlistId)} failed: ${error?.message || error}`))
    );
  }

  /**
   * Reviews one submission and acts on it. Only a submission still waiting
   * (active, not approved, not declined) that was never reviewed; `force`
   * reviews one that was. Null when there was nothing to review.
   */
  public async review(playlistId: string, options: { force?: boolean } = {}): Promise<ReviewOutcome | null> {
    const mode = this.deps.mode();
    if (mode === 'off') return null;
    const lock = `${LOCK_PREFIX}${playlistId}`;
    if (!(await this.deps.cache.acquireLock(lock, 600))) return null;
    try {
      const row = await this.deps.prisma.playlist.findUnique({
        where: { playlistId },
        select: {
          id: true,
          playlistId: true,
          serviceType: true,
          name: true,
          promotionalTitle: true,
          promotionalDescription: true,
          promotionalLocale: true,
          promotionalActive: true,
          promotionalAccepted: true,
          promotionalHide: true,
          promotionalReviewedAt: true,
          featuredLocale: true,
        },
      });
      if (!row || !row.promotionalActive || row.promotionalAccepted || row.promotionalHide) return null;
      if (row.promotionalReviewedAt && !options.force) return null;

      const tracks = await loadTracks(this.deps.prisma, row.id);
      const title = row.promotionalTitle || row.name;
      const input: ReviewInput = {
        title,
        description: row.promotionalDescription || '',
        siteLanguage: row.promotionalLocale,
        trackCount: tracks.length,
        tracks,
      };

      const probe = await this.deps
        .probe({ playlistId: row.playlistId, serviceType: row.serviceType || 'spotify', featuredLocale: null })
        .catch(() => null);
      const gone = !!probe && probe.verdict === 'gone' && !probe.needsControl;

      const answer = gone ? { verdict: 'decline' as const, reason: '', languages: [] } : await this.deps.ask(input);
      const base = { playlistId, title, trackCount: tracks.length };
      if (!answer) {
        // No usable answer (an outage throws instead, and the sweep tries
        // again): the admin decides. Stored as a review so the sweep, which
        // only takes submissions never reviewed, does not ask again.
        const reason = 'The model gave no usable answer.';
        await this.deps.prisma.playlist.update({
          where: { playlistId },
          data: { promotionalReviewVerdict: 'review', promotionalReviewReason: reason, promotionalReviewedAt: new Date() },
        });
        this.deps.logger.log(color.yellow.bold(`Review of ${white.bold(title)}: no answer from the model, left for the admin`));
        const skipped: ReviewOutcome = { ...base, action: 'leave', verdict: 'review', reason, featuredLocale: row.featuredLocale, done: 'skipped', skippedBecause: 'model' };
        await this.deps.notify(reviewNotice(title, tracks.length, skipped, mode)).catch(() => undefined);
        return skipped;
      }

      const decision = decideReview(answer, {
        trackCount: tracks.length,
        gone,
        goneReason: probe?.reason,
        siteLanguage: row.promotionalLocale,
      });

      const reviewData: Record<string, any> = {
        promotionalReviewVerdict: decision.verdict,
        promotionalReviewReason: decision.reason,
        promotionalReviewedAt: new Date(),
      };
      // The languages go on now: the admin's edit form shows them, and an
      // approval keeps them. A waiting submission is not public, so nothing
      // else reads them yet. In suggest mode too: only the admin sees them.
      reviewData.featuredLocale = decision.featuredLocale;
      await this.deps.prisma.playlist.update({ where: { playlistId }, data: reviewData });

      let done: ReviewOutcome['done'] = mode === 'suggest' ? 'suggested' : 'left';
      if (mode === 'apply' && decision.action === 'accept') {
        const result = await this.deps.accept(playlistId);
        if (!result.success) throw new Error(`approval failed: ${result.error}`);
        done = 'accepted';
      } else if (mode === 'apply' && decision.action === 'decline') {
        const result = await this.deps.decline(playlistId);
        if (!result.success) throw new Error(`decline failed: ${result.error}`);
        done = 'declined';
      }

      const notice = reviewNotice(title, tracks.length, decision, mode);
      this.deps.logger.log(color.blue.bold(`${notice.title}: ${white.bold(notice.message)}`));
      await this.deps.notify(notice).catch(() => {});
      return { ...base, ...decision, done };
    } finally {
      await this.deps.cache.releaseLock(lock).catch(() => {});
    }
  }

  /**
   * The submissions the save's own review missed (a restart, a failed call):
   * waiting, never reviewed, saved at least a few minutes ago. A few per run,
   * oldest first.
   */
  public async sweep(): Promise<ReviewOutcome[]> {
    if (this.deps.mode() === 'off') return [];
    const before = new Date(Date.now() - SWEEP_MIN_AGE_MINUTES * 60_000);
    const waiting: Array<{ playlistId: string }> = await this.deps.prisma.playlist.findMany({
      where: {
        promotionalActive: true,
        promotionalAccepted: false,
        promotionalHide: false,
        promotionalReviewedAt: null,
        updatedAt: { lt: before },
      },
      select: { playlistId: true },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_BATCH,
    });
    const outcomes: ReviewOutcome[] = [];
    for (const { playlistId } of waiting) {
      try {
        const outcome = await this.review(playlistId);
        if (outcome) outcomes.push(outcome);
      } catch (error: any) {
        this.deps.logger.log(color.red.bold(`Review of submission ${white.bold(playlistId)} failed: ${error?.message || error}`));
      }
    }
    return outcomes;
  }
}

/** The model's verdict, or null when no usable answer came (the admin decides then). */
export async function askModel(input: ReviewInput): Promise<ReviewAnswer | null> {
  const taggable = taggableLocales();
  try {
    const result = await llm.json<any>('promotionalReview', {
      system: reviewSystemPrompt(taggable),
      messages: [{ role: 'user', content: reviewUserMessage(input) }],
      schema: {
        name: 'reviewSubmission',
        schema: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['approve', 'decline', 'review'] },
            reason: { type: 'string' },
            languages: { type: 'array', items: { type: 'string', enum: taggable } },
          },
          required: ['verdict', 'reason', 'languages'],
        },
      },
    });
    return parseAnswer(result.data);
  } catch (error) {
    if (error instanceof LlmOutputError) return null;
    throw error;
  }
}

export default PromotionalReview;
