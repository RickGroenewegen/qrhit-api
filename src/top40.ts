import axios from 'axios';
import { getISOWeek, getISOWeekYear } from 'date-fns';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';

const TOP40_CSV_URL = 'https://gerritmantel.nl/html_public/top40/csv/top40-noteringen.csv';
const BATCH_SIZE = 1000;

interface Top40Entry {
  year: number;
  weekNumber: number;
  position: number;
  artist: string;
  title: string;
  previousPosition: number;
  weeksOnChart: number;
  status: string;
  externalId: string;
}

interface ImportResult {
  success: boolean;
  totalRows: number;
  imported: number;
  updated: number;
  errors: number;
  error?: string;
}

interface NumberOneResult {
  artist: string;
  title: string;
  year: number;
  weekNumber: number;
}

class Top40 {
  private static instance: Top40;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();

  private constructor() {}

  public static getInstance(): Top40 {
    if (!Top40.instance) {
      Top40.instance = new Top40();
    }
    return Top40.instance;
  }

  /**
   * Import Top 40 chart data from CSV
   */
  async importTop40Data(): Promise<ImportResult> {
    this.logger.log(
      color.blue.bold(`[${white.bold('Top40')}] Starting import from CSV`)
    );

    try {
      // Fetch CSV data
      this.logger.log(
        color.blue.bold(`[${white.bold('Top40')}] Fetching CSV from ${white.bold(TOP40_CSV_URL)}`)
      );

      const response = await axios.get(TOP40_CSV_URL, {
        responseType: 'text',
        timeout: 60000,
      });

      const csvData = response.data as string;
      const lines = csvData.split('\n');

      this.logger.log(
        color.blue.bold(`[${white.bold('Top40')}] Fetched ${white.bold(lines.length.toString())} lines`)
      );

      // Parse CSV (skip header row)
      const entries: Top40Entry[] = [];
      let parseErrors = 0;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const columns = line.split('\t');

        if (columns.length < 9) {
          parseErrors++;
          continue;
        }

        try {
          const entry: Top40Entry = {
            year: parseInt(columns[0], 10),
            weekNumber: parseInt(columns[1], 10),
            position: parseInt(columns[2], 10),
            artist: columns[3],
            title: columns[4],
            previousPosition: parseInt(columns[5], 10) || 0,
            weeksOnChart: parseInt(columns[6], 10) || 1,
            status: columns[7] || '',
            externalId: columns[8],
          };

          // Validate essential fields
          if (!isNaN(entry.year) && !isNaN(entry.weekNumber) && !isNaN(entry.position)) {
            entries.push(entry);
          } else {
            parseErrors++;
          }
        } catch {
          parseErrors++;
        }
      }

      this.logger.log(
        color.blue.bold(
          `[${white.bold('Top40')}] Parsed ${white.bold(entries.length.toString())} valid entries (${white.bold(parseErrors.toString())} parse errors)`
        )
      );

      // Check which entries already exist in database
      this.logger.log(
        color.blue.bold(`[${white.bold('Top40')}] Checking for existing entries...`)
      );

      const existingEntries = await this.prisma.top40Chart.findMany({
        select: {
          year: true,
          weekNumber: true,
          position: true,
        },
      });

      // Create a Set for fast lookup
      const existingKeys = new Set(
        existingEntries.map((e: { year: number; weekNumber: number; position: number }) =>
          `${e.year}-${e.weekNumber}-${e.position}`
        )
      );

      // Filter out entries that already exist
      const newEntries = entries.filter(
        (entry) => !existingKeys.has(`${entry.year}-${entry.weekNumber}-${entry.position}`)
      );

      this.logger.log(
        color.blue.bold(
          `[${white.bold('Top40')}] Found ${white.bold(existingEntries.length.toString())} existing entries, ${white.bold(newEntries.length.toString())} new entries to import`
        )
      );

      if (newEntries.length === 0) {
        this.logger.log(
          color.green.bold(`[${white.bold('Top40')}] No new entries to import, all data is up to date`)
        );
        return {
          success: true,
          totalRows: entries.length,
          imported: 0,
          updated: 0,
          errors: 0,
        };
      }

      // Insert new entries in batches
      let imported = 0;
      let updated = 0;
      let errors = 0;
      const totalBatches = Math.ceil(newEntries.length / BATCH_SIZE);

      for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
        const start = batchNum * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, newEntries.length);
        const batch = newEntries.slice(start, end);

        this.logger.log(
          color.blue.bold(
            `[${white.bold('Top40')}] Processing batch ${white.bold((batchNum + 1).toString())}/${white.bold(totalBatches.toString())} (${white.bold(batch.length.toString())} new entries)`
          )
        );

