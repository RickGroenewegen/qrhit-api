#!/usr/bin/env node

/**
 * Test script for the Channable product feed
 * Usage: npx tsx test-channable.ts
 *
 * Builds the feed against the configured database and prints a summary plus
 * the first few rows, so you can eyeball titles, prices and image links
 * without waiting for the 5 AM cron.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { blue, green, red, white, yellow } from 'console-log-colors';

// Load environment variables BEFORE anything pulls in the service graph —
// prisma, mail and the printers all read process.env at import time, so a
// static `import` of ./src/channable up here would blow up on DATABASE_URL.
dotenv.config({ path: path.join(__dirname, '.env') });

async function testChannableFeed() {
  const { default: Logger } = await import('./src/logger');
  const { channable } = await import('./src/channable');
  const logger = new Logger();

  logger.log(blue.bold('Building the Channable feed...'));

  try {
    const result = await channable.generateFeed();

    logger.log(
      green.bold(
        `\n✓ Wrote ${white.bold(result.rows.toString())} rows to ${white.bold(result.path)}`
      )
    );

    const csv = await fs.readFile(result.path, 'utf8');
    const lines = csv.split('\r\n').filter(Boolean);

    logger.log(blue.bold('\nHeader:'));
    logger.log(white(lines[0] || '(empty)'));

    logger.log(blue.bold(`\nFirst ${Math.min(3, lines.length - 1)} rows:`));
    for (const line of lines.slice(1, 4)) {
      logger.log(white(line));
    }

    // Per-country slices, so you can confirm each market got its own file.
    logger.log(blue.bold('\nPer-country slices:'));
    for (const country of channable.getFeedCountries()) {
      const slice = await fs.readFile(channable.getFeedPath(country), 'utf8');
      const count = slice.split('\r\n').filter(Boolean).length - 1;
      logger.log(
        white(`  ${country}: ${count} row${count === 1 ? '' : 's'}`)
      );
    }

    const token = process.env['CHANNABLE_FEED_TOKEN'];
    const apiUri = process.env['API_URI'] || 'https://api.qrsong.io';
    logger.log(blue.bold('\nFeed URL for the agency:'));
    if (token) {
      logger.log(white(`  ${apiUri}/channable/feed.csv?token=${token}`));
    } else {
      logger.log(
        yellow('  CHANNABLE_FEED_TOKEN is not set — the route will 404.')
      );
    }

    process.exit(0);
  } catch (error) {
    logger.log(red(`\n✗ Feed build failed: ${error}`));
    process.exit(1);
  }
}

testChannableFeed();
