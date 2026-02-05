import Logger from './logger';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import PDF from './pdf';
import Translation from './translation';
import Utils from './utils';
import CacheInstance from './cache';
import PushoverClient from './pushover';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';

export interface BingoTrack {
  id: number;
  trackId: string;
  name: string;
  artist: string;
  year: number;
  bingoNumber?: number;
}

export interface BingoCell {
  track: BingoTrack | null; // null = free space
  isFreeSpace: boolean;
}

export interface BingoSheet {
  round: number;
  sheetNumber: number; // Sheet within the round (1 to contestants)
  grid: BingoCell[][]; // 5x5 grid
}

export interface BingoValidationResult {
  valid: boolean;
  sheetsNeeded: number;
  tracksNeeded: number; // Ideal unique tracks per round (24)
  totalTracksPerRound: number;
  warning?: string;
}

export interface BingoGenerateConfig {
  contestants: number;
  rounds: number;
  duration?: number; // Optional, for display purposes
}

export interface BingoGenerateResult {
  success: boolean;
  downloadUrl?: string;
  error?: string;
}

interface TrackRow {
  id: number;
  trackId: string;
  name: string;
  artist: string;
  year: number | null;
  trackOrder: number;
}

class Bingo {
  private static instance: Bingo;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private pdf = new PDF();
  private translation = new Translation();
  private utils = new Utils();
  private cache = CacheInstance.getInstance();
  private pushover = new PushoverClient();

  private constructor() {}

  public static getInstance(): Bingo {
    if (!Bingo.instance) {
      Bingo.instance = new Bingo();
    }
    return Bingo.instance;
  }

  /**
   * Fisher-Yates shuffle algorithm
   */
  private shuffle<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Validate bingo configuration and calculate requirements
   */
  public validateConfig(
    trackCount: number,
    contestants: number,
    rounds: number
  ): BingoValidationResult {
    const sheetsNeeded = contestants * rounds;
    const tracksNeeded = 24 * rounds; // Ideal: 24 unique tracks per round
    const totalTracksPerRound = 24; // Each sheet needs 24 tracks (5x5 - 1 free space)

    let warning: string | undefined;

    if (trackCount < 75) {
      return {
        valid: false,
        sheetsNeeded,
        tracksNeeded,
        totalTracksPerRound,
        warning: `Minimum 75 tracks required for Music Bingo. Current: ${trackCount}`,
      };
    }

    // If we don't have enough unique tracks for ideal distribution
    if (trackCount < tracksNeeded) {
      warning = `For ${rounds} rounds with maximum variety, ${tracksNeeded} unique tracks are recommended. With ${trackCount} tracks available, some songs will repeat across rounds.`;
    }

    return {
      valid: true,
      sheetsNeeded,
      tracksNeeded,
      totalTracksPerRound,
      warning,
    };
  }

  /**
   * Create an empty 5x5 bingo grid with center free space
   */
  private createEmptyGrid(): BingoCell[][] {
    const grid: BingoCell[][] = [];
    for (let row = 0; row < 5; row++) {
      grid[row] = [];
      for (let col = 0; col < 5; col++) {
        // Center cell (row 2, col 2) is the free space
        const isFreeSpace = row === 2 && col === 2;
        grid[row][col] = {
          track: null,
          isFreeSpace,
        };
      }
    }
    return grid;
  }