        // Use createMany for efficient batch inserts
        try {
          const result = await this.prisma.top40Chart.createMany({
            data: batch.map((entry) => ({
              year: entry.year,
              weekNumber: entry.weekNumber,
              position: entry.position,
              artist: entry.artist,
              title: entry.title,
              previousPosition: entry.previousPosition,
              weeksOnChart: entry.weeksOnChart,
              status: entry.status,
              externalId: entry.externalId,
            })),
            skipDuplicates: true,
          });

          imported += result.count;
        } catch (error) {
          errors += batch.length;
          this.logger.log(
            color.red.bold(
              `[${white.bold('Top40')}] Batch ${batchNum + 1} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            )
          );
        }
      }

      this.logger.log(
        color.green.bold(
          `[${white.bold('Top40')}] Import completed: ${white.bold(imported.toString())} imported/updated, ${white.bold(errors.toString())} errors`
        )
      );

      return {
        success: true,
        totalRows: entries.length,
        imported,
        updated,
        errors,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.log(
        color.red.bold(`[${white.bold('Top40')}] Import failed: ${white.bold(errorMsg)}`)
      );

      return {
        success: false,
        totalRows: 0,
        imported: 0,
        updated: 0,
        errors: 1,
        error: errorMsg,
      };
    }
  }

  /**
   * Get the #1 track for a given date
   * Uses ISO week number to find the matching chart week
   * Falls back to the most recent previous #1 if the exact week isn't found
   * If the date is before the Top 40 started (January 2, 1965), returns the very first #1
   */
  async getNumberOneOnDate(date: Date): Promise<NumberOneResult | null> {
    // The Dutch Top 40 started on January 2, 1965
    const top40StartDate = new Date('1965-01-02');

    // If the date is before the Top 40 started, use the first #1 from 1965
    if (date < top40StartDate) {
      this.logger.log(
        color.blue.bold(
          `[${white.bold('Top40')}] Date ${white.bold(date.toISOString().split('T')[0])} is before Top 40 started (1965-01-02), returning first #1 ever`
        )
      );
      return this.getFirstNumberOneEver();
    }

    const year = getISOWeekYear(date);
    const weekNumber = getISOWeek(date);

    this.logger.log(
      color.blue.bold(
        `[${white.bold('Top40')}] Looking up #1 for date ${white.bold(date.toISOString().split('T')[0])} (year: ${white.bold(year.toString())}, week: ${white.bold(weekNumber.toString())})`
      )
    );

    try {
      // First try to find the exact week
      let entry = await this.prisma.top40Chart.findFirst({
        where: {
          year,
          weekNumber,
          position: 1,
        },
        select: {
          artist: true,
          title: true,
          year: true,
          weekNumber: true,
        },
      });

      if (entry) {
        this.logger.log(
          color.green.bold(
            `[${white.bold('Top40')}] Found #1: ${white.bold(entry.artist)} - ${white.bold(entry.title)}`
          )
        );
        return entry;
      }

      // Fallback: find the most recent #1 before this date
      this.logger.log(
        color.yellow.bold(
          `[${white.bold('Top40')}] No #1 found for week ${weekNumber} of ${year}, searching for previous...`
        )
      );

      entry = await this.prisma.top40Chart.findFirst({
        where: {
          position: 1,
          OR: [
            { year: { lt: year } },
            { year, weekNumber: { lt: weekNumber } },
          ],
        },
        orderBy: [
          { year: 'desc' },
          { weekNumber: 'desc' },
        ],
        select: {
          artist: true,
          title: true,
          year: true,
          weekNumber: true,
        },
      });

      if (entry) {
        this.logger.log(
          color.green.bold(
            `[${white.bold('Top40')}] Found fallback #1 from week ${entry.weekNumber} of ${entry.year}: ${white.bold(entry.artist)} - ${white.bold(entry.title)}`
          )
        );
        return entry;
      }

      this.logger.log(
        color.yellow.bold(
          `[${white.bold('Top40')}] No #1 found before week ${weekNumber} of ${year}`
        )
      );
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.log(
        color.red.bold(`[${white.bold('Top40')}] Error looking up #1: ${white.bold(errorMsg)}`)
      );
      return null;
    }
  }

  /**
   * Get the very first #1 ever in the Top 40 (week 1 of 1965)
   * Used for people born before the Top 40 started
   */
  private async getFirstNumberOneEver(): Promise<NumberOneResult | null> {
    try {
      const entry = await this.prisma.top40Chart.findFirst({
        where: {
          position: 1,
        },
        orderBy: [
          { year: 'asc' },
          { weekNumber: 'asc' },
        ],
        select: {
          artist: true,
          title: true,
          year: true,
          weekNumber: true,
        },
      });

      if (entry) {
        this.logger.log(
          color.green.bold(
            `[${white.bold('Top40')}] Found first #1 ever (week ${entry.weekNumber} of ${entry.year}): ${white.bold(entry.artist)} - ${white.bold(entry.title)}`
          )
        );
        return entry;
      }

      this.logger.log(
        color.yellow.bold(
          `[${white.bold('Top40')}] No #1 entries found in database`
        )
      );
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.log(
        color.red.bold(`[${white.bold('Top40')}] Error looking up first #1: ${white.bold(errorMsg)}`)
      );
      return null;
    }
  }
}

export default Top40;
