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
const MODEL = 'gpt-5.4-mini';
const KEYWORD_LIMIT = 50;
const PER_KEYWORD_LIMIT = 50;
const CURATION_BATCH_SIZE = 100;

interface CandidateTrack {
  id: number;
  trackId: string;
  artist: string;
  name: string;
  spotifyLink: string;
}

/** Which column(s) a keyword should be matched against. */
type KeywordTarget = 'any' | 'artist' | 'title';

interface SearchKeyword {
  value: string;
  target: KeywordTarget;
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
   * older than one week which were never purchased (i.e. their Spotify
   * playlistId never made it into our `playlists` table). Only the
   * cluster primary on the main server (or dev) runs the cron so we
   * don't multi-fire across workers/servers.
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
   *   • are at least 7 days old,
   *   • completed successfully (status='success'),
   *   • have a Spotify playlist ID we still know about,
   *   • whose Spotify playlist ID is NOT referenced by any `playlists`
   *     row (i.e. nobody bought them).
   * Delete each from the app-owned Spotify account and mark the
   * AISearch row so we don't try again.
   */
  public async cleanupUnpurchasedPlaylists(): Promise<{
    scanned: number;
    deleted: number;
    skipped: number;
    errors: number;
  }> {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
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
        const playlistRow = await this.prisma.playlist.findUnique({
          where: { playlistId: spId },
          select: { id: true },
        });
        if (playlistRow) {
          // Purchased (or imported through some other flow) — leave alone.
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

    try {
      // ── Step 1/4: keyword brainstorm ────────────────────────────
      this.logger.log(
        color.blue.bold(
          `[AI] ${white.bold(jobId)} step 1/4 — brainstorming keywords`
        )
      );
      const stepT1 = Date.now();
      const { keywords, startYear, endYear, title } = await this.thinkKeywords(
        jobId,
        prompt,
        locale,
        cost
      );
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
        const known = new Set(candidates.map((c) => c.trackId));
        for (const c of extraCandidates) {
          if (!known.has(c.trackId)) {
            candidates.push(c);
            known.add(c.trackId);
          }
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
        cost
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

      await this.finalizeAISearch(jobId, {
        status: 'success',
        deliveredCount: picked.length,
        keywords: keywords.map((k) => k.value),
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
        deliveredCount: picked.length,
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
            'You analyze a user-supplied music theme and return: (1) up to 50 search keywords, and (2) an optional release-or-composition-year range if the user mentioned a specific time period.\n\nKEYWORD RULES — CRITICAL:\nThe keywords are used to run SQL `LIKE %keyword%` against ONLY two columns: `artist` (the performing artist name) and `name` (the song title). They are NOT used against any genre, mood, decade, or tag column. Therefore:\n  • DO return concrete artist or band names that fit the theme (e.g. "Marco Borsato", "2 Unlimited", "Vengaboys", "BZN").\n  • DO return distinctive words or phrases likely to appear in a relevant SONG TITLE (e.g. "love", "summer", "Christmas", "tonight" — only when the user theme clearly implies them, like a christmas or summer playlist).\n  • DO NOT return genre or sub-genre names ("Eurodance", "synthpop", "house", "happy hardcore", "R&B", "pop", "rock", "nederpop"). These will not match anything.\n  • DO NOT return moods, descriptors, or marketing tags ("nostalgia", "party", "upbeat", "club", "catchy", "radio hits", "hit singles", "mainstream", "Top 40", "boy bands", "girl groups").\n  • DO NOT return decade words or era labels ("90s", "1990s", "nineties") — the year range below already covers that.\n  • DO NOT return country/language tags ("Dutch artists", "Holland", "NL", "Nederlandse hits") — instead return artists from that country.\nUse the theme (genre/era/mood/country) internally to pick which artists belong in the list; do not echo the descriptors as keywords.\n\nCOLUMN INTENT — IMPORTANT:\nYou return three keyword buckets: `keywords` (search both columns), `artistKeywords` (search artist only), `titleKeywords` (search song title only). Choose the right bucket:\n  • When the user explicitly says a word should be IN THE TITLE only ("songs with `soul` in the title", "tracks called `love`", "anything with `night` in the name") → put it in `titleKeywords`. Putting it in `keywords` would also match every artist whose name contains it — the opposite of what the user asked.\n  • When the user clearly wants songs BY an artist or in that artist\'s style and the artist\'s name could ambiguously appear in unrelated song titles → prefer `artistKeywords`.\n  • When the user explicitly says a word should match EITHER the title OR the artist ("songs that mention `love` anywhere", "anything with `soul` in the title or the artist name") → put it in `keywords` (both columns). This is also the right bucket for broad themes where you don\'t need to narrow scope.\n\nLOCALE BIAS — IMPORTANT:\n' +
            localeHint +
            '\n\nLIST SIZE — IMPORTANT:\n50 is the maximum, not a target. Match the breadth of the user theme:\n  • If the user names ONE artist ("Taylor Swift", "Bach") → return just that one keyword. Do not invent similar artists they did not ask for.\n  • If the user names a few specific artists → return only those artists.\n  • If the user describes a broad theme ("Dutch 90s hits", "summer beach party") → return a focused 15–35 artists (and a few title words if the theme implies them).\n  • Never pad the list to look thorough. Returning 5 right keywords beats returning 50 with noise.\n\nYear-range rules: only set startYear/endYear if the theme clearly implies a time period (e.g. "80s rock" → 1980-1989, "90s" → 1990-1999, "early 2000s" → 2000-2005, "from 1975" → 1975-1975, "songs from the 60s and 70s" → 1960-1979, "2010 onwards" → 2010-current year, "renaissance music" → 1400-1600, "medieval chants" → 800-1400, "baroque" → 1600-1750). The catalog includes classical compositions dating back roughly to year 1000, so historic ranges are valid. If no year hint is present in the theme, leave both null. Never invent a range to be helpful — only use it if the user explicitly references a year, decade, or era.',
        },
        {
          role: 'user',
          content: `Theme:\n${prompt}\n\nUser locale: ${locale}\n\nReturn as many keywords as the theme genuinely warrants (1 if a single artist, more for broad themes; max ${KEYWORD_LIMIT}) and a year range only if explicitly implied.`,
        },
      ],
      tool_choice: { type: 'function', function: { name: 'returnKeywords' } },
      tools: [
        {
          type: 'function',
          function: {
            name: 'returnKeywords',
            parameters: {
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
              },
              required: [
                'title',
                'keywords',
                'artistKeywords',
                'titleKeywords',
                'startYear',
                'endYear',
              ],
            },
          },
        },
      ],
    });

    cost.recordFromResponse(result);

    const toolCall = result?.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') {
      throw new Error('Keyword generation returned no tool call');
    }

