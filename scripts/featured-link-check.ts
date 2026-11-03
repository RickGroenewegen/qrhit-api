/**
 * The featured link check (src/linkCheck) by hand.
 *
 *   npm run link-check
 *       dry run: asks every music service about every featured playlist and
 *       reports what the nightly run would do. No playlist, strike, cache or
 *       feed is changed and no Pushover is sent. (The music clients may still
 *       refresh their own access tokens, as they do on every call.)
 *   npm run link-check -- --write
 *       one real run, as the 02:15 cron does it: marks, clears, strikes,
 *       notifies. Writes to the database in .env.
 *   npm run link-check -- --write --force
 *       the same without the cap of 5 (or 10%) per run: for when the cap held
 *       back playlists you have looked at and that really are gone.
 *   --json
 *       print the report as JSON at the end.
 *
 * A full run takes about two seconds per featured playlist.
 */
import 'dotenv/config';
import { color, white } from 'console-log-colors';
import FeaturedLinkCheck from '../src/linkCheck';

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const force = process.argv.includes('--force');
  if (force && !write) {
    console.log(color.red.bold('--force only means something with --write'));
    process.exitCode = 1;
    return;
  }

  const report = await FeaturedLinkCheck.getInstance().run({ dryRun: !write, ignoreCap: force });
  if (!report) {
    console.log(color.yellow.bold('Another check holds the lock; try again when it is done'));
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  }
  console.log(
    color.blue.bold(
      `${write ? 'Run' : 'Dry run'} finished: ${white.bold(report.flagged.length)} ${
        write ? 'marked broken' : 'would be marked broken'
      }, ${white.bold(report.capped.length)} held back by the cap, ${white.bold(
        report.recovered.length
      )} working again, ${white.bold(report.firstStrikes.length)} gone for the first time`
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // Singletons start crons and Redis connections that keep the process alive
  .finally(() => process.exit());
