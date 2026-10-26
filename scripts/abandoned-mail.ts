/**
 * The help mail after an abandoned payment (src/abandonedPayments.ts), by hand.
 *
 *   npx tsx scripts/abandoned-mail.ts --run [--delay=<minutes>]
 *       one pass of the hourly job, decisions and all; --delay=0 takes a
 *       payment that ended a moment ago (the job waits an hour)
 *   npx tsx scripts/abandoned-mail.ts --payment=<payments.id> --to=<email>
 *       the mail for one payment, to another address: no checks, nothing
 *       written; for an example or a look at an order's mail
 *
 * The cron never runs in development, so this is how the job is tried there.
 * --run mails whoever the database has in the window: look first.
 */
import 'dotenv/config';
import { color, white } from 'console-log-colors';
import AbandonedPayments from '../src/abandonedPayments';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const job = AbandonedPayments.getInstance();
  if (process.argv.includes('--run')) {
    const delay = arg('delay');
    const counts = await job.run(delay !== undefined ? { delayMinutes: Number(delay) } : {});
    console.log(color.green.bold(`Done: ${white.bold(JSON.stringify(counts))}`));
    return;
  }

  const paymentId = Number(arg('payment'));
  const to = arg('to');
  if (!paymentId || !to || !to.includes('@')) {
    console.log('usage: npx tsx scripts/abandoned-mail.ts --run [--delay=<minutes>]');
    console.log('       npx tsx scripts/abandoned-mail.ts --payment=<payments.id> --to=<email>');
    process.exitCode = 1;
    return;
  }
  const sent = await job.send(paymentId, to);
  console.log(
    sent
      ? color.green.bold(`Sent the help mail for payment ${white.bold(paymentId)} to ${white.bold(to)}`)
      : color.red.bold(`The help mail for payment ${white.bold(paymentId)} was not sent (see the log above)`)
  );
  if (!sent) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // The Mail singleton starts its crons; they would keep the process alive
  .finally(() => process.exit());
