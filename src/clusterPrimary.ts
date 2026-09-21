import cluster from 'cluster';
import os from 'os';
import { color } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import {
  backfillLegacyDefaultBackground,
  ensureLegacyDefaultBackgroundFile,
} from './legacyBackground';

/**
 * What the cluster primary does before it loads the rest of the application.
 *
 * Keep the imports of this file light. The workers are what answer HTTP, and
 * each one needs a second or more to load the module graph. The primary used
 * to load that same graph, build a Fastify app it never listens on, look up
 * the instance name and start the queue workers before forking, so time to
 * first request was two graph loads in a row. app.ts now calls this before it
 * imports server.ts: the workers load while the primary sets itself up.
 */

const logger = new Logger();

/**
 * Pins pre-cutover order lines to the legacy artwork, once per database.
 * Stays ahead of the fork on purpose: on a database where it has not run yet,
 * a worker that is already taking orders could create a line with no
 * background that the UPDATE would then pin to the old artwork. A failure
 * must never keep the API from starting.
 */
async function runLegacyBackgroundBackfill(): Promise<void> {
  try {
    const affected = await backfillLegacyDefaultBackground(
      PrismaInstance.getInstance()
    );
    if (affected !== null) {
      logger.log(
        color.blue.bold(
          `Legacy default card background pinned on ${color.white.bold(affected)} order lines`
        )
      );
    }
  } catch (error) {
    logger.log(
      color.red.bold(`Legacy default card background backfill failed: ${error}`)
    );
  }
}

/**
 * Every process checks for the legacy artwork in createDirs(). Copying it
 * here first means the workers, which now start together, all find it in
 * place instead of writing the same file at the same time.
 */
async function copyLegacyBackgroundFile(): Promise<void> {
  try {
    const copied = await ensureLegacyDefaultBackgroundFile(
      process.env['ASSETS_DIR']!,
      process.env['PUBLIC_DIR']!
    );
    if (copied) {
      logger.log(
        color.blue.bold('Copied the legacy default card background into public/background')
      );
    }
  } catch (error) {
    logger.log(
      color.red.bold(`Copying the legacy default card background failed: ${error}`)
    );
  }
}

function forkWorkers(): void {
  const numCPUs = os.cpus().length;
  // Track each worker's slot: the exit handler runs in the primary,
  // where WORKER_ID is unset, so the respawn must recover the slot
  // from the dying worker instead of the environment.
  const workerSlots = new Map<number, number>();
  for (let i = 0; i < numCPUs; i++) {
    const forked = cluster.fork({
      WORKER_ID: `${i}`,
    });
    workerSlots.set(forked.id, i);
  }
  cluster.on('exit', (worker, code, signal) => {
    logger.log(
      color.red.bold(
        `Worker ${color.white.bold(worker.process.pid)} died. Restarting...`
      )
    );
    const slot = workerSlots.get(worker.id) ?? 0;
    workerSlots.delete(worker.id);
    const respawned = cluster.fork({
      WORKER_ID: `${slot}`,
    });
    workerSlots.set(respawned.id, slot);
  });
}

let started = false;

/** No-op in a worker, and on a second call in the primary. */
export async function startClusterWorkers(): Promise<void> {
  if (!cluster.isPrimary || started) {
    return;
  }
  started = true;
  logger.log(
    color.blue.bold(`Master ${color.bold.white(process.pid)} is starting...`)
  );
  await Promise.all([copyLegacyBackgroundFile(), runLegacyBackgroundBackfill()]);
  forkWorkers();
}
