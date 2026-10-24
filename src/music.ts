import PrismaInstance from './prisma';
import Logger from './logger';
import axios, { AxiosInstance } from 'axios';
import { color } from 'console-log-colors';
import { AiTasks } from './aiTasks';
import { formatCostUsd } from './llm';
import Cache from './cache';
import { evidenceForReview, gatherYearEvidence } from './yearEvidence';
import type { YearEvidence } from './yearEvidence';

/**
 * The year lookup's question (task yearLookup); scripts/llm-smoke.ts asks it
 * too. `evidence` is what Serper's Google search and Wikipedia gave
 * (src/yearEvidence.ts); null when MusicBrainz, Discogs and Spotify agree and
 * nothing was looked up. `webSearch` is the Anthropic web search the lookup
 * used from 2026-10-12 to 2026-10-24, kept for llm-smoke.ts --web.
 */
export function yearLookupPrompt(
  artist: string,
  title: string,
  mbYear: number,
  discogsYear: number,
  evidence: YearEvidence | null,
  webSearch = false
): string {
  const search = webSearch
    ? 'Search the web once to check the year. Wikipedia and the Discogs page of the original single or album are the best sources. Streaming services often show the year of a remaster, reissue or compilation instead of the original release.\n\n'
    : '';
  return (
    `The song: ${artist} - ${title}\n` +
    'My goal is to find the release year of this song: the year this recording was first released, on a single, an album or a soundtrack, not a later single, remaster, reissue or compilation. Use your own knowledge and the information below.\n\n' +
    `MusicBrainz thinks the release year is ${mbYear}\n` +
    `Discogs thinks the release year is ${discogsYear}\n\n` +
    (evidence ? evidenceText(evidence) : '') +
    search +
    'When evaluating a classical song, we are looking for the year of original composition, not the year of release.\n\n' +
    'What is the release year of this song? Also explain on which information you based your answer.'
  );
}

/** The Google results, Google's panel and the Wikipedia pages, as prompt text. */
function evidenceText(evidence: YearEvidence): string {
  let text = '';
  if (evidence.google.length) {
    text +=
      'What a Google search for the song returned:\n' +
      evidence.google
        .map((r) => `- ${r.title}${r.snippet ? `: ${r.snippet}` : ''} (${r.url})`)
        .join('\n') +
      '\n\n';
  }
  if (evidence.knowledgeGraph) {
    text +=
      "Google's information panel:\n" +
      Object.entries(evidence.knowledgeGraph)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n') +
      '\n\n';
  }
  for (const page of evidence.wikipedia) {
    text += `Wikipedia (${page.lang}), "${page.title}":\n${page.extract}\n`;
    if (page.published.length) text += `Wikidata publication date: ${page.published.join(', ')}\n`;
    if (page.composed.length) text += `Wikidata inception (composed): ${page.composed.join(', ')}\n`;
    text += '\n';
  }
  if (text) {
    text +=
      'Wikipedia and the Discogs page of the original single or album are the best sources. Streaming services often show the year of a remaster, reissue or compilation instead of the original release, and a song can chart years after it first came out.\n\n';
  }
  return text;
}

