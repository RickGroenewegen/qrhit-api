import { color } from 'console-log-colors';
import * as ExcelJS from 'exceljs';
import Bottleneck from 'bottleneck';
import Logger from './logger';
import PrismaInstance from './prisma';
import Spotify from './spotify';
import Cache from './cache';
import Utils from './utils';

// Snapshot of an in-flight or finished job. Kept in memory for fast polling
// and mirrored to Redis so a status poll still resolves after a restart.
const JOB_KEY_PREFIX = 'playlistFromExcel';
const JOB_TTL_SECONDS = 6 * 3600;
const jobKey = (jobId: string) => `${JOB_KEY_PREFIX}:${jobId}`;

// Spotify search budget. The Web API tolerates roughly 3 requests/second
// per client on a rolling 30 second window before it answers 429; stay
// well under that so this admin job never pushes the public search into
// the RateLimitManager fallback.
const SPOTIFY_MIN_TIME_MS = 400;
const SPOTIFY_MAX_RETRY_WAIT_MS = 60 * 1000;

export type PlaylistFromExcelStage =
  | 'parsing'
  | 'database'
  | 'spotify'
  | 'creating_playlist'
  | 'done';

export interface PlaylistFromExcelRow {
  row: number;
  artist: string;
  title: string;
}

export interface PlaylistFromExcelSnapshot {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  stage: PlaylistFromExcelStage;
  playlistName: string;
  total: number;
  processed: number;
  foundInDb: number;
  foundOnSpotify: number;
  notFound: PlaylistFromExcelRow[];
  playlistId?: string;
  playlistUrl?: string;
  addedCount?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface PlaylistFromExcelUpload {
  rows: PlaylistFromExcelRow[];
  filename: string;
  playlistName: string;
  artistColumn: number;
  titleColumn: number;
  hasHeader: boolean;
}

interface MatchedTrack {
  row: PlaylistFromExcelRow;
  trackId: string;
  source: 'db' | 'spotify';
}

/** Shape of one item in Spotify.searchTracks()'s formatted result. */
interface SpotifySearchTrack {
  id: string;
  name: string;
  artist: string;
  artists?: string[];
}

class PlaylistFromExcel {
  private static instance: PlaylistFromExcel;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private spotify = Spotify.getInstance();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private jobs = new Map<string, PlaylistFromExcelSnapshot>();
  private limiter = new Bottleneck({
    minTime: SPOTIFY_MIN_TIME_MS,
    maxConcurrent: 1,
  });

  private constructor() {}

  public static getInstance(): PlaylistFromExcel {
    if (!PlaylistFromExcel.instance) {
      PlaylistFromExcel.instance = new PlaylistFromExcel();
    }
    return PlaylistFromExcel.instance;
  }

  /**
   * Reads the multipart upload, parses the sheet and returns the artist/title
   * rows. Column indexes are 0-based as entered in the admin modal; exceljs
   * is 1-based, so they are shifted here.
   */
  public async parseUpload(parts: AsyncIterable<any>): Promise<PlaylistFromExcelUpload> {
    let fileBuffer: Buffer | null = null;
    let filename = 'upload.xlsx';
    let artistColumn = 0;
    let titleColumn = 1;
    let hasHeader = true;
    let playlistName = '';

    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
        filename = part.filename || filename;
        continue;
      }
      const value = String(part.value ?? '').trim();
      switch (part.fieldname) {
        case 'artistColumn':
          artistColumn = parseInt(value, 10);
          break;
        case 'titleColumn':
          titleColumn = parseInt(value, 10);
          break;
        case 'hasHeader':
          hasHeader = value === 'true';
          break;
        case 'playlistName':
          playlistName = value;
          break;
      }
    }

