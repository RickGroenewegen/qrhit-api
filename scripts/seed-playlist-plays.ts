/**
 * Seed the play rankings of the admin Analytics page from the scan log.
 *
 * The rankings count plays per order line in the analytics Redis database
 * (`plays:php:*`, see AnalyticsClient). They start counting on the first scan
 * after the deploy, and there is no older per-scan history in the database.
 * The scan log the map reads (`ipInfoList`, the last 1000 scans) is the only
 * record of what came before, so this adds those scans once: to the all-time
 * total and, for the last 8 days, to their hour, so the 24-hour and 7-day
 * panels are not empty on day one.
 *
 * Only scans from before counting began are added, so nothing is counted both
 * live and seeded. A run that writes marks `plays:php:seeded`; any later run
 * refuses.
 *
 *   npx tsx scripts/seed-playlist-plays.ts          # report only
 *   npx tsx scripts/seed-playlist-plays.ts --write  # add the scans
 */
import 'dotenv/config';
import { color } from 'console-log-colors';
import Cache from '../src/cache';
import AnalyticsClient, { SeedPlay, playPhpId } from '../src/analytics';

const write = process.argv.includes('--write');

function parseScanLog(entries: string[]): SeedPlay[] {
  const plays: SeedPlay[] = [];
  for (const entry of entries) {
    try {
      const scan = JSON.parse(entry);
      const php = playPhpId(scan?.php);
      const at = new Date(scan?.timestamp);
      if (php !== null && !Number.isNaN(at.getTime())) {
        plays.push({ php, at });
      }
    } catch {
      // Not JSON: skip it.
    }
  }
  return plays;
}

async function main() {
  const entries: string[] = await Cache.getInstance().executeCommand(
    'lrange',
    'ipInfoList',
    0,
    -1
  );
  const plays = parseScanLog(entries);
  const result = await AnalyticsClient.getInstance().seedPlaylistPlays(plays, {
    write,
  });

  console.log(
    color.blue.bold(
      `Scan log: ${color.white.bold(entries.length)} entries, ${color.white.bold(
        plays.length
      )} with an order line`
    )
  );
  console.log(
    color.blue.bold(
      `Before ${color.white.bold(result.cutoff)}: ${color.white.bold(
        result.scans
      )} scans of ${color.white.bold(result.orders)} order lines, ${color.white.bold(
        result.oldest ?? '-'
      )} to ${color.white.bold(result.newest ?? '-')}`
    )
  );

  if (result.alreadySeeded) {
    console.log(color.yellow.bold('Already seeded: nothing added.'));
  } else if (result.written) {
    console.log(color.green.bold('Added. Counting now starts at the oldest seeded scan.'));
  } else if (!write) {
    console.log(color.yellow.bold('Dry run: run with --write to add them.'));
  } else {
    console.log(color.yellow.bold('Nothing to add.'));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(color.red.bold(`Seeding failed: ${color.white.bold(error.message)}`));
    process.exit(1);
  });
