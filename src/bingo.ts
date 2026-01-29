import Logger from './logger';
import { color, white } from 'console-log-colors';

export interface BingoTrack {
  id: number;
  trackId: string;
  name: string;
  artist: string;
  year: number;
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
   * - For each round, we use a pool of tracks
   * - Tracks are shuffled for each sheet to ensure variety
   * - Each contestant gets a unique arrangement
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
        `Generating ${white.bold((contestants * rounds).toString())} bingo sheets for ${white.bold(contestants.toString())} contestants over ${white.bold(rounds.toString())} rounds`
      )
    );

    for (let round = 1; round <= rounds; round++) {
      // For each round, we'll use a shuffled pool of tracks
      // If we have enough tracks, use different tracks per round
      // Otherwise, reshuffle the same pool
      const roundStartIndex = ((round - 1) * tracksPerSheet) % tracks.length;

      // Create a working pool for this round
      let roundTracks: BingoTrack[];

      if (tracks.length >= rounds * tracksPerSheet) {
        // We have enough tracks for unique songs per round
        // Use a slice of tracks for this round
        const endIndex = roundStartIndex + tracksPerSheet;
        if (endIndex <= tracks.length) {
          roundTracks = tracks.slice(roundStartIndex, endIndex);
        } else {
          // Wrap around if needed
          roundTracks = [
            ...tracks.slice(roundStartIndex),
            ...tracks.slice(0, endIndex - tracks.length),
          ];
        }
      } else {
        // Not enough tracks for unique per round, use all and shuffle
        roundTracks = this.shuffle(tracks).slice(0, Math.min(tracksPerSheet, tracks.length));
      }

      // Generate sheets for each contestant in this round
      for (let contestant = 1; contestant <= contestants; contestant++) {
        const grid = this.createEmptyGrid();

        // Shuffle tracks for this specific sheet
        const shuffledTracks = this.shuffle(roundTracks);

        // Fill the grid
        this.fillGrid(grid, shuffledTracks);

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
}

export default Bingo;
