import Logger from './logger';
import { color, white } from 'console-log-colors';

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

class Bingo {
  private static instance: Bingo;
  private logger = new Logger();

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
   * Compact format: BINGO:R{round}S{sheet}:{num1,num2,...,num24}
   * - Numbers are in position order (0-10, then 13-24, skipping position 12 which is free space)
   * - num: Track's bingoNumber (1-based index in track pool)
   * Example: BINGO:R1S5:42,17,89,... (24 numbers total)
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

    return `BINGO:R${sheet.round}S${sheet.sheetNumber}:${numbers.join(',')}`;
  }

  /**
   * Parse QR code data string back into structured data.
   * Returns null if the format is invalid.
   */
  public parseQRData(
    data: string
  ): { round: number; sheet: number; positions: Map<number, number> } | null {
    // Validate prefix
    if (!data.startsWith('BINGO:')) {
      return null;
    }

    // Parse format: BINGO:R{round}S{sheet}:{numbers}
    const match = data.match(/^BINGO:R(\d+)S(\d+):(.+)$/);
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
}

export default Bingo;