    if (!fileBuffer) {
      throw new Error('No file uploaded');
    }
    if (!Number.isInteger(artistColumn) || artistColumn < 0) {
      throw new Error('Artist column must be a 0-based column index');
    }
    if (!Number.isInteger(titleColumn) || titleColumn < 0) {
      throw new Error('Title column must be a 0-based column index');
    }
    if (artistColumn === titleColumn) {
      throw new Error('Artist and title column cannot be the same');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as any);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error('No worksheet found in Excel file');
    }

    const rows: PlaylistFromExcelRow[] = [];
    const startRow = hasHeader ? 2 : 1;
    const lastRow = worksheet.lastRow?.number || 0;
    for (let rowNumber = startRow; rowNumber <= lastRow; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const artist = this.cellToString(row.getCell(artistColumn + 1).value);
      const title = this.cellToString(row.getCell(titleColumn + 1).value);
      if (!artist || !title) continue;
      rows.push({ row: rowNumber, artist, title });
    }

    if (rows.length === 0) {
      throw new Error('No rows with both an artist and a title were found');
    }

    if (!playlistName) {
      const base = filename.replace(/\.(xlsx|xlsm|xls)$/i, '').trim() || 'Excel import';
      playlistName = `${base} (${new Date().toISOString().slice(0, 10)})`;
    }

    return { rows, filename, playlistName, artistColumn, titleColumn, hasHeader };
  }

  /**
   * Registers the job and starts the work in the background. The caller
   * replies with the jobId straight away so CloudFront's 30 second limit is
   * never in play; the admin UI polls getJob() for progress.
   */
  public startJob(upload: PlaylistFromExcelUpload): string {
    const jobId = `pfx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot: PlaylistFromExcelSnapshot = {
      jobId,
      status: 'running',
      stage: 'database',
      playlistName: upload.playlistName,
      total: upload.rows.length,
      processed: 0,
      foundInDb: 0,
      foundOnSpotify: 0,
      notFound: [],
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, snapshot);
    void this.persist(snapshot);

    this.logger.log(
      color.blue.bold(
        `Playlist from Excel ${color.white.bold(jobId)}: ${color.white.bold(
          upload.rows.length
        )} rows from ${color.white.bold(upload.filename)} -> "${color.white.bold(
          upload.playlistName
        )}"`
      )
    );

    this.run(jobId, upload).catch((error: any) => {
      this.logger.log(
        color.red.bold(
          `Playlist from Excel ${color.white.bold(jobId)} crashed: ${error?.message || error}`
        )
      );
      this.fail(snapshot, error?.message || 'Unknown error');
    });

    return jobId;
  }

  public async getJob(jobId: string): Promise<PlaylistFromExcelSnapshot | null> {
    const inMemory = this.jobs.get(jobId);
    if (inMemory) return inMemory;
    try {
      const raw = await this.cache.get(jobKey(jobId), false);
      return raw ? (JSON.parse(raw) as PlaylistFromExcelSnapshot) : null;
    } catch {
      return null;
    }
  }

  private async run(jobId: string, upload: PlaylistFromExcelUpload): Promise<void> {
    const snapshot = this.jobs.get(jobId)!;
    const matched: MatchedTrack[] = [];
    const unmatched: PlaylistFromExcelRow[] = [];

    // Phase 1: our own tracks table.
    snapshot.stage = 'database';
    for (const row of upload.rows) {
      const trackId = await this.findInDatabase(row);
      if (trackId) {
        matched.push({ row, trackId, source: 'db' });
        snapshot.foundInDb++;
      } else {
        unmatched.push(row);
      }
      snapshot.processed++;
      if (snapshot.processed % 25 === 0) await this.persist(snapshot);
    }
    this.logger.log(
      color.blue.bold(
        `Playlist from Excel ${color.white.bold(jobId)}: ${color.white.bold(
          snapshot.foundInDb
        )} / ${color.white.bold(upload.rows.length)} found in database, ${color.white.bold(
          unmatched.length
        )} to search on Spotify`
      )
    );

    // Phase 2: Spotify search for the rest, throttled.
    snapshot.stage = 'spotify';
    snapshot.processed = 0;
    snapshot.total = unmatched.length;
    await this.persist(snapshot);
    for (const row of unmatched) {
      const trackId = await this.findOnSpotify(jobId, row);
      if (trackId) {
        matched.push({ row, trackId, source: 'spotify' });
        snapshot.foundOnSpotify++;
      } else {
        snapshot.notFound.push(row);
      }
      snapshot.processed++;
      if (snapshot.processed % 10 === 0) await this.persist(snapshot);
    }

    // Keep sheet order, drop duplicate Spotify ids.
    matched.sort((a, b) => a.row.row - b.row.row);
    const seen = new Set<string>();
    const trackIds: string[] = [];
    for (const m of matched) {
      if (seen.has(m.trackId)) continue;
      seen.add(m.trackId);
      trackIds.push(m.trackId);
    }

    if (trackIds.length === 0) {
      this.fail(snapshot, 'None of the rows could be matched to a Spotify track');
      return;
    }

    // Phase 3: create (or refresh) the playlist in our own Spotify account.
    snapshot.stage = 'creating_playlist';
    snapshot.total = upload.rows.length;
    snapshot.processed = upload.rows.length;
    await this.persist(snapshot);
    const result = await this.spotify.createOrUpdatePlaylist(upload.playlistName, trackIds);
    if (!result?.success) {
      this.fail(snapshot, result?.error || 'Spotify refused to create the playlist');
      return;
    }

    snapshot.stage = 'done';
    snapshot.status = 'completed';
    snapshot.playlistId = result.data?.playlistId;
    snapshot.playlistUrl = result.data?.playlistUrl;
    snapshot.addedCount = trackIds.length;
    snapshot.finishedAt = Date.now();
    await this.persist(snapshot);

    this.logger.log(
      color.green.bold(
        `Playlist from Excel ${color.white.bold(jobId)}: playlist ${color.white.bold(
          snapshot.playlistUrl || snapshot.playlistId || ''
        )} created with ${color.white.bold(trackIds.length)} tracks (${color.white.bold(
          snapshot.foundInDb
        )} db, ${color.white.bold(snapshot.foundOnSpotify)} spotify, ${color.white.bold(
          snapshot.notFound.length
        )} not found)`
      )
    );
  }

  /**
   * Exact normalized match first, then a looser match on the cleaned title
   * (suffixes like " - Remastered" and "(feat. …)" stripped) so a sheet that
   * says "Bohemian Rhapsody" still hits "Bohemian Rhapsody - Remastered 2011".
   */
  private async findInDatabase(row: PlaylistFromExcelRow): Promise<string | null> {
    const artist = row.artist.toLowerCase().trim();
    const title = row.title.toLowerCase().trim();

    const exact = await this.prisma.$queryRaw<{ trackId: string }[]>`
      SELECT trackId
      FROM tracks
      WHERE LOWER(TRIM(artist)) = ${artist}
        AND LOWER(TRIM(name)) = ${title}
      ORDER BY manuallyChecked DESC, id ASC
      LIMIT 1
    `;
    if (exact.length > 0) return exact[0].trackId;

    const cleanedTitle = this.utils.cleanTrackName(row.title).toLowerCase().trim();
    const primaryArtist = this.primaryArtist(row.artist).toLowerCase();
    if (!cleanedTitle || !primaryArtist) return null;

    const loose = await this.prisma.$queryRaw<{ trackId: string; artist: string; name: string }[]>`
      SELECT trackId, artist, name
      FROM tracks
      WHERE LOWER(artist) LIKE ${`%${primaryArtist}%`}
        AND LOWER(name) LIKE ${`${cleanedTitle}%`}
      ORDER BY manuallyChecked DESC, id ASC
      LIMIT 10
    `;
    for (const candidate of loose) {
      const candidateTitle = this.utils.cleanTrackName(candidate.name).toLowerCase().trim();
      if (candidateTitle === cleanedTitle) return candidate.trackId;
    }
    return null;
  }

  /**
   * One throttled Spotify search per row (a second, field-filtered one only
   * when the plain query gives nothing usable). A hit must agree on BOTH the
   * title and one of the credited artists: a Bruno Mars track with another
   * title, or "Billionaire" by someone else, is not a match. Credited artists
   * include featured ones, so "Billionaire" (Travie McCoy feat. Bruno Mars)
   * still matches a sheet that lists Bruno Mars.
   * 429s bubble up as a retryAfter and pause the whole loop for that long.
   */
  private async findOnSpotify(jobId: string, row: PlaylistFromExcelRow): Promise<string | null> {
    const cleanedTitle = this.utils.cleanTrackName(row.title);
    const primaryArtist = this.primaryArtist(row.artist);
    const queries = [
      `${cleanedTitle} ${primaryArtist}`,
      `track:"${cleanedTitle}" artist:"${primaryArtist}"`,
    ];

    for (const query of queries) {
      const tracks = await this.searchWithBackoff(jobId, query);
      const hit = this.pickCandidate(tracks, row);
      if (hit) return hit.id;
    }
    return null;
  }

  /**
   * Best candidate in Spotify's result order: exact title + artist first,
   * then a title that only differs by a suffix Spotify kept (e.g.
   * "Scatman (Ski-Ba-Bop-Ba-Dop-Bop)"). Nothing is accepted on artist alone.
   */
  private pickCandidate(
    tracks: SpotifySearchTrack[],
    row: PlaylistFromExcelRow
  ): SpotifySearchTrack | null {
    const wantedTitle = this.normalize(this.utils.cleanTrackName(row.title));
    if (!wantedTitle) return null;

    let looseHit: SpotifySearchTrack | null = null;
    for (const track of tracks) {
      const credited = track.artists?.length ? track.artists : [track.artist];
      if (!credited.some((a) => this.artistMatches(a, row.artist))) continue;

      const candidateTitle = this.normalize(this.utils.cleanTrackName(track.name));
      if (candidateTitle === wantedTitle) return track;
      if (!looseHit && this.titleLooselyMatches(candidateTitle, wantedTitle)) {
        looseHit = track;
      }
    }
    return looseHit;
  }

  private titleLooselyMatches(candidate: string, wanted: string): boolean {
    const shorter = candidate.length < wanted.length ? candidate : wanted;
    if (shorter.length < 4) return false;
    return candidate.startsWith(wanted) || wanted.startsWith(candidate);
  }

  private async searchWithBackoff(jobId: string, query: string): Promise<SpotifySearchTrack[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.limiter.schedule(() => this.spotify.searchTracks(query, 10));
      if (result?.success) {
        return result.data?.tracks || [];
      }
      const retryAfter = Number(result?.retryAfter);
      if (!retryAfter || Number.isNaN(retryAfter)) {
        return [];
      }
      const waitMs = Math.min(retryAfter * 1000 + 500, SPOTIFY_MAX_RETRY_WAIT_MS);
      this.logger.log(
        color.yellow.bold(
          `Playlist from Excel ${color.white.bold(jobId)}: Spotify rate limit, waiting ${color.white.bold(
            waitMs
          )} ms before retrying "${color.white.bold(query)}"`
        )
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return [];
  }

  /**
   * True when any artist named in the sheet cell equals (or contains, or is
   * contained by) any artist named in the candidate. Both sides may be a
   * list like "A feat. B" or "A & B".
   */
  private artistMatches(candidate: string, wanted: string): boolean {
    const candidates = this.splitArtists(candidate).map((a) => this.normalize(a)).filter(Boolean);
    const wanteds = this.splitArtists(wanted).map((a) => this.normalize(a)).filter(Boolean);
    return wanteds.some((w) =>
      candidates.some((c) => c === w || (w.length >= 3 && c.includes(w)) || (c.length >= 3 && w.includes(c)))
    );
  }

  /** "Artist feat. Other", "Artist & Other", "Artist, Other" -> "Artist". */
  private primaryArtist(artist: string): string {
    return this.splitArtists(artist)[0] || '';
  }

  private splitArtists(artist: string): string[] {
    return artist
      .split(/\s+(?:feat\.?|featuring|ft\.?|with|x|vs\.?|&)\s+|\s*[,\/]\s*/i)
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
  }

  private normalize(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/^the\s+/, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  private cellToString(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const v = value as any;
      if (Array.isArray(v.richText)) {
        return v.richText.map((part: any) => part.text || '').join('').trim();
      }
      if (v.text !== undefined) return this.cellToString(v.text);
      if (v.result !== undefined) return this.cellToString(v.result);
      if (v.hyperlink !== undefined && v.text === undefined) return String(v.hyperlink).trim();
    }
    return String(value).trim();
  }

  private fail(snapshot: PlaylistFromExcelSnapshot, error: string): void {
    snapshot.status = 'failed';
    snapshot.error = error;
    snapshot.finishedAt = Date.now();
    void this.persist(snapshot);
  }

  private async persist(snapshot: PlaylistFromExcelSnapshot): Promise<void> {
    try {
      await this.cache.set(jobKey(snapshot.jobId), JSON.stringify(snapshot), JOB_TTL_SECONDS);
    } catch (error: any) {
      this.logger.log(
        color.yellow.bold(`Playlist from Excel: could not persist job snapshot: ${error?.message}`)
      );
    }
    if (snapshot.status !== 'running') {
      // Keep finished jobs in memory for a while so the last polls are cheap.
      setTimeout(() => this.jobs.delete(snapshot.jobId), 15 * 60 * 1000).unref?.();
    }
  }
}

export default PlaylistFromExcel;