    let parsed: {
      keywords?: string[];
      artistKeywords?: string[];
      titleKeywords?: string[];
      startYear: number | null;
      endYear: number | null;
      title?: string;
    };
    try {
      parsed = JSON.parse(toolCall.function.arguments as string);
    } catch (e) {
      throw new Error('Failed to parse keyword tool call arguments');
    }

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

    return { keywords, startYear, endYear, title };
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
      tool_choice: { type: 'function', function: { name: 'returnMoreKeywords' } },
      tools: [
        {
          type: 'function',
          function: {
            name: 'returnMoreKeywords',
            parameters: {
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
      ],
    });

    cost.recordFromResponse(result);

    const toolCall = result?.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') return [];
    let parsed: { keywords: string[] };
    try {
      parsed = JSON.parse(toolCall.function.arguments as string);
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

    const merged = new Map<string, CandidateTrack>();
    for (const bucket of buckets) {
      for (const row of bucket) {
        if (!merged.has(row.trackId)) {
          merged.set(row.trackId, row);
        }
      }
    }

    const candidates = Array.from(merged.values());

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

    return this.prisma.$queryRaw<CandidateTrack[]>(Prisma.sql`
      SELECT id, trackId, artist, name, spotifyLink
      FROM tracks
      WHERE spotifyLink IS NOT NULL
        AND spotifyLinkIgnored = 0
        AND ${columnFilter}
        ${yearFilter}
      ORDER BY RAND()
      LIMIT ${PER_KEYWORD_LIMIT}
    `);
  }

  private async curate(
    jobId: string,
    prompt: string,
    candidates: CandidateTrack[],
    target: number,
    startYear: number | null,
    endYear: number | null,
    cost: CostTracker
  ): Promise<CandidateTrack[]> {
    if (candidates.length === 0) return [];

    const picks = new Map<string, CandidateTrack>();
    const byTrackId = new Map<string, CandidateTrack>();
    for (const c of candidates) byTrackId.set(c.trackId, c);

    // Shuffle candidates so the LLM sees variety in each batch.
    const shuffled = this.shuffle([...candidates]);
    const totalBatches = Math.max(
      1,
      Math.ceil(shuffled.length / CURATION_BATCH_SIZE)
    );

    for (let i = 0; i < shuffled.length; i += CURATION_BATCH_SIZE) {
      const batch = shuffled.slice(i, i + CURATION_BATCH_SIZE);
      const batchIndex = Math.floor(i / CURATION_BATCH_SIZE) + 1;

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

      const remaining = target - picks.size;
      if (remaining <= 0) break;

      const picked = await this.curateBatch(
        prompt,
        batch,
        remaining,
        startYear,
        endYear,
        cost
      );
      const beforeSize = picks.size;
      for (const tid of picked) {
        const row = byTrackId.get(tid);
        if (row && !picks.has(tid)) {
          picks.set(tid, row);
          if (picks.size >= target) break;
        }
      }
      this.logger.log(
        color.blue.bold(
          `[AI]   curate batch ${white.bold(`${batchIndex}/${totalBatches}`)} → +${white.bold(
            (picks.size - beforeSize).toString()
          )} picks (total ${white.bold(`${picks.size}/${target}`)})`
        )
      );

      if (picks.size >= target) break;
    }

    return Array.from(picks.values()).slice(0, target);
  }

  private async curateBatch(
    prompt: string,
    batch: CandidateTrack[],
    remaining: number,
    startYear: number | null,
    endYear: number | null,
    cost: CostTracker
  ): Promise<string[]> {
    const trackList = batch
      .map((t) => `${t.trackId}\t${t.artist} — ${t.name}`)
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
          content: `Theme:\n${prompt}${yearHint}\n\nWe still need up to ${remaining} more tracks.\n\nCandidates (tab-separated: trackId\\tartist — title):\n${trackList}`,
        },
      ],
      tool_choice: { type: 'function', function: { name: 'returnPicks' } },
      tools: [
        {
          type: 'function',
          function: {
            name: 'returnPicks',
            parameters: {
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
      ],
    });

    cost.recordFromResponse(result);

    const toolCall = result?.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') return [];

    try {
      const parsed = JSON.parse(toolCall.function.arguments as string) as {
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
  ): Promise<{ success: boolean; playlistUrl?: string; playlistId?: string; error?: string }> {
    this.broadcastProgress(jobId, {
      stage: 'creating_spotify_playlist',
      percentage: 92,
      messageKey: 'submit.aiMsg.creating',
      messageParams: { count: tracks.length },
    });

    // Dedupe by *Spotify* track ID — two rows in our `tracks` table can
    // share a `spotifyLink` (different internal IDs, same Spotify URI),
    // which would otherwise add duplicates to the playlist and trigger
    // the "N tracks were duplicate" warning on the summary page.
    const seen = new Set<string>();
    const trackIds: string[] = [];
    for (const t of tracks) {
      const sid = t.spotifyLink?.split('/').pop();
      if (!sid) continue;
      if (seen.has(sid)) continue;
      seen.add(sid);
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
