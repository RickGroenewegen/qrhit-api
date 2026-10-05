import OpenAI from 'openai';
import { Prisma } from '@prisma/client';
import { color, white } from 'console-log-colors';
import { CronJob } from 'cron';
import cluster from 'cluster';
import Logger from './logger';
import PrismaInstance from './prisma';
import Spotify from './spotify';
import Cache from './cache';
import Utils from './utils';
import ProgressWebSocketServer from './progress-websocket';
import { CostTracker } from './aiPricing';
import { LLM_MODEL_FAST } from './llmModels';
import {
  ArtistBalance,
  ArtistIntent,
  NO_ARTIST_INTENT,
  YearSpread,
} from './aiPlaylistBalance';

// Redis cache key prefix for AI-prompt → spotifyPlaylistId lookup.
// Lives only between AI playlist creation and the eventual PaymentHasPlaylist
// row being written; gets deleted in mollie.ts once persisted.
export const AI_PLAYLIST_PROMPT_KEY = 'aiPlaylistPrompt';
// Generous TTL so a user can sit on the summary page for a while before
// paying without losing their prompt; mollie.ts also deletes proactively.
const AI_PLAYLIST_PROMPT_TTL_SECONDS = 7 * 24 * 3600;

export const aiPlaylistPromptKey = (spotifyPlaylistId: string) =>
  `${AI_PLAYLIST_PROMPT_KEY}:${spotifyPlaylistId}`;

// Snapshot of the in-flight progress for a given job, persisted to Redis
// so a page reload during generation can replay current state instead of
// starting from an empty UI. Cleared after success/error completion via
// the same mechanism (status: complete|error is the terminal value).
export const AI_PLAYLIST_PROGRESS_KEY = 'aiPlaylistProgress';
const AI_PLAYLIST_PROGRESS_TTL_SECONDS = 30 * 60; // 30 min

export const aiPlaylistProgressKey = (jobId: string) =>
  `${AI_PLAYLIST_PROGRESS_KEY}:${jobId}`;

// What a job was asked (prompt and locale), written by the route before it
// answers. The progress page's featured-playlist suggestions read it, so
// they do not depend on how far the background run has come.
export const AI_PLAYLIST_JOB_KEY = 'aiPlaylistJob';

export const aiPlaylistJobKey = (jobId: string) =>
  `${AI_PLAYLIST_JOB_KEY}:${jobId}`;

export interface AIPlaylistSnapshot {
  jobId: string;
  status: 'running' | 'success' | 'error';
  stage?: string;
  percentage: number;
  message?: string;
  messageKey?: string;
  messageParams?: Record<string, string | number | null | undefined>;
  current?: number;
  total?: number;
  // Cumulative list of keywords that returned ≥1 candidate.
  keywords: string[];
  activeWord?: string | null;
  startYear?: number | null;
  endYear?: number | null;
  requestedCount?: number;
  deliveredCount?: number;
  spotifyPlaylistId?: string;
  spotifyPlaylistUrl?: string;
  error?: string;
  updatedAt: number;
}

const SERVICE_TYPE = 'ai';
// Luna with reasoning off, measured 2026-09-17 on a 100-candidate batch:
// terra + 'low' took 26s for keywords and 6.5s per curation batch, luna +
// 'none' 10s and 1.5s, with the same picks. Curation batches run one after
// another, so the per-call time is multiplied.
const MODEL = LLM_MODEL_FAST;
const REASONING_EFFORT = 'none' as const;
const KEYWORD_LIMIT = 100;
const PER_KEYWORD_LIMIT = 50;
// An artist the customer asked for by name is searched this deep at most, so
// a playlist of one artist is not cut off at PER_KEYWORD_LIMIT songs.
const REQUESTED_ARTIST_LIMIT = 500;
const CURATION_BATCH_SIZE = 100;
// When the playlist comes up short, this many batches are tried inside the
// fair shares before they are lifted. A few, so a theme the pool cannot fill
// does not walk the whole pool twice.
const CAPPED_TOPUP_BATCHES = 3;

interface CandidateTrack {
  id: number;
  trackId: string;
  artist: string;
  name: string;
  spotifyLink: string;
  /** Release year, when the catalogue knows it. */
  year?: number | null;
}

/** Which column(s) a keyword should be matched against. */
type KeywordTarget = 'any' | 'artist' | 'title';

interface SearchKeyword {
  value: string;
  target: KeywordTarget;
  /**
   * Set for an artist the customer named: how many songs to fetch instead of
   * PER_KEYWORD_LIMIT, with that artist's own songs ahead of lookalike names.
   */
  limit?: number;
}

interface AIPlaylistJobData {
  jobId: string;
  prompt: string;
  trackCount: number;
  /** User UI locale (e.g. 'en', 'nl', 'es'). Hints the LLM about which
   *  national/language catalog to bias toward when the prompt is silent
   *  about country/language. */
  locale: string;
}

class AIPlaylistGenerator {
  private static instance: AIPlaylistGenerator;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private spotify = Spotify.getInstance();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private openai = new OpenAI({ apiKey: process.env['OPENAI_TOKEN'] });
  /** In-flight snapshots keyed by jobId so `broadcastProgress` can co-write. */
  private snapshots: Map<string, AIPlaylistSnapshot> = new Map();
  private cleanupJob: CronJob | null = null;

  private constructor() {}

  public static getInstance(): AIPlaylistGenerator {
    if (!AIPlaylistGenerator.instance) {
      AIPlaylistGenerator.instance = new AIPlaylistGenerator();
      AIPlaylistGenerator.instance.scheduleCleanup();
    }
    return AIPlaylistGenerator.instance;
  }

  /**
   * Schedule a daily sweep that removes AI-generated Spotify playlists
   * older than three days which were never purchased (no paid, non-test
   * payment attached). Only the cluster primary on the main server (or
   * dev) runs the cron so we don't multi-fire across workers/servers.
   */
  private scheduleCleanup(): void {
    if (!cluster.isPrimary) return;
    // Run at 03:30 UTC daily. Wrap the env check in a fire-and-forget
    // promise so the constructor stays sync.
    this.utils
      .isMainServer()
      .then((isMain) => {
        const dev = process.env['ENVIRONMENT'] === 'development';
        if (!isMain && !dev) return;
        this.cleanupJob = new CronJob('30 3 * * *', async () => {
          try {
            await this.cleanupUnpurchasedPlaylists();
          } catch (err) {
            this.logger.log(
              color.red.bold(`[AI cleanup] crashed: ${err}`)
            );
          }
        });
        this.cleanupJob.start();
        this.logger.log(
          color.blue.bold(
            '[AI cleanup] cron scheduled — daily at 03:30 UTC'
          )
        );
      })
      .catch(() => {});
  }

  /**
   * Find AI playlists that:
   *   • are at least 3 days old,
   *   • completed successfully (status='success'),
   *   • have a Spotify playlist ID we still know about,
   *   • were never purchased — no `playlists` row with the same Spotify id
   *     has a paid, non-test payment attached (same definition the admin
   *     AI-creations dashboard uses for its "Purchased" column).
   * Delete each from the app-owned Spotify account and mark the
   * AISearch row so we don't try again.
   */
  public async cleanupUnpurchasedPlaylists(): Promise<{
    scanned: number;
    deleted: number;
    skipped: number;
    errors: number;
  }> {
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    let scanned = 0;
    let deleted = 0;
    let skipped = 0;
    let errors = 0;

    this.logger.log(
      color.blue.bold(
        `[AI cleanup] scanning for unpurchased AI playlists older than ${white.bold(
          cutoff.toISOString()
        )}`
      )
    );

    // Find AISearch rows that look like prime candidates. We re-check
    // each one's purchase status individually since the `playlists`
    // table is keyed on `playlistId` (Spotify id), not a foreign key.
    const candidates = await this.prisma.aISearch.findMany({
      where: {
        status: 'success',
        createdAt: { lt: cutoff },
        spotifyPlaylistId: { not: null },
        // The errorMessage column is reused as a "deleted at" marker
        // (prefix 'cleaned:') so cron re-runs skip rows we've already
        // processed without needing a new schema column.
        OR: [
          { errorMessage: null },
          { NOT: { errorMessage: { startsWith: 'cleaned:' } } },
        ],
      },
      select: { id: true, jobId: true, spotifyPlaylistId: true },
      take: 200,
    });

    scanned = candidates.length;

    for (const row of candidates) {
      const spId = row.spotifyPlaylistId!;
      try {
        // Purchase guard: skip (never delete) if this playlist was bought.
        // "Purchased" = a `playlists` row with the same Spotify id that has
        // at least one paid, non-test payment attached — identical to the
        // admin AI-creations dashboard's "Purchased" column.
        const purchased = await this.prisma.playlist.findFirst({
          where: {
            playlistId: spId,
            Payment: { some: { payment: { status: 'paid', test: false } } },
          },
          select: { id: true },
        });
        if (purchased) {
          skipped += 1;
          continue;
        }
        const result = await this.spotify.deletePlaylist(spId);
        if (!result?.success) {
          this.logger.log(
            color.yellow.bold(
              `[AI cleanup] could not delete ${white.bold(spId)}: ${result?.error || 'unknown'}`
            )
          );
          errors += 1;
          continue;
        }
        await this.prisma.aISearch.update({
          where: { id: row.id },
          data: { errorMessage: `cleaned:${new Date().toISOString()}` },
        });
        deleted += 1;
        this.logger.log(
          color.green.bold(
            `[AI cleanup] deleted unpurchased playlist ${white.bold(spId)} (job ${white.bold(row.jobId)})`
          )
        );
      } catch (err) {
        errors += 1;
        this.logger.log(
          color.red.bold(`[AI cleanup] error processing ${spId}: ${err}`)
        );
      }
    }

    this.logger.log(
      color.blue.bold(
        `[AI cleanup] done — scanned=${white.bold(scanned.toString())} deleted=${white.bold(
          deleted.toString()
        )} skipped=${white.bold(skipped.toString())} errors=${white.bold(errors.toString())}`
      )
    );

    return { scanned, deleted, skipped, errors };
  }