  /**
   * Fill a bingo grid with shuffled tracks
   */
  private fillGrid(grid: BingoCell[][], tracks: BingoTrack[]): void {
    let trackIndex = 0;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        if (!grid[row][col].isFreeSpace) {
          grid[row][col].track = tracks[trackIndex++];
        }
      }
    }
  }

  /**
   * Generate all bingo sheets for the given configuration
   *
   * Algorithm:
   * - Each card randomly selects 24 tracks from ALL available tracks
   * - This ensures variety: different contestants have different songs
   * - The shuffle ensures each card has a unique combination
   */
  public generateSheets(
    tracks: BingoTrack[],
    contestants: number,
    rounds: number
  ): BingoSheet[] {
    const sheets: BingoSheet[] = [];
    const tracksPerSheet = 24; // 5x5 grid minus center free space

    this.logger.log(
      color.blue.bold(
        `Generating ${white.bold((contestants * rounds).toString())} bingo sheets for ${white.bold(contestants.toString())} contestants over ${white.bold(rounds.toString())} rounds (pool of ${white.bold(tracks.length.toString())} tracks)`
      )
    );

    for (let round = 1; round <= rounds; round++) {
      // Generate sheets for each contestant in this round
      for (let contestant = 1; contestant <= contestants; contestant++) {
        const grid = this.createEmptyGrid();

        // Shuffle ALL tracks and pick the first 24 for this card
        // This ensures each card gets a random selection from the entire pool
        const shuffledTracks = this.shuffle(tracks);
        const cardTracks = shuffledTracks.slice(0, tracksPerSheet);

        // Fill the grid
        this.fillGrid(grid, cardTracks);

        sheets.push({
          round,
          sheetNumber: contestant,
          grid,
        });
      }
    }

    this.logger.log(
      color.green.bold(`Successfully generated ${white.bold(sheets.length.toString())} bingo sheets`)
    );

    return sheets;
  }

  /**
   * Get a flat list of all grid positions (excluding center)
   */
  private getGridPositions(): { row: number; col: number }[] {
    const positions: { row: number; col: number }[] = [];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        if (!(row === 2 && col === 2)) {
          positions.push({ row, col });
        }
      }
    }
    return positions;
  }

  /**
   * Generate QR code data string for a bingo sheet.
   * New format: QRSSM:BC:R{round}S{sheet}:{num1,num2,...,num24}
   * - QRSSM prefix allows mobile app to recognize it as a system message
   * - BC = Bingo Check message type
   * - Numbers are in position order (0-10, then 13-24, skipping position 12 which is free space)
   * - num: Track's bingoNumber (1-based index in track pool)
   * Example: QRSSM:BC:R1S5:42,17,89,... (24 numbers total)
   */
  public generateQRData(sheet: BingoSheet): string {
    const numbers: number[] = [];

    // Iterate through grid in order, collecting bingoNumbers
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const cell = sheet.grid[row][col];
        if (!cell.isFreeSpace && cell.track && cell.track.bingoNumber) {
          numbers.push(cell.track.bingoNumber);
        }
      }
    }

    return `QRSSM:BC:R${sheet.round}S${sheet.sheetNumber}:${numbers.join(',')}`;
  }

  /**
   * Parse QR code data string back into structured data.
   * Accepts both old format (BINGO:R...) and new format (QRSSM:BC:R...) for backwards compatibility.
   * Returns null if the format is invalid.
   */
  public parseQRData(
    data: string
  ): { round: number; sheet: number; positions: Map<number, number> } | null {
    // Support both old and new formats
    // Old: BINGO:R{round}S{sheet}:{numbers}
    // New: QRSSM:BC:R{round}S{sheet}:{numbers}
    let normalizedData = data;

    if (data.startsWith('QRSSM:BC:')) {
      // Strip QRSSM:BC: prefix and add BINGO: for unified parsing
      normalizedData = 'BINGO:' + data.substring(9);
    }

    // Validate prefix
    if (!normalizedData.startsWith('BINGO:')) {
      return null;
    }

    // Parse format: BINGO:R{round}S{sheet}:{numbers}
    const match = normalizedData.match(/^BINGO:R(\d+)S(\d+):(.+)$/);
    if (!match) {
      return null;
    }

    const round = parseInt(match[1], 10);
    const sheet = parseInt(match[2], 10);
    const numbersStr = match[3];

    // Parse numbers array
    const numbers = numbersStr.split(',').map((n) => parseInt(n, 10));

    // Validate we have 24 numbers
    if (numbers.length !== 24 || numbers.some(isNaN)) {
      return null;
    }

    // Map numbers to positions (0-10, skip 12, then 13-24)
    const positions = new Map<number, number>();
    let numIndex = 0;
    for (let pos = 0; pos < 25; pos++) {
      if (pos === 12) continue; // Skip free space
      positions.set(pos, numbers[numIndex++]);
    }

    return { round, sheet, positions };
  }

  /**
   * Get tracks for a playlist
   */
  private async getPlaylistTracks(playlistDbId: number): Promise<BingoTrack[]> {
    const tracks = await this.prisma.$queryRaw<TrackRow[]>`
      SELECT
        t.id,
        t.trackId,
        COALESCE(NULLIF(tei.name, ''), t.name) as name,
        COALESCE(NULLIF(tei.artist, ''), t.artist) as artist,
        COALESCE(tei.year, t.year) as year,
        pht.\`order\` as trackOrder
      FROM playlist_has_tracks pht
      JOIN tracks t ON t.id = pht.trackId
      LEFT JOIN trackextrainfo tei ON tei.trackId = t.id AND tei.playlistId = pht.playlistId
      WHERE pht.playlistId = ${playlistDbId}
      ORDER BY pht.\`order\` ASC
    `;

    return tracks.map((track) => ({
      id: track.id,
      trackId: track.trackId,
      name: track.name,
      artist: track.artist,
      year: track.year || 0,
    }));
  }

  /**
   * Create a ZIP file containing bingo PDFs
   */
  private async createBingoZip(
    zipPath: string,
    bingoPdfPath: string,
    hostCardsPdfPath: string | null,
    playlistName: string,
    bingoCardsLabel: string,
    hostCardsLabel: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver('zip', {
        zlib: { level: 9 },
      });

      output.on('close', () => {
        resolve();
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);

      // Add bingo sheets PDF
      archive.file(bingoPdfPath, { name: `${playlistName} - ${bingoCardsLabel}.pdf` });

      // Add host cards PDF if exists
      if (hostCardsPdfPath) {
        archive.file(hostCardsPdfPath, { name: `${playlistName} - ${hostCardsLabel}.pdf` });
      }

      archive.finalize();
    });
  }

  /**
   * Generate a default bingo set for an order
   * This is called automatically when an order with bingoEnabled=true is processed
   * Default: 20 contestants, 5 rounds, with host cards
   */
  public async generateDefaultBingo(
    paymentId: string,
    userHash: string,
    playlistId: string,
    playlistDbId: number,
    playlistName: string,
    qrSubDir: string,
    locale: string,
    paymentHasPlaylistId: number
  ): Promise<BingoGenerateResult> {
    const DEFAULT_CONTESTANTS = 20;
    const DEFAULT_ROUNDS = 5;
    const MINIMUM_TRACKS = 40;

    try {
      // Get tracks for the playlist
      let bingoTracks = await this.getPlaylistTracks(playlistDbId);

      // Check minimum track requirement
      if (bingoTracks.length < MINIMUM_TRACKS) {
        this.logger.log(
          color.yellow.bold(
            `Skipping bingo generation for playlist ${white.bold(playlistName)}: only ${bingoTracks.length} tracks (minimum ${MINIMUM_TRACKS})`
          )
        );
        return { success: false, error: `Insufficient tracks: ${bingoTracks.length} < ${MINIMUM_TRACKS}` };
      }

      // Add bingo numbers to tracks (1-based index)
      bingoTracks = bingoTracks.map((track, index) => ({
        ...track,
        bingoNumber: index + 1,
      }));

      // Generate bingo sheets
      const sheets = this.generateSheets(bingoTracks, DEFAULT_CONTESTANTS, DEFAULT_ROUNDS);

      // Generate unique filenames
      const hash = crypto.randomBytes(8).toString('hex');
      const publicDir = process.env['PUBLIC_DIR'] || '/tmp';
      const bingoDir = path.join(publicDir, 'bingo');
      const apiUri = process.env['API_URI'] || 'http://localhost:3004';

      // Ensure directory exists
      await fs.mkdir(bingoDir, { recursive: true });

      // File paths
      const bingoPdfFilename = `bingo_${hash}.pdf`;
      const hostCardsPdfFilename = `hostcards_${hash}.pdf`;
      const sanitizedPlaylistName = this.utils.generateFilename(playlistName).substring(0, 50);
      const zipFilename = `${paymentId}_${sanitizedPlaylistName}_bingo.zip`;

      const bingoPdfPath = path.join(bingoDir, bingoPdfFilename);
      const hostCardsPdfPath = path.join(bingoDir, hostCardsPdfFilename);
      const zipPath = path.join(bingoDir, zipFilename);

      // Store bingo config in cache to avoid long URLs (expires in 5 minutes)
      const configId = hash;
      const bingoConfig = {
        paymentId,
        userHash,
        playlistId,
        contestants: DEFAULT_CONTESTANTS,
        rounds: DEFAULT_ROUNDS,
        locale: locale || 'en',
        selectedTracks: [],
      };
      await this.cache.set(`bingo_config:${configId}`, JSON.stringify(bingoConfig), 300);

      // Generate bingo cards PDF
      const htmlUrl = `${apiUri}/bingo/render/${configId}`;
      this.logger.log(color.blue.bold(`[Auto-Bingo] Generating bingo PDF from: ${white.bold(htmlUrl)}`));

      const pdfBuffer = await this.pdf.generatePdfFromUrl(htmlUrl, {
        format: 'A4',
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
        preferCSSPageSize: true,
      });

      await fs.writeFile(bingoPdfPath, pdfBuffer);

      this.logger.log(
        color.green.bold(`[Auto-Bingo] Bingo PDF generated: ${white.bold(bingoPdfFilename)} (${sheets.length} sheets)`)
      );

      // Generate host cards PDF
      const hostCardsHtmlUrl = `${apiUri}/bingo/render-hostcards/${configId}`;
      this.logger.log(color.blue.bold(`[Auto-Bingo] Generating host cards PDF from: ${white.bold(hostCardsHtmlUrl)}`));

      const hostCardsPdfBuffer = await this.pdf.generatePdfFromUrl(hostCardsHtmlUrl, {
        format: 'A4',
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
        preferCSSPageSize: true,
      });

      await fs.writeFile(hostCardsPdfPath, hostCardsPdfBuffer);

      this.logger.log(
        color.green.bold(`[Auto-Bingo] Host cards PDF generated: ${white.bold(hostCardsPdfFilename)} (${bingoTracks.length} cards)`)
      );

      // Clean up config from cache
      await this.cache.del(`bingo_config:${configId}`);

      // Create ZIP file with translated file names
      const validLocale = this.translation.isValidLocale(locale) ? locale : 'en';
      const bingoCardsLabel = this.translation.translate('bingo_pdf.bingoCardsFilename', validLocale);
      const hostCardsLabel = this.translation.translate('bingo_pdf.hostCardsFilename', validLocale);
      await this.createBingoZip(zipPath, bingoPdfPath, hostCardsPdfPath, playlistName, bingoCardsLabel, hostCardsLabel);

      this.logger.log(color.green.bold(`[Auto-Bingo] Bingo ZIP created: ${white.bold(zipFilename)}`));

      // Clean up individual PDF files (keep only ZIP)
      await fs.unlink(bingoPdfPath).catch(() => {});
      await fs.unlink(hostCardsPdfPath).catch(() => {});

      // Store the bingo file in database for future downloads
      const usedTrackIds = bingoTracks.map((t) => t.trackId);
      await this.prisma.bingoFile.create({
        data: {
          paymentHasPlaylistId,
          filename: zipFilename,
          contestants: DEFAULT_CONTESTANTS,
          rounds: DEFAULT_ROUNDS,
          trackCount: bingoTracks.length,
          selectedTrackIds: usedTrackIds,
        },
      });

      // Return download URL
      const downloadUrl = `${apiUri}/public/bingo/${zipFilename}`;

      this.logger.log(
        color.green.bold(`[Auto-Bingo] Successfully generated default bingo for playlist ${white.bold(playlistName)}`)
      );

      return {
        success: true,
        downloadUrl,
      };
    } catch (error: any) {
      this.logger.log(color.red.bold(`[Auto-Bingo] Error generating bingo: ${error.message}`));
      console.error(error);

      // Send pushover notification about the error
      this.pushover.sendMessage(
        {
          title: 'Auto-Bingo Generation Failed',
          message: `Failed to generate bingo for payment ${paymentId}: ${error.message}`,
          sound: 'falling',
        },
        ''
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }
}

export default Bingo;