export class Music {
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private axiosInstance: AxiosInstance;
  private aiTasks = new AiTasks();
  private readonly mbMaxRetries: number = 5;
  private readonly mbMaxRateLimit: number = 1200;
  private readonly discogsMaxRetries: number = 3;
  private readonly discogsMaxRateLimit: number = 1000;
  private cache = Cache.getInstance();
  private mbLastRequestTime: number = 0;
  private discogsLastRequestTime: number = 0;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: 'http://musicbrainz.org/ws/2/',
      headers: {
        'User-Agent': 'QRHit/1.0 (info@rickgroenewegen.nl)',
      },
    });
  }

  public async getReleaseDate(
    id: number,
    isrc: string,
    artist: string,
    title: string,
    spotifyReleaseYear: number
  ): Promise<any> {
    const [mbResult, discogsResult] = await Promise.all([
      this.searchMusicBrainz(isrc, artist, title),
      this.searchDiscogs(artist, title),
    ]);

    // The model reads a Google search (Serper, ~$0.001) and the song's
    // Wikipedia pages (free) unless MusicBrainz, Discogs and Spotify already
    // agree, as they do for about a third of new tracks.
    const sourcesAgree =
      mbResult.year > 0 &&
      mbResult.year === discogsResult.year &&
      discogsResult.year === spotifyReleaseYear;
    const evidence = sourcesAgree ? null : await gatherYearEvidence(artist, title);
    const prompt = yearLookupPrompt(artist, title, mbResult.year, discogsResult.year, evidence);

    // No usable answer (refused, cut off, empty) counts as no year.
    const aiResult = (await this.aiTasks.ask(prompt)) ?? { year: 0 };
    const searchResults = evidence ? evidenceForReview(evidence) : [];

    const weights = {
      ai: 0.5,
      mb: 0.25,
      discogs: 0.25,
    };

    const sources = {
      ai: aiResult.year,
      mb: mbResult.year,
      discogs: discogsResult.year,
    };

    // Calculate weighted average of valid years (excluding 0)
    let totalWeight = 0;
    let weightedSum = 0;

    for (const [source, year] of Object.entries(sources)) {
      if (year && year > 0 && year <= new Date().getFullYear()) {
        weightedSum += year * weights[source as keyof typeof weights];
        totalWeight += weights[source as keyof typeof weights];
      }
    }

    let finalYear = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

    // Calculate standard deviation for valid years (excluding 0)
    const validYears = Object.values(sources).filter(
      (year) => year && year > 0 && year <= new Date().getFullYear()
    );

    let stdDev = 0;
    if (validYears.length > 1) {
      const mean =
        validYears.reduce((sum, year) => sum + year, 0) / validYears.length;
      const squareDiffs = validYears.map((year) => Math.pow(year - mean, 2));
      const avgSquareDiff =
        squareDiffs.reduce((sum, diff) => sum + diff, 0) / squareDiffs.length;
      stdDev = Math.sqrt(avgSquareDiff);
    }

    let standardDeviation = Math.round(stdDev * 100) / 100; // Round to 2 decimal places

    // Rule 1: Spotify is the only source with a usable year. This sits outside
    // the standardDeviation > 1 block below: with no valid AI/MB/Discogs year
    // there is nothing to disagree about, so the deviation is 0 and that block
    // never runs.
    if (
      totalWeight === 0 &&
      spotifyReleaseYear > 0 &&
      spotifyReleaseYear <= new Date().getFullYear()
    ) {
      finalYear = spotifyReleaseYear;
    }

    if (standardDeviation > 1) {
      // Rule 2: If besides Spotify at least 2 other sources have a valid year (>0),
      // and the Spotify year is the smallest of all valid years (>0), use the Spotify year.
      const nonSpotifyYears = [
        mbResult.year,
        discogsResult.year,
        aiResult.year,
      ];
      const validNonSpotifyYears = nonSpotifyYears.filter(
        (year) => year && year > 0 && year <= new Date().getFullYear()
      );
      const allYears = [spotifyReleaseYear, ...nonSpotifyYears];
      const allValidYears = allYears.filter(
        (year) => year && year > 0 && year <= new Date().getFullYear()
      );

      if (
        validNonSpotifyYears.length >= 2 &&
        spotifyReleaseYear > 0 &&
        allValidYears.length > 0 && // Ensure there are valid years to compare
        spotifyReleaseYear === Math.min(...allValidYears)
      ) {
        finalYear = spotifyReleaseYear;
        standardDeviation = 0;
      }

      // Rule 3: If Spotify year equals AI year, use the Spotify year. Veto
      // when MB and Discogs are both present, agree with each other, and
      // point to an earlier year — that combination is too strong a signal
      // of an original release to override automatically, so leave it for
      // manual review.
      const mbDcAgreeEarlier =
        mbResult.year > 0 &&
        discogsResult.year > 0 &&
        mbResult.year === discogsResult.year &&
        mbResult.year < spotifyReleaseYear;

      if (
        spotifyReleaseYear > 0 &&
        spotifyReleaseYear == aiResult.year &&
        !mbDcAgreeEarlier
      ) {
        finalYear = spotifyReleaseYear;
        standardDeviation = 0;
      }

      // Rule 4: If Discogs, MusicBrainz, and AI all agree on the same valid year,
      // trust that consensus over Spotify (which often reflects a re-release
      // or streaming-platform date).
      if (
        discogsResult.year > 0 &&
        mbResult.year > 0 &&
        aiResult.year > 0 &&
        discogsResult.year === mbResult.year &&
        mbResult.year === aiResult.year
      ) {
        finalYear = discogsResult.year;
        standardDeviation = 0;
      }

      // Rule 5: If Spotify, Discogs, MusicBrainz, and AI all agree on the same
      // valid year, that 4-way consensus wins.
      if (
        spotifyReleaseYear > 0 &&
        discogsResult.year > 0 &&
        mbResult.year > 0 &&
        aiResult.year > 0 &&
        spotifyReleaseYear === discogsResult.year &&
        discogsResult.year === mbResult.year &&
        mbResult.year === aiResult.year
      ) {
        finalYear = spotifyReleaseYear;
        standardDeviation = 0;
      }

      // Rule 6: nothing above could decide. If the AI year matches MusicBrainz
      // or Discogs, treat that two-source agreement as enough to settle it.
      // Guarded on the deviation so it only fires when rules 2-5 all missed -
      // every rule that fires zeroes it.
      if (standardDeviation > 1) {
        const currentYear = new Date().getFullYear();
        const aiYearValid = aiResult.year > 0 && aiResult.year <= currentYear;

        if (
          aiYearValid &&
          (aiResult.year === mbResult.year ||
            aiResult.year === discogsResult.year)
        ) {
          finalYear = aiResult.year;
          standardDeviation = 0;
        }
      }
    }

    const fullResult = {
      year: finalYear,
      standardDeviation,
      googleResults: JSON.stringify(searchResults),
      sources: {
        spotify: spotifyReleaseYear,
        mb: mbResult.year,
        ai: aiResult.year,
        openPerplex: 0,
        discogs: discogsResult.year,
      },
    };

    this.logger.log(
      color.blue.bold(
        `[SP: ${color.white.bold(spotifyReleaseYear)}] [MB: ${color.white.bold(
          mbResult.year
        )}] [DC: ${color.white.bold(
          discogsResult.year
        )}] [AI: ${color.white.bold(
          aiResult.year
        )}] for track ${color.white.bold(artist)} - ${color.white.bold(
          title
        )} [DV: ${color.white.bold(
          fullResult.standardDeviation
        )}] Final year: ${color.white.bold(finalYear)} [AI cost: ${color.white.bold(
          formatCostUsd(aiResult?.costUsd ?? 0)
        )}]` +
          (evidence
            ? ` [Google: ${color.white.bold(evidence.google.length)}] [Wiki: ${color.white.bold(
                evidence.wikipedia.map((p) => p.lang).join(',') || '-'
              )}]`
            : '')
      )
    );

    return fullResult;
  }

  public async searchMusicBrainz(
    isrc: string,
    artist: string,
    title: string
  ): Promise<{ year: number; source: string }> {
    // Only do ISRC lookup if we have a valid ISRC
    if (isrc && isrc.trim()) {
      let result = await this.prisma.isrc.findUnique({
        where: {
          isrc: isrc,
        },
      });

      if (result && result.year) {
        return { year: result.year, source: 'isrc_cache' };
      }
    }

    // Fall back to artist/title search
    let apiResult = await this.getReleaseDateFromMusicBrainzAPI(
      isrc,
      artist,
      title,
      'artistAndTitle'
    );

    if (apiResult.year > 0) {
      return { year: apiResult.year, source: 'mb_api_artist_title' };
    }

    return { year: 0, source: '' };
  }

  private async rateLimitDelay(): Promise<void> {
    const timeSinceLastRequest = Date.now() - this.mbLastRequestTime;
    const delay =
      timeSinceLastRequest < this.mbMaxRateLimit
        ? this.mbMaxRateLimit - timeSinceLastRequest
        : 0;

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  public async getReleaseDateFromMusicBrainzAPI(
    isrc: string,
    artist: string,
    title: string,
    mode: string = 'isrc'
  ): Promise<{ year: number; source: string }> {
    // If mode is 'isrc' but we don't have a valid ISRC, return early
    if (mode === 'isrc' && (!isrc || !isrc.trim())) {
      return { year: 0, source: '' };
    }

    let retryCount = 0;
    while (retryCount < this.mbMaxRetries) {
      await this.rateLimitDelay();
      await this.cache.rateLimit('musicbrainz:rateLimit', this.mbMaxRateLimit);
      try {
        let url = `recording/?query=isrc:${isrc}&fmt=json`;
        if (mode === 'artistAndTitle') {
          url = `recording?query=artist:"${artist}"+AND+recording:"${title}"&fmt=json`;
        }
        const response = await this.axiosInstance.get(url);
        const recordings = response.data.recordings.filter(
          (recording: any) => recording.score >= 95
        );
        let earliestDate: string | null = null;

        if (recordings && recordings.length > 0) {
          earliestDate = recordings.reduce(
            (earliest: string | null, recording: any) => {
              const releaseDate = recording['first-release-date'] || null;
              return releaseDate && (!earliest || releaseDate < earliest)
                ? releaseDate
                : earliest;
            },
            null
          );
        }

        if (!earliestDate) {
          return { year: 0, source: '' };
        }
        return { year: parseInt(earliestDate.split('-')[0]), source: 'api' };
      } catch (error: any) {
        this.logger.log(
          color.yellow(
            'Failed to fetch data from MusicBrainz API! Try: ' +
              (retryCount + 1)
          )
        );
        retryCount++;
      }
    }
    return { year: 0, source: '' };
  }

  private async searchDiscogs(
    artist: string,
    title: string
  ): Promise<{ year: number; source: string }> {
    let retryCount = 0;
    const discogsToken = process.env['DISCOGS_TOKEN'];

    if (!discogsToken) {
      this.logger.log(
        color.red('Discogs token not found in environment variables')
      );
      return { year: 0, source: '' };
    }

    while (retryCount < this.discogsMaxRetries) {
      const timeSinceLastRequest = Date.now() - this.discogsLastRequestTime;
      const delay =
        timeSinceLastRequest < this.discogsMaxRateLimit
          ? this.discogsMaxRateLimit - timeSinceLastRequest
          : 0;

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        const response = await axios.get(
          'https://api.discogs.com/database/search',
          {
            params: {
              artist: artist,
              track: title,
              type: 'release',
              token: discogsToken,
            },
            headers: {
              'User-Agent': 'QRHit/1.0 (info@rickgroenewegen.nl)',
            },
          }
        );

        this.discogsLastRequestTime = Date.now();

        if (response.data.results && response.data.results.length > 0) {
          // Get all valid years from the results
          const years = response.data.results
            .map((release: any) => parseInt(release.year))
            .filter(
              (year: number) =>
                !isNaN(year) && year > 0 && year <= new Date().getFullYear()
            );

          if (years.length > 0) {
            const earliestYear = Math.min(...years);
            return { year: earliestYear, source: 'discogs' };
          }
        }

        return { year: 0, source: '' };
      } catch (error: any) {
        this.logger.log(
          color.yellow(
            `Failed to fetch data from Discogs API! Try: ${retryCount + 1}`
          )
        );
        retryCount++;
      }
    }

    return { year: 0, source: '' };
  }
}