  public async run(data: AIPlaylistJobData): Promise<void> {
    const { jobId, prompt, trackCount, locale } = data;
    const t0 = Date.now();
    const cost = new CostTracker(MODEL);

    // Short user-visible id appended to the Spotify playlist name so two
    // generations with the same theme don't collide under the existing
    // create-or-update logic (which keys by name). 8 lowercase alnum chars.
    const shortId = this.generateShortId();

    // Track an in-flight snapshot so `broadcastProgress` can mirror state
    // to Redis; a page reload then resumes from the latest snapshot.
    const snapshot: AIPlaylistSnapshot = {
      jobId,
      status: 'running',
      percentage: 0,
      keywords: [],
      requestedCount: trackCount,
      updatedAt: Date.now(),
    };
    this.snapshots.set(jobId, snapshot);
    await this.persistSnapshot(snapshot);

    this.logger.log(
      color.blue.bold(
        `[AI] ${white.bold(jobId)} STARTING shortId=${white.bold(shortId)} prompt="${white.bold(
          prompt
        )}" trackCount=${white.bold(trackCount.toString())}`
      )
    );

    // Create the AISearch row up-front so partial failures are still
    // observable in the table.
    try {
      await this.prisma.aISearch.create({
        data: {
          jobId,
          shortId,
          prompt,
          locale,
          requestedCount: trackCount,
          model: MODEL,
          status: 'running',
        },
      });
    } catch (err) {
      this.logger.log(
        color.yellow.bold(
          `[AI] ${white.bold(jobId)} could not insert AISearch row: ${err}`
        )
      );
    }

    // Hoisted outside the try so the catch-all error finalize can also
    // record the title if step 1 happened to complete before failure.
    let resolvedTitle: string | undefined;

    try {
      // ── Step 1/4: keyword brainstorm ────────────────────────────
      this.logger.log(
        color.blue.bold(
          `[AI] ${white.bold(jobId)} step 1/4 — brainstorming keywords`
        )
      );
      const stepT1 = Date.now();
      const { keywords, startYear, endYear, title, intent } =
        await this.thinkKeywords(jobId, prompt, locale, cost);
      resolvedTitle = title;
      this.deepenRequestedArtists(keywords, intent, trackCount);
      // Only the named artists: similar artists from an expansion round are
      // exactly what the customer did not ask for.
      const onlyNamedArtists =
        intent.onlyRequested && intent.requestedArtists.length > 0;
      this.logger.log(
        color.green.bold(
          `[AI] ${white.bold(jobId)} step 1/4 done in ${white.bold(
            ((Date.now() - stepT1) / 1000).toFixed(1) + 's'
          )} → ${white.bold(keywords.length.toString())} keywords, year range=${white.bold(
            startYear !== null || endYear !== null
              ? `${startYear ?? '…'}–${endYear ?? '…'}`
              : 'none'
          )}`
        )
      );

      // ── Step 2/4: candidate search ──────────────────────────────
      this.logger.log(
        color.blue.bold(
          `[AI] ${white.bold(jobId)} step 2/4 — searching DB for candidates across ${white.bold(
            keywords.length.toString()
          )} keywords`
        )
      );
      const stepT2 = Date.now();
      const candidates = await this.searchCandidates(
        jobId,
        keywords,
        startYear,
        endYear
      );

      // If the initial keyword set didn't surface enough candidates to
      // even hope to fill the target, ask the LLM for a second wave of
      // keywords that AVOID the ones we already tried, then merge.
      // This runs at most twice to keep cost bounded — every extra LLM
      // call is recorded in the same CostTracker so it shows up in the
      // final AISearch row.
      const targetPool = trackCount * 2;
      const tried = new Set(keywords.map((k) => k.value.toLowerCase()));
      let expansionRounds = 0;
      while (
        !onlyNamedArtists &&
        candidates.length < targetPool &&
        expansionRounds < 3 &&
        tried.size < KEYWORD_LIMIT * 4
      ) {
        expansionRounds += 1;
        this.logger.log(
          color.yellow.bold(
            `[AI] ${white.bold(jobId)} pool too small (${white.bold(
              candidates.length.toString()
            )}/${white.bold(targetPool.toString())}) — asking LLM for more keywords (round ${expansionRounds})`
          )
        );
        const extra = await this.expandKeywords(
          jobId,
          prompt,
          locale,
          Array.from(tried),
          startYear,
          endYear,
          cost
        );
        if (extra.length === 0) {
          this.logger.log(
            color.yellow.bold(
              `[AI] ${white.bold(jobId)} expansion round ${expansionRounds} returned no new keywords — stopping`
            )
          );
          break;
        }
        for (const k of extra) tried.add(k.value.toLowerCase());
        const extraCandidates = await this.searchCandidates(
          jobId,
          extra,
          startYear,
          endYear
        );
        const before = candidates.length;
        // Apply the same three dedupe rules to the merge that
        // `searchCandidates` applies to a single round — otherwise
        // duplicates can slip in via later expansion waves and the
        // LLM ends up picking the same song twice with different
        // trackIds.
        const knownTrackIds = new Set(candidates.map((c) => c.trackId));
        const knownSpotifyIds = new Set(
          candidates
            .map((c) => c.spotifyLink?.split('/').pop() || '')
            .filter(Boolean)
        );
        const knownArtistTitle = new Set(
          candidates.map((c) => this.dedupeKey(c.artist, c.name)).filter(Boolean)
        );
        for (const c of extraCandidates) {
          if (knownTrackIds.has(c.trackId)) continue;
          const sid = c.spotifyLink?.split('/').pop() || '';
          if (sid && knownSpotifyIds.has(sid)) continue;
          const at = this.dedupeKey(c.artist, c.name);
          if (at && knownArtistTitle.has(at)) continue;
          candidates.push(c);
          knownTrackIds.add(c.trackId);
          if (sid) knownSpotifyIds.add(sid);
          if (at) knownArtistTitle.add(at);
        }
        this.logger.log(
          color.blue.bold(
            `[AI] ${white.bold(jobId)} expansion round ${expansionRounds} added ${white.bold(
              (candidates.length - before).toString()
            )} new candidates (total ${white.bold(candidates.length.toString())})`
          )
        );
      }

      this.logger.log(
        color.green.bold(
          `[AI] ${white.bold(jobId)} step 2/4 done in ${white.bold(
            ((Date.now() - stepT2) / 1000).toFixed(1) + 's'
          )} → ${white.bold(candidates.length.toString())} unique candidate tracks${
            expansionRounds > 0 ? ` (after ${expansionRounds} expansion round${expansionRounds === 1 ? '' : 's'})` : ''
          }`
        )
      );

      // ── Step 3/4: LLM curation ──────────────────────────────────
      this.logger.log(
        color.blue.bold(
          `[AI] ${white.bold(jobId)} step 3/4 — LLM curating down to ${white.bold(
            trackCount.toString()
          )} matches`
        )
      );
      const stepT3 = Date.now();
      const picked = await this.curate(
        jobId,
        prompt,
        candidates,
        trackCount,
        startYear,
        endYear,
        cost,
        intent
      );
      this.logger.log(
        color.green.bold(
          `[AI] ${white.bold(jobId)} step 3/4 done in ${white.bold(
            ((Date.now() - stepT3) / 1000).toFixed(1) + 's'
          )} → ${white.bold(picked.length.toString())}/${white.bold(
            trackCount.toString()
          )} tracks picked`
        )
      );

      if (picked.length === 0) {
        this.logger.log(
          color.yellow.bold(
            `[AI] ${white.bold(jobId)} no tracks survived curation — aborting`
          )
        );
        await this.finalizeAISearch(jobId, {
          status: 'error',
          errorMessage: 'No tracks matched the theme',
          deliveredCount: 0,
          keywords: keywords.map((k) => k.value),
          title: resolvedTitle,
          startYear,
          endYear,
          cost,
          durationMs: Date.now() - t0,
        });
        this.broadcastError(jobId, 'Could not find any matching tracks for this theme.');
        return;
      }

      // ── Step 4/4: Spotify playlist creation ─────────────────────
      this.logger.log(
        color.blue.bold(
          `[AI] ${white.bold(jobId)} step 4/4 — creating Spotify playlist with ${white.bold(
            picked.length.toString()
          )} tracks`
        )
      );
      const stepT4 = Date.now();
      const spotifyResult = await this.createSpotifyPlaylist(
        jobId,
        title || prompt,
        picked,
        shortId
      );
      if (!spotifyResult.success || !spotifyResult.playlistId) {
        this.logger.log(
          color.red.bold(
            `[AI] ${white.bold(jobId)} step 4/4 FAILED: ${white.bold(
              spotifyResult.error || 'unknown'
            )}`
          )
        );
        await this.finalizeAISearch(jobId, {
          status: 'error',
          errorMessage: spotifyResult.error || 'Spotify playlist creation failed',
          deliveredCount: picked.length,
          keywords: keywords.map((k) => k.value),
          title: resolvedTitle,
          startYear,
          endYear,
          cost,
          durationMs: Date.now() - t0,
        });
        this.broadcastError(jobId, spotifyResult.error || 'Spotify playlist creation failed.');
        return;
      }
      this.logger.log(
        color.green.bold(
          `[AI] ${white.bold(jobId)} step 4/4 done in ${white.bold(
            ((Date.now() - stepT4) / 1000).toFixed(1) + 's'
          )} → Spotify ID ${white.bold(spotifyResult.playlistId)}`
        )
      );

      try {
        await this.cache.set(
          aiPlaylistPromptKey(spotifyResult.playlistId),
          prompt,
          AI_PLAYLIST_PROMPT_TTL_SECONDS
        );
      } catch (cacheErr) {
        this.logger.log(
          color.yellow.bold(
            `[AI] ${white.bold(jobId)} failed to cache prompt: ${cacheErr}`
          )
        );
      }

      // Use the actual Spotify-added count (post our final dedupe) for
      // the stored `deliveredCount` so the admin dashboard and the
      // frontend banner reflect what's truly in the playlist — not
      // the LLM's optimistic pick count.
      const actualDelivered =
        typeof spotifyResult.addedCount === 'number'
          ? spotifyResult.addedCount
          : picked.length;

      await this.finalizeAISearch(jobId, {
        status: 'success',
        deliveredCount: actualDelivered,
        keywords: keywords.map((k) => k.value),
        title: resolvedTitle,
        startYear,
        endYear,
        spotifyPlaylistId: spotifyResult.playlistId,
        spotifyPlaylistUrl: spotifyResult.playlistUrl,
        cost,
        durationMs: Date.now() - t0,
      });

      this.broadcastComplete(jobId, {
        spotifyPlaylistUrl: spotifyResult.playlistUrl,
        spotifyPlaylistId: spotifyResult.playlistId,
        requestedCount: trackCount,
        deliveredCount: actualDelivered,
      });

      this.logger.log(
        color.green.bold(
          `[AI] ${white.bold(jobId)} COMPLETE in ${white.bold(
            ((Date.now() - t0) / 1000).toFixed(1) + 's'
          )} → ${white.bold(picked.length.toString())}/${white.bold(
            trackCount.toString()
          )} tracks, ${white.bold(cost.callCount.toString())} LLM call${cost.callCount === 1 ? '' : 's'} (${white.bold(
            cost.inputTokens.toString()
          )} in + ${white.bold(cost.outputTokens.toString())} out tokens = $${white.bold(
            cost.costUsd.toFixed(4)
          )}), at ${white.bold(spotifyResult.playlistUrl || '?')}`
        )
      );
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `[AI] ${white.bold(jobId)} FAILED after ${white.bold(
            ((Date.now() - t0) / 1000).toFixed(1) + 's'
          )}: ${error?.message || error}`
        )
      );
      await this.finalizeAISearch(jobId, {
        status: 'error',
        errorMessage: error?.message || 'Unexpected error',
        title: resolvedTitle,
        cost,
        durationMs: Date.now() - t0,
      });
      this.broadcastError(jobId, error?.message || 'Unexpected error');
    }
  }

  /**
   * Persist the final state of an AI search into the `aisearches` table.
   * Best-effort: logs and swallows errors so a DB hiccup doesn't take down
   * the user's flow (the WS broadcast already happened).
   */
  private async finalizeAISearch(
    jobId: string,
    fields: {
      status: 'success' | 'error';
      errorMessage?: string;
      deliveredCount?: number;
      keywords?: string[];
      title?: string;
      startYear?: number | null;
      endYear?: number | null;
      spotifyPlaylistId?: string;
      spotifyPlaylistUrl?: string;
      cost: CostTracker;
      durationMs: number;
    }
  ): Promise<void> {
    try {
      await this.prisma.aISearch.update({
        where: { jobId },
        data: {
          status: fields.status,
          errorMessage: fields.errorMessage ?? null,
          deliveredCount: fields.deliveredCount ?? 0,
          keywords: fields.keywords ?? Prisma.JsonNull,
          title: fields.title ?? null,
          startYear: fields.startYear ?? null,
          endYear: fields.endYear ?? null,
          spotifyPlaylistId: fields.spotifyPlaylistId ?? null,
          spotifyPlaylistUrl: fields.spotifyPlaylistUrl ?? null,
          inputTokens: fields.cost.inputTokens,
          outputTokens: fields.cost.outputTokens,
          totalCostUsd: parseFloat(fields.cost.costUsd.toFixed(6)),
          durationMs: fields.durationMs,
        },
      });
    } catch (err) {
      this.logger.log(
        color.yellow.bold(
          `[AI] ${white.bold(jobId)} failed to update AISearch row: ${err}`
        )
      );
    }

    // Mirror terminal state into the snapshot so a reload after success
    // can navigate forward to the summary, and a reload after error
    // shows the error UI.
    const snap = this.snapshots.get(jobId);
    if (snap) {
      snap.status = fields.status;
      snap.percentage = fields.status === 'success' ? 100 : snap.percentage;
      snap.deliveredCount = fields.deliveredCount;
      snap.spotifyPlaylistId = fields.spotifyPlaylistId;
      snap.spotifyPlaylistUrl = fields.spotifyPlaylistUrl;
      snap.error = fields.errorMessage;
      snap.activeWord = null;
      await this.persistSnapshot(snap);
      // Keep the in-memory snapshot around briefly so any late WS event
      // can still co-write — but drop the strong reference after a tick.
      setTimeout(() => this.snapshots.delete(jobId), 5000);
    }
  }

  private async thinkKeywords(
    jobId: string,
    prompt: string,
    locale: string,
    cost: CostTracker
  ): Promise<{
    keywords: SearchKeyword[];
    startYear: number | null;
    endYear: number | null;
    title: string;
    intent: ArtistIntent;
  }> {
    this.broadcastProgress(jobId, {
      stage: 'thinking_keywords',
      percentage: 5,
      messageKey: 'submit.aiMsg.thinking',
    });

    const localeHint = this.describeLocale(locale);

    const result = await this.openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You analyze a user-supplied music theme and return: (1) up to 50 search keywords, and (2) an optional release-or-composition-year range if the user mentioned a specific time period.\n\nKEYWORD RULES — CRITICAL:\nThe keywords are used to run SQL `LIKE %keyword%` against ONLY two columns: `artist` (the performing artist name) and `name` (the song title). They are NOT used against any genre, mood, decade, or tag column. Therefore:\n  • DO return concrete artist or band names that fit the theme (e.g. "Guus Meeuwis", "2 Unlimited", "Vengaboys", "BZN").\n  • DO return distinctive words or phrases likely to appear in a relevant SONG TITLE (e.g. "love", "summer", "Christmas", "tonight" — only when the user theme clearly implies them, like a christmas or summer playlist).\n  • DO NOT return genre or sub-genre names ("Eurodance", "synthpop", "house", "happy hardcore", "R&B", "pop", "rock", "nederpop"). These will not match anything.\n  • DO NOT return moods, descriptors, or marketing tags ("nostalgia", "party", "upbeat", "club", "catchy", "radio hits", "hit singles", "mainstream", "Top 40", "boy bands", "girl groups").\n  • DO NOT return decade words or era labels ("90s", "1990s", "nineties") — the year range below already covers that.\n  • DO NOT return country/language tags ("Dutch artists", "Holland", "NL", "Nederlandse hits") — instead return artists from that country.\nUse the theme (genre/era/mood/country) internally to pick which artists belong in the list; do not echo the descriptors as keywords.\n\nCOLUMN INTENT — IMPORTANT:\nYou return three keyword buckets: `keywords` (search both columns), `artistKeywords` (search artist only), `titleKeywords` (search song title only). Choose the right bucket:\n  • When the user explicitly says a word should be IN THE TITLE only ("songs with `soul` in the title", "tracks called `love`", "anything with `night` in the name") → put it in `titleKeywords`. Putting it in `keywords` would also match every artist whose name contains it — the opposite of what the user asked.\n  • When the user clearly wants songs BY an artist or in that artist\'s style and the artist\'s name could ambiguously appear in unrelated song titles → prefer `artistKeywords`.\n  • When the user explicitly says a word should match EITHER the title OR the artist ("songs that mention `love` anywhere", "anything with `soul` in the title or the artist name") → put it in `keywords` (both columns). This is also the right bucket for broad themes where you don\'t need to narrow scope.\n\nLOCALE BIAS — IMPORTANT:\n' +
            localeHint +
            '\n\nLIST SIZE & DIVERSITY — IMPORTANT:\n100 is the maximum, not a target. Match the breadth of the user theme:\n  • If the user names ONE artist ("Taylor Swift", "Bach") → return just that one keyword. Do not invent similar artists they did not ask for.\n  • If the user names a few specific artists → return only those artists.\n  • If the user describes a broad theme ("90s hits", "summer beach party", "Dutch 90s") → BE DIVERSE: return a wide spread of artists from different sub-genres, eras within the range, regions, and styles that fit. For a wide theme like "90s hits" you can comfortably return 60–100 distinct artists covering pop, rock, R&B, hip-hop, dance, country, alt-rock, one-hit wonders, etc. Aim for breadth, not safe big-names only.\n  • For narrower themes still cover the corners: include cult favourites, deep cuts, lesser-known but era-appropriate artists alongside the obvious picks. A diverse list yields a more interesting playlist.\n  • Never pad with noise — every keyword should be a real artist or distinctive song word the user would actually want.\n\nARTIST INTENT — IMPORTANT:\nFour fields say how the playlist is divided over artists. Fill them from what the user wrote, nothing else.\n  • `requestedArtists`: every artist or band the user NAMES in the theme, spelled the way the artist is usually catalogued ("Enimen" → "Eminem"). Only names the user typed, never artists you thought of yourself. Empty for a theme without names ("80s hits", "German Schlager").\n  • `onlyRequestedArtists`: true when the playlist should contain ONLY the named artists: the theme is nothing but one or more artist names, or says so ("only", "nur", "alleen", "nothing else", "all songs of"). false when the theme also asks for a genre, an era, a mood or "similar artists".\n  • `maxPerArtist`: the number, when the user limits how many songs one artist may have ("one song per band", "max 2 per artist", "jeweils 3 Songs pro Künstler"); otherwise null.\n  • `requestedArtistsMayExceedLimit`: true only when the user sets such a limit AND says the named artists may appear more often ("everyone once, only X often"); otherwise false.\n\nYear-range rules: only set startYear/endYear if the theme clearly implies a time period (e.g. "80s rock" → 1980-1989, "90s" → 1990-1999, "early 2000s" → 2000-2005, "from 1975" → 1975-1975, "songs from the 60s and 70s" → 1960-1979, "2010 onwards" → 2010-current year, "renaissance music" → 1400-1600, "medieval chants" → 800-1400, "baroque" → 1600-1750). The catalog includes classical compositions dating back roughly to year 1000, so historic ranges are valid. If no year hint is present in the theme, leave both null. Never invent a range to be helpful — only use it if the user explicitly references a year, decade, or era.',
        },
        {
          role: 'user',
          content: `Theme:\n${prompt}\n\nUser locale: ${locale}\n\nReturn as many keywords as the theme genuinely warrants (1 if a single artist, more for broad themes; max ${KEYWORD_LIMIT}) and a year range only if explicitly implied.`,
        },
      ],
      reasoning_effort: REASONING_EFFORT,
      response_format: {
        type: 'json_schema',
        json_schema: {
            name: 'returnKeywords',
            schema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description:
                    'A short, human-friendly title (max ~50 chars) summarizing this playlist theme. e.g. "Dutch 90s Hits", "Cozy Christmas Classics". Title-case. No quotes.',
                },
                keywords: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Keywords searched in BOTH the artist column AND the song title column. Use this when either side could plausibly match (e.g. "Beatles" — searches artist; "Christmas" — searches title; "Beach Boys" — searches artist; mixed-intent terms).',
                },
                artistKeywords: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Keywords searched ONLY against the artist column. Use when the user wants songs BY a specific artist or in their style, and you want to avoid false positives from those words appearing in unrelated song titles.',
                },
                titleKeywords: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Keywords searched ONLY against the song title column. CRITICAL: use this whenever the user explicitly asks for songs whose TITLE contains a word (e.g. "songs with `soul` in the title", "tracks called `love`", "anything with `summer` in the name"). Putting "soul" into the regular keywords here would surface every soul-genre artist and dilute the result.',
                },
                startYear: {
                  type: ['integer', 'null'],
                  description:
                    'Earliest release year if the theme implies a time period; otherwise null',
                },
                endYear: {
                  type: ['integer', 'null'],
                  description:
                    'Latest release year if the theme implies a time period; otherwise null',
                },
                requestedArtists: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Artists or bands the user named in the theme. Empty when the theme names none.',
                },
                onlyRequestedArtists: {
                  type: 'boolean',
                  description:
                    'true when the playlist should contain only the named artists',
                },
                maxPerArtist: {
                  type: ['integer', 'null'],
                  description:
                    'The limit per artist the user asked for; otherwise null',
                },
                requestedArtistsMayExceedLimit: {
                  type: 'boolean',
                  description:
                    'true only when the user says the named artists may go over maxPerArtist',
                },
              },
              required: [
                'title',
                'keywords',
                'artistKeywords',
                'titleKeywords',
                'startYear',
                'endYear',
                'requestedArtists',
                'onlyRequestedArtists',
                'maxPerArtist',
                'requestedArtistsMayExceedLimit',
              ],
            },
        },
      },
    });

    cost.recordFromResponse(result);

    const content = result?.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Keyword generation returned no tool call');
    }

    let parsed: {
      keywords?: string[];
      artistKeywords?: string[];
      titleKeywords?: string[];
      startYear: number | null;
      endYear: number | null;
      title?: string;
      requestedArtists?: unknown;
      onlyRequestedArtists?: unknown;
      maxPerArtist?: unknown;
      requestedArtistsMayExceedLimit?: unknown;
    };
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error('Failed to parse keyword tool call arguments');
    }

    const requestedArtists = (
      Array.isArray(parsed.requestedArtists) ? parsed.requestedArtists : []
    )
      .filter((a): a is string => typeof a === 'string')
      .map((a) => a.trim())
      .filter(Boolean);
    const intent: ArtistIntent = {
      requestedArtists,
      onlyRequested:
        parsed.onlyRequestedArtists === true && requestedArtists.length > 0,
      maxPerArtist:
        typeof parsed.maxPerArtist === 'number' ? parsed.maxPerArtist : null,
      requestedExempt: parsed.requestedArtistsMayExceedLimit === true,
    };

    // Combine all three column-intent buckets into typed SearchKeywords.
    // Dedupe is per-keyword-string (case-insensitive): if the same word
    // appears in two buckets we keep the most specific intent (title or
    // artist) over `any`.
    const intentByLower = new Map<string, KeywordTarget>();
    const displayByLower = new Map<string, string>();
    const ingest = (raw: unknown, target: KeywordTarget) => {
      if (typeof raw !== 'string') return;
      const t = raw.trim();
      if (!t) return;
      const key = t.toLowerCase();
      if (!displayByLower.has(key)) displayByLower.set(key, t);
      const current = intentByLower.get(key);
      // Promote `any` → `artist`/`title` if a more specific intent appears.
      if (!current || (current === 'any' && target !== 'any')) {
        intentByLower.set(key, target);
      }
    };
    for (const k of parsed.titleKeywords || []) ingest(k, 'title');
    for (const k of parsed.artistKeywords || []) ingest(k, 'artist');
    for (const k of parsed.keywords || []) ingest(k, 'any');

    const keywords: SearchKeyword[] = [];
    for (const [lower, target] of intentByLower) {
      keywords.push({ value: displayByLower.get(lower)!, target });
      if (keywords.length >= KEYWORD_LIMIT) break;
    }
    // An artist the customer named is always searched, also when the model
    // left the name out of its keyword buckets or the list was cut off.
    for (const artist of requestedArtists) {
      const lower = artist.toLowerCase();
      if (!keywords.some((k) => k.value.toLowerCase() === lower)) {
        keywords.push({ value: artist, target: 'artist' });
      }
    }

    const { startYear, endYear } = this.normalizeYearRange(
      parsed.startYear,
      parsed.endYear
    );

    // Clean up the title (LLM may add quotes / extra whitespace).
    const rawTitle = (parsed.title || '').replace(/[\r\n]+/g, ' ').trim();
    const title = rawTitle
      .replace(/^["'`]+|["'`]+$/g, '')
      .slice(0, 60)
      .trim();

    const keywordLogLine = keywords
      .map((k) => (k.target === 'any' ? k.value : `${k.value} [${k.target}]`))
      .join(', ');
    this.logger.log(
      color.blue.bold(
        `[AI] ${white.bold(jobId)} title="${white.bold(title)}" keywords: ${white.bold(keywordLogLine)}`
      )
    );
    if (intent.requestedArtists.length > 0 || intent.maxPerArtist !== null) {
      this.logger.log(
        color.blue.bold(
          `[AI] ${white.bold(jobId)} named artists: ${white.bold(
            intent.requestedArtists.join(', ') || 'none'
          )}${intent.onlyRequested ? ' (only these)' : ''}, limit per artist: ${white.bold(
            intent.maxPerArtist === null ? 'none' : intent.maxPerArtist.toString()
          )}${intent.requestedExempt ? ' (not for the named artists)' : ''}`
        )
      );
    }

    const hasRange = startYear !== null || endYear !== null;
    this.broadcastProgress(jobId, {
      stage: 'thinking_keywords',
      percentage: 15,
      messageKey: hasRange
        ? 'submit.aiMsg.keywordsDoneWithRange'
        : 'submit.aiMsg.keywordsDone',
      messageParams: {
        count: keywords.length,
        startYear: startYear ?? '…',
        endYear: endYear ?? '…',
      },
      current: keywords.length,
      total: KEYWORD_LIMIT,
      // Frontend cares only about the displayable strings.
      keywords: keywords.map((k) => k.value),
      startYear,
      endYear,
    });

    return { keywords, startYear, endYear, title, intent };
  }

  /**
   * Search the artists the customer named deeper than the 50 songs a keyword
   * normally gets: a playlist of one artist used to stop at 50 of their songs
   * and was then filled up with similar artists.
   */
  private deepenRequestedArtists(
    keywords: SearchKeyword[],
    intent: ArtistIntent,
    trackCount: number
  ): void {
    if (intent.requestedArtists.length === 0) return;
    const named = new Set(intent.requestedArtists.map((a) => a.toLowerCase()));
    // Alone they may have to fill the whole playlist; next to a wider theme
    // they never get more than half of it (see aiPlaylistBalance.ts). Twice
    // that, because live and remastered versions of one song collapse into
    // one candidate: 120 Springsteen rows were 89 songs.
    const wanted = intent.onlyRequested ? trackCount * 2 : trackCount;
    const limit = Math.min(
      REQUESTED_ARTIST_LIMIT,
      Math.max(PER_KEYWORD_LIMIT, wanted)
    );
    for (const keyword of keywords) {
      if (keyword.target !== 'title' && named.has(keyword.value.toLowerCase())) {
        keyword.limit = limit;
      }
    }
  }

  /**
   * Brainstorm an additional batch of keywords that explicitly AVOIDS
   * the set we already tried. Used as a retry when the first search
   * produced too few candidates. Token usage is recorded into the shared
   * CostTracker so it counts toward the run's totalCostUsd.
   */
  private async expandKeywords(
    jobId: string,
    prompt: string,
    locale: string,
    alreadyTried: string[],
    startYear: number | null,
    endYear: number | null,
    cost: CostTracker
  ): Promise<SearchKeyword[]> {
    const localeHint = this.describeLocale(locale);
    const yearHint =
      startYear !== null || endYear !== null
        ? `The user theme implies a year range of ${startYear ?? '…'}–${endYear ?? '…'}; bias toward artists active in that window.`
        : 'No specific year range was implied.';

    this.broadcastProgress(jobId, {
      stage: 'thinking_keywords',
      percentage: 16,
      messageKey: 'submit.aiMsg.thinkingMore',
    });

    const result = await this.openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are extending an existing keyword list to find more matching songs in a music database. The same KEYWORD RULES apply as before (artist or distinctive title words only, no genre/mood/decade/country tags). ' +
            localeHint +
            ' ' +
            yearHint +
            ' DO NOT repeat any keyword that was already tried (they will be listed). Aim for keywords whose songs are likely actually catalogued in a Western pop/rock database. If you cannot find genuinely new candidates that fit, return an empty list — do not pad.',
        },
        {
          role: 'user',
          content: `Theme:\n${prompt}\n\nAlready tried (do not repeat any of these):\n${alreadyTried.join(', ')}\n\nReturn up to ${KEYWORD_LIMIT} additional keywords (artist names mainly). Empty list is OK.`,
        },
      ],
      reasoning_effort: REASONING_EFFORT,
      response_format: {
        type: 'json_schema',
        json_schema: {
            name: 'returnMoreKeywords',
            schema: {
              type: 'object',
              properties: {
                keywords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Additional search keywords — must NOT overlap with the already-tried list',
                },
              },
              required: ['keywords'],
            },
        },
      },
    });

    cost.recordFromResponse(result);

    const content = result?.choices[0]?.message?.content;
    if (!content) return [];
    let parsed: { keywords: string[] };
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }

    const seen = new Set(alreadyTried.map((k) => k.toLowerCase()));
    const out: SearchKeyword[] = [];
    for (const raw of parsed.keywords || []) {
      const t = (raw || '').trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Expansion keywords default to `any` — we don't ask the LLM to
      // classify them since the round itself is a retry of broad search.
      out.push({ value: t, target: 'any' });
      if (out.length >= KEYWORD_LIMIT) break;
    }

    this.logger.log(
      color.blue.bold(
        `[AI] ${white.bold(jobId)} expansion produced ${white.bold(out.length.toString())} new keywords`
      )
    );

    return out;
  }

  private normalizeYearRange(
    rawStart: number | null | undefined,
    rawEnd: number | null | undefined
  ): { startYear: number | null; endYear: number | null } {
    const sanitize = (n: number | null | undefined): number | null => {
      if (n === null || n === undefined) return null;
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      const y = Math.floor(n);
      // Classical compositions in our catalog can date back as far as ~year
      // 1000, so we only reject clearly bogus values (non-positive or far in
      // the future).
      const currentYear = new Date().getUTCFullYear();
      if (y < 1 || y > currentYear + 1) return null;
      return y;
    };

    let startYear = sanitize(rawStart);
    let endYear = sanitize(rawEnd);

    if (startYear !== null && endYear !== null && startYear > endYear) {
      // Swap if reversed.
      [startYear, endYear] = [endYear, startYear];
    }

    return { startYear, endYear };
  }

  private async searchCandidates(
    jobId: string,
    keywords: SearchKeyword[],
    startYear: number | null,
    endYear: number | null
  ): Promise<CandidateTrack[]> {
    if (keywords.length === 0) return [];

    const hasRange = startYear !== null || endYear !== null;

    // We deliberately do NOT broadcast the full keyword list here — the
    // frontend word cloud is now seeded incrementally from per-keyword
    // results so it only shows keywords that actually returned hits.
    this.broadcastProgress(jobId, {
      stage: 'searching_tracks',
      percentage: 18,
      messageKey: hasRange
        ? 'submit.aiMsg.searchingStartWithRange'
        : 'submit.aiMsg.searchingStart',
      messageParams: {
        startYear: startYear ?? '…',
        endYear: endYear ?? '…',
      },
      current: 0,
      total: keywords.length,
      startYear,
      endYear,
    });

    // Run keyword searches sequentially: the LIKE+ORDER BY RAND() query is
    // fast in practice, and serial execution avoids contending for the shared
    // Prisma connection pool with the rest of the app.
    const buckets: CandidateTrack[][] = [];
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      const completed = i + 1;
      const targetLabel = kw.target === 'any' ? '' : ` [${kw.target}]`;
      try {
        const rows = await this.searchByKeyword(kw, startYear, endYear);
        this.logger.log(
          color.blue.bold(
            `[AI]   ${white.bold(`${completed}/${keywords.length}`)} keyword="${white.bold(
              kw.value + targetLabel
            )}" → ${white.bold(rows.length.toString())} candidates`
          )
        );
        this.broadcastProgress(jobId, {
          stage: 'searching_tracks',
          percentage: 18 + Math.floor((completed / keywords.length) * 30),
          messageKey:
            rows.length > 0
              ? 'submit.aiMsg.searchingHit'
              : 'submit.aiMsg.searchingMiss',
          messageParams: { keyword: kw.value },
          current: completed,
          total: keywords.length,
          currentKeyword: kw.value,
          keywordHits: rows.length,
        });
        buckets.push(rows);
      } catch (err) {
        this.logger.log(
          color.red.bold(`Keyword search failed for "${kw.value}": ${err}`)
        );
        buckets.push([]);
      }
    }

    // Dedupe the candidate pool by THREE rules so the LLM never sees
    // duplicates and the final playlist count actually matches what
    // the user asked for:
    //   1. Internal trackId (obvious — same DB row twice).
    //   2. Spotify track ID extracted from `spotifyLink` (different
    //      DB rows can point at the same Spotify URI).
    //   3. Cleaned artist + title (case-insensitive, with " - <suffix>"
    //      and "(feat. …) / (Remastered) / (Live)"-style adornments
    //      stripped via `utils.cleanTrackName`). The summary page does
    //      something similar for its duplicate warning, so two rows
    //      that look distinct in the DB ("Voorbij" vs "Voorbij - Live")
    //      now collapse to a single entry before the LLM ever sees them.
    const seenTrackIds = new Set<string>();
    const seenSpotifyIds = new Set<string>();
    const seenArtistTitle = new Set<string>();
    const candidates: CandidateTrack[] = [];
    for (const bucket of buckets) {
      for (const row of bucket) {
        if (seenTrackIds.has(row.trackId)) continue;
        const sid = row.spotifyLink?.split('/').pop() || '';
        if (sid && seenSpotifyIds.has(sid)) continue;
        const at = this.dedupeKey(row.artist, row.name);
        if (at && seenArtistTitle.has(at)) continue;
        seenTrackIds.add(row.trackId);
        if (sid) seenSpotifyIds.add(sid);
        if (at) seenArtistTitle.add(at);
        candidates.push(row);
      }
    }

    this.broadcastProgress(jobId, {
      stage: 'searching_tracks',
      percentage: 50,
      messageKey: 'submit.aiMsg.candidatesFound',
      messageParams: { count: candidates.length },
      current: keywords.length,
      total: keywords.length,
    });

    return candidates;
  }

  /**
   * Strong-form dedupe key for artist+title pairs. Collapses benign
   * variants so the final playlist count matches the user's request
   * and the summary page doesn't flag survivors.
   *
   * Normalisation (per side):
   *   • run through `utils.cleanTrackName` (strips feat./lyrics/
   *     remastered/`" - <suffix>"` etc.)
   *   • repeatedly strip any trailing `(…)` or `[…]` group — catches
   *     "(The Vengabus)", "(Radio Edit)", "[Single Version]" that
   *     `cleanTrackName`'s named-tag list doesn't cover
   *   • safety-net " - " split in case `cleanTrackName` missed one
   *   • lowercase, collapse whitespace, strip trailing punctuation
   *     ("!" vs no "!" differs between versions, e.g.
   *     "Freedom! '90" vs "Freedom '90")
   */
  private dedupeKey(artist: string | null | undefined, name: string | null | undefined): string {
    const reduce = (raw: string): string => {
      let s = String(raw || '');
      s = this.utils.cleanTrackName(s);
      let prev: string;
      do {
        prev = s;
        s = s.replace(/\s*[\(\[][^()\[\]]*[\)\]]\s*$/u, '').trim();
      } while (s !== prev);
      const dashIdx = s.indexOf(' - ');
      if (dashIdx > 0) s = s.slice(0, dashIdx);
      s = s
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[\s!?.,:;'"`’]+$/u, '');
      return s;
    };
    const a = reduce(artist || '');
    const n = reduce(name || '');
    return a && n ? `${a}|||${n}` : '';
  }

  private async searchByKeyword(
    keyword: SearchKeyword,
    startYear: number | null,
    endYear: number | null
  ): Promise<CandidateTrack[]> {
    const like = `%${keyword.value.replace(/[%_]/g, (m) => '\\' + m)}%`;

    // Column filter based on the LLM's column-intent classification:
    //   • title  → name LIKE only
    //   • artist → artist LIKE only
    //   • any    → either column matches (legacy/default behaviour)
    const columnFilter =
      keyword.target === 'title'
        ? Prisma.sql`name LIKE ${like}`
        : keyword.target === 'artist'
        ? Prisma.sql`artist LIKE ${like}`
        : Prisma.sql`(artist LIKE ${like} OR name LIKE ${like})`;

    // Build optional year filter. When a range is given we also require
    // `year IS NOT NULL` so we don't sweep up unknown-year tracks into a
    // theme that explicitly cares about era.
    const yearFilter =
      startYear !== null && endYear !== null
        ? Prisma.sql`AND year IS NOT NULL AND year BETWEEN ${startYear} AND ${endYear}`
        : startYear !== null
        ? Prisma.sql`AND year IS NOT NULL AND year >= ${startYear}`
        : endYear !== null
        ? Prisma.sql`AND year IS NOT NULL AND year <= ${endYear}`
        : Prisma.empty;

    // "Queen" also matches Queensrÿche and Queens of the Stone Age. For an
    // artist the customer named, their own songs come first, so the deeper
    // search is spent on them and not on the lookalikes.
    const order = keyword.limit
      ? Prisma.sql`(artist = ${keyword.value}) DESC, RAND()`
      : Prisma.sql`RAND()`;

    return this.prisma.$queryRaw<CandidateTrack[]>(Prisma.sql`
      SELECT id, trackId, artist, name, spotifyLink, year
      FROM tracks
      WHERE spotifyLink IS NOT NULL
        AND spotifyLinkIgnored = 0
        AND ${columnFilter}
        ${yearFilter}
      ORDER BY ${order}
      LIMIT ${keyword.limit ?? PER_KEYWORD_LIMIT}
    `);
  }

  private async curate(
    jobId: string,
    prompt: string,
    candidates: CandidateTrack[],
    target: number,
    startYear: number | null,
    endYear: number | null,
    cost: CostTracker,
    intent: ArtistIntent = NO_ARTIST_INTENT
  ): Promise<CandidateTrack[]> {
    if (candidates.length === 0) return [];

    const picks = new Map<string, CandidateTrack>();
    const byTrackId = new Map<string, CandidateTrack>();
    for (const c of candidates) byTrackId.set(c.trackId, c);

    // How many songs one artist may get; see aiPlaylistBalance.ts.
    const balance = ArtistBalance.plan(candidates, target, intent);
    if (balance.limits) {
      const describe = (cap: number) =>
        Number.isFinite(cap) ? cap.toString() : 'no limit';
      this.logger.log(
        color.blue.bold(
          `[AI] ${white.bold(jobId)} artist balance: ${white.bold(
            describe(balance.cap)
          )} per artist${balance.plan.capIsHard ? ' (asked for)' : ''}${
            balance.plan.requested.length > 0
              ? `, named artists ${white.bold(describe(balance.requestedCap))}`
              : ''
          }`
        )
      );
    }

    // And how many one release year may get, so the deck runs through the
    // years instead of bunching up where the catalogue is thickest.
    const years = YearSpread.plan(candidates, target);
    if (years.limits) {
      this.logger.log(
        color.blue.bold(
          `[AI] ${white.bold(jobId)} year spread: ${white.bold(
            years.cap.toString()
          )} per year`
        )
      );
    }

    /** Both the artist and the year of this song still have room. */
    const hasRoom = (c: CandidateTrack) =>
      balance.hasRoom(c.artist) && years.hasRoom(c.year);
    const take = (c: CandidateTrack) => {
      balance.take(c.artist);
      years.take(c.year);
      picks.set(c.trackId, c);
    };

    // Songs the LLM chose for an artist or a year that already had its fair
    // share. They are the first to go in when the playlist comes up short.
    const heldBack: CandidateTrack[] = [];
    const accept = (trackIds: string[]): number => {
      const before = picks.size;
      for (const tid of trackIds) {
        if (picks.size >= target) break;
        const row = byTrackId.get(tid);
        if (!row || picks.has(tid)) continue;
        if (hasRoom(row)) {
          take(row);
        } else if (balance.hasRoom(row.artist) || balance.isSoftCapped(row.artist)) {
          // Not when it is a limit the customer set that stands in the way.
          heldBack.push(row);
        }
      }
      return picks.size - before;
    };

    // The next batch out of `queue`. A song whose artist or year is full is
    // skipped, so the LLM never spends a pick on one that would be dropped.
    const takeBatch = (queue: CandidateTrack[], from: number) => {
      const batch: CandidateTrack[] = [];
      let cursor = from;
      while (cursor < queue.length && batch.length < CURATION_BATCH_SIZE) {
        const candidate = queue[cursor++];
        if (hasRoom(candidate)) batch.push(candidate);
      }
      let ahead = 0;
      for (let i = cursor; i < queue.length; i++) {
        if (hasRoom(queue[i])) ahead += 1;
      }
      return {
        batch,
        cursor,
        batchesAhead: Math.ceil(ahead / CURATION_BATCH_SIZE),
      };
    };

    // Shuffle candidates so the LLM sees variety in each batch.
    const shuffled = this.shuffle([...candidates]);

    let cursor = 0;
    let batchIndex = 0;
    while (picks.size < target) {
      const next = takeBatch(shuffled, cursor);
      cursor = next.cursor;
      if (next.batch.length === 0) break;
      batchIndex += 1;
      const batchesLeft = 1 + next.batchesAhead;
      const totalBatches = batchIndex - 1 + batchesLeft;

      this.broadcastProgress(jobId, {
        stage: 'curating_with_llm',
        percentage:
          55 + Math.floor((batchIndex / totalBatches) * 35),
        messageKey: 'submit.aiMsg.curating',
        messageParams: {
          batchIndex,
          totalBatches,
          picks: picks.size,
          target,
        },
        current: picks.size,
        total: target,
      });

      // Every batch is asked for its share of what is still needed,
      // otherwise batch 1 tends to gobble most of the target (the LLM picks
      // aggressively while the budget is huge) and later batches contribute
      // almost nothing, hurting diversity. The share is worked out again for
      // each batch, so a stingy batch is made up for by the ones after it.
      // The LLM is still told to be honest about quality (no padding), so a
      // weak batch can return fewer.
      const askThisBatch = Math.ceil((target - picks.size) / batchesLeft);
      const picked = await this.curateBatch(
        prompt,
        next.batch,
        askThisBatch,
        startYear,
        endYear,
        cost,
        this.spreadGuidance(balance, years, intent)
      );
      const added = accept(picked);
      this.logger.log(
        color.blue.bold(
          `[AI]   curate batch ${white.bold(`${batchIndex}/${totalBatches}`)} → +${white.bold(
            added.toString()
          )} picks (total ${white.bold(`${picks.size}/${target}`)}, quota ${white.bold(askThisBatch.toString())})`
        )
      );
    }

    // Top-up pass: batches that under-delivered against their quota leave
    // the playlist short. Walk the unused candidates and ask the LLM to fill
    // the remainder — this guarantees we use the full pool before giving up.
    // A song is offered in a top-up once: asking again about one the LLM has
    // just passed over is a call for nothing.
    const offered = new Set<string>();
    const topUp = async (maxBatches: number) => {
      const leftover = this.shuffle(
        shuffled.filter((c) => !picks.has(c.trackId) && !offered.has(c.trackId))
      );
      let topupCursor = 0;
      let topupIndex = 0;
      while (picks.size < target && topupIndex < maxBatches) {
        const next = takeBatch(leftover, topupCursor);
        topupCursor = next.cursor;
        if (next.batch.length === 0) break;
        topupIndex += 1;
        for (const candidate of next.batch) offered.add(candidate.trackId);
        const remaining = target - picks.size;
        const picked = await this.curateBatch(
          prompt,
          next.batch,
          remaining,
          startYear,
          endYear,
          cost,
          this.spreadGuidance(balance, years, intent)
        );
        const added = accept(picked);
        this.logger.log(
          color.blue.bold(
            `[AI]   top-up batch ${white.bold(`${topupIndex}/${topupIndex + next.batchesAhead}`)} → +${white.bold(
              added.toString()
            )} picks (total ${white.bold(`${picks.size}/${target}`)})`
          )
        );
      }
    };

    // Short of the target with shares in force: first more of what still
    // fits inside them. The songs that were held back are from exactly the
    // artists and years that are full, so taking those first would undo the
    // spread for places the rest of the pool could have filled.
    if (picks.size < target && (balance.limits || years.limits)) {
      await topUp(CAPPED_TOPUP_BATCHES);
    }

    // Still short: the fair shares were tighter than what the LLM liked. Lift
    // them (a limit the customer set stays) and take the songs it already
    // chose, the one whose artist and year have the fewest songs so far first.
    if (picks.size < target) {
      balance.lift();
      years.lift();
      const crowding = (c: CandidateTrack) =>
        balance.countOf(c.artist) + years.countOf(c.year);
      while (picks.size < target && heldBack.length > 0) {
        let fewest = 0;
        for (let i = 1; i < heldBack.length; i++) {
          if (crowding(heldBack[i]) < crowding(heldBack[fewest])) fewest = i;
        }
        const [row] = heldBack.splice(fewest, 1);
        if (!picks.has(row.trackId) && hasRoom(row)) take(row);
      }
    }

    // And whatever is left of the pool, without the shares.
    if (picks.size < target) {
      await topUp(Infinity);
    }

    return Array.from(picks.values()).slice(0, target);
  }

  /**
   * What the curation LLM is told about dividing the picks over artists and
   * years. The caps are enforced in `curate` whatever it answers; saying so
   * up front keeps it from spending its picks on songs that are then dropped.
   */
  private spreadGuidance(
    balance: ArtistBalance,
    years: YearSpread,
    intent: ArtistIntent
  ): string {
    const lines: string[] = [];
    const named = intent.requestedArtists.join(', ');
    if (named) {
      lines.push(
        intent.onlyRequested
          ? `The user asked for these artists and nobody else: ${named}. Only pick songs they perform.`
          : `The user named these artists: ${named}. Give them a clear presence; the rest of the theme decides the other picks.`
      );
    }
    const cap = balance.cap;
    if (Number.isFinite(cap)) {
      lines.push(
        `Spread the picks over different artists: at most ${cap} song${cap === 1 ? '' : 's'} by the same artist.` +
          (named && balance.requestedCap > cap
            ? ' The artists the user named may have more.'
            : '')
      );
    } else if (
      intent.requestedArtists.length > 1 &&
      Number.isFinite(balance.requestedCap)
    ) {
      lines.push('Divide the picks evenly over the artists the user named.');
    }
    if (Number.isFinite(years.cap)) {
      lines.push(
        `The cards are played by guessing the year, so spread the picks over the years: at most ${years.cap} song${years.cap === 1 ? '' : 's'} from the same year.`
      );
    }
    return lines.length > 0 ? `\n\n${lines.join('\n')}` : '';
  }

  private async curateBatch(
    prompt: string,
    batch: CandidateTrack[],
    remaining: number,
    startYear: number | null,
    endYear: number | null,
    cost: CostTracker,
    spreadGuidance: string = ''
  ): Promise<string[]> {
    // With the release year where it is known: it helps the LLM judge the
    // era, and lets it spread its picks over the years.
    const trackList = batch
      .map((t) => `${t.trackId}\t${t.artist} — ${t.name}${t.year ? ` (${t.year})` : ''}`)
      .join('\n');

    const yearHint =
      startYear !== null || endYear !== null
        ? `\n\nThe user asked for tracks from ${startYear ?? '…'}–${endYear ?? '…'}. The candidates list is already pre-filtered to this range, so focus purely on thematic fit.`
        : '';

    // When the candidate pool is small relative to what's still needed,
    // tighter selectivity just produces an empty playlist. Switch to an
    // inclusive mode that keeps anything reasonable.
    const pool = batch.length;
    const inclusive = pool <= remaining * 1.5;
    const selectivityRule = inclusive
      ? 'INCLUSIVE MODE: the candidate list is small relative to what the user asked for. Include every track that is a reasonable match for the theme. Only drop tracks that clearly do NOT fit. Don\'t filter for "iconic" — ordinary good fits count.'
      : 'SELECTIVE MODE: there are plenty of candidates. Be selective and pick the strongest fits.';

    const result = await this.openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You pick the songs that fit the user theme from a list of candidates. Return only trackId values that match. Never invent trackIds — only use ones from the list provided.\n\n' +
            selectivityRule,
        },
        {
          role: 'user',
          content: `Theme:\n${prompt}${yearHint}${spreadGuidance}\n\nPick up to ${remaining} of the best matches FROM THIS BATCH (don't worry about other batches — they're handled separately). Returning fewer is fine if this batch genuinely doesn't have ${remaining} good matches.\n\nCandidates (tab-separated: trackId\\tartist — title (year)):\n${trackList}`,
        },
      ],
      reasoning_effort: REASONING_EFFORT,
      response_format: {
        type: 'json_schema',
        json_schema: {
            name: 'returnPicks',
            schema: {
              type: 'object',
              properties: {
                trackIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'trackId values selected from the candidates list',
                },
              },
              required: ['trackIds'],
            },
        },
      },
    });

    cost.recordFromResponse(result);

    const content = result?.choices[0]?.message?.content;
    if (!content) return [];

    try {
      const parsed = JSON.parse(content) as {
        trackIds: string[];
      };
      return (parsed.trackIds || []).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async createSpotifyPlaylist(
    jobId: string,
    title: string,
    tracks: CandidateTrack[],
    shortId: string
  ): Promise<{
    success: boolean;
    playlistUrl?: string;
    playlistId?: string;
    error?: string;
    /** Number of unique tracks actually sent to Spotify after our
     *  final defensive dedupe pass. Differs from the LLM's pick count
     *  when two picks shared a Spotify ID or normalised artist+title. */
    addedCount?: number;
  }> {
    this.broadcastProgress(jobId, {
      stage: 'creating_spotify_playlist',
      percentage: 92,
      messageKey: 'submit.aiMsg.creating',
      messageParams: { count: tracks.length },
    });

    // Dedupe using both Spotify track ID AND cleaned artist+title.
    // `cleanTrackName` strips " - Remastered", "(feat. …)", "(Live)",
    // etc. so two recordings that differ only by suffix collapse to
    // one entry — same rule as the summary page's duplicate detection.
    const seenSpotifyId = new Set<string>();
    const seenArtistTitle = new Set<string>();
    const trackIds: string[] = [];
    for (const t of tracks) {
      const sid = t.spotifyLink?.split('/').pop();
      if (!sid) continue;
      if (seenSpotifyId.has(sid)) continue;
      const at = this.dedupeKey(t.artist, t.name);
      if (at && seenArtistTitle.has(at)) continue;
      seenSpotifyId.add(sid);
      if (at) seenArtistTitle.add(at);
      trackIds.push(sid);
    }

    const playlistName = this.buildPlaylistName(title, shortId);
    const result = await this.spotify.createOrUpdatePlaylist(playlistName, trackIds);

    if (!result?.success) {
      return { success: false, error: result?.error || 'Unknown Spotify error' };
    }

    return {
      success: true,
      playlistUrl: result.data?.playlistUrl,
      playlistId: result.data?.playlistId,
      addedCount: trackIds.length,
    };
  }

  private buildPlaylistName(title: string, shortId: string): string {
    const cleaned = (title || '').replace(/\s+/g, ' ').trim() || 'AI Playlist';
    // Title comes from the LLM (or falls back to the user prompt); cap as
    // a safety net in case it ignored the system instruction.
    const short = cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
    return `qrsong! AI — ${short} (AIID: ${shortId})`;
  }

  /**
   * Turn the user's UI locale into a guidance paragraph for the LLM.
   * When the user theme doesn't specify a country/language, this nudges
   * the LLM toward a sensible local + global mix instead of defaulting
   * to US/UK pop. The user can still override by being explicit
   * ("English-only 90s hits"), and the LLM is told as much.
   */
  private describeLocale(locale: string): string {
    const map: Record<string, string> = {
      nl: 'Dutch (Netherlands / Flanders)',
      de: 'German (Germany / Austria / Switzerland)',
      fr: 'French (France / Belgium / Switzerland)',
      es: 'Spanish (Spain and Latin America)',
      it: 'Italian (Italy)',
      pt: 'Portuguese (Portugal / Brazil)',
      pl: 'Polish (Poland)',
      sv: 'Swedish (Sweden)',
      no: 'Norwegian (Norway)',
      da: 'Danish (Denmark)',
      hu: 'Hungarian (Hungary)',
      jp: 'Japanese (Japan)',
      cn: 'Chinese (Mainland China / Taiwan / Hong Kong)',
      en: 'English (UK / US / global)',
    };
    const display = map[locale] || `the "${locale}" locale`;
    if (locale === 'en') {
      // English: no localization bias — keep the catalog global by default.
      return `The user's UI is set to ${display}. Treat this as the default global catalog. Do not over-rotate to UK or US artists.`;
    }
    return `The user's UI is set to ${display}. When the theme does not mention a country or language (e.g. "hits from the 90s", "summer party"), include both ${display} artists AND globally popular artists from the same era/genre. Roughly half-and-half is fine; pick what fits. If the user explicitly limits the scope (e.g. "English-only", "Spanish hits"), honour that instead.`;
  }

  /**
   * 8-char lowercase alphanumeric id, e.g. `a34n234n`. Random-enough for
   * the playlist-name collision purpose and short enough to read.
   */
  private generateShortId(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
  }

  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private broadcastProgress(
    jobId: string,
    data: {
      stage?: any;
      percentage: number;
      message?: string;
      messageKey?: string;
      messageParams?: Record<string, string | number | null | undefined>;
      current?: number;
      total?: number;
      keywords?: string[];
      currentKeyword?: string;
      keywordHits?: number;
      startYear?: number | null;
      endYear?: number | null;
    }
  ) {
    // Mirror the broadcast into the in-flight snapshot so a page reload
    // can resume from the latest state. Zero-hit keywords are silently
    // dropped from the cumulative `keywords` list (same rule the frontend
    // applies live).
    const snap = this.snapshots.get(jobId);
    if (snap) {
      snap.status = 'running';
      if (typeof data.percentage === 'number') snap.percentage = data.percentage;
      if (data.stage) snap.stage = data.stage as string;
      if (data.message) snap.message = data.message;
      if (data.messageKey) {
        snap.messageKey = data.messageKey;
        snap.messageParams = data.messageParams;
      }
      if (typeof data.current === 'number') snap.current = data.current;
      if (typeof data.total === 'number') snap.total = data.total;
      if (data.startYear !== undefined) snap.startYear = data.startYear;
      if (data.endYear !== undefined) snap.endYear = data.endYear;
      if (data.currentKeyword) {
        const hits = typeof data.keywordHits === 'number' ? data.keywordHits : null;
        if (hits === null || hits > 0) {
          if (!snap.keywords.includes(data.currentKeyword)) {
            snap.keywords.push(data.currentKeyword);
          }
          snap.activeWord = data.currentKeyword;
        }
      }
      // Fire-and-forget persistence; intentional no await.
      void this.persistSnapshot(snap);
    }

    const ws = ProgressWebSocketServer.getInstance();
    ws?.broadcastProgress(jobId, SERVICE_TYPE, jobId, data);
  }

  private async persistSnapshot(snap: AIPlaylistSnapshot): Promise<void> {
    snap.updatedAt = Date.now();
    try {
      await this.cache.set(
        aiPlaylistProgressKey(snap.jobId),
        JSON.stringify(snap),
        AI_PLAYLIST_PROGRESS_TTL_SECONDS
      );
    } catch {
      // Best-effort.
    }
  }

  /**
   * Look up the current snapshot for a job — used by the resume endpoint
   * to seed the frontend on page reload mid-generation.
   */
  public async getSnapshot(jobId: string): Promise<AIPlaylistSnapshot | null> {
    try {
      const raw = await this.cache.get(aiPlaylistProgressKey(jobId), false);
      if (!raw) return null;
      return JSON.parse(raw) as AIPlaylistSnapshot;
    } catch {
      return null;
    }
  }

  private broadcastComplete(
    jobId: string,
    data: {
      spotifyPlaylistUrl?: string;
      spotifyPlaylistId?: string;
      requestedCount: number;
      deliveredCount: number;
    }
  ) {
    const ws = ProgressWebSocketServer.getInstance();
    ws?.broadcastComplete(jobId, SERVICE_TYPE, jobId, {
      ...data,
      trackCount: data.deliveredCount,
    });
  }

  private broadcastError(jobId: string, message: string) {
    const ws = ProgressWebSocketServer.getInstance();
    ws?.broadcastError(jobId, SERVICE_TYPE, jobId, message);
  }
}

export default AIPlaylistGenerator;
export type { AIPlaylistJobData };
