import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { CronJob } from 'cron';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Utils from './utils';
import { cleanupPhotoFiles, generateProductPhoto } from './productPhoto/photos';

/**
 * Makes product photos (src/productPhoto/photos.ts) one at a time: each
 * takes a PDF Lambda render and a couple of seconds of CPU, so one worker is
 * plenty and keeps the server free. A playlist is in the queue at most once
 * (job id pp-<playlistId>); asking again while it waits only makes the
 * waiting job stronger (force, repick).
 *
 * Queued when a playlist is featured or its design or songs change
 * (productPhoto/triggers.ts), by the admin (one playlist, or every featured
 * one from the Featured page), and every night for every featured playlist,
 * which costs nothing for a photo that is still right (the job sees its key
 * unchanged and stops).
 */

interface PhotoJobData {
  playlistId: number;
  force?: boolean;
  repick?: boolean;
}

const QUEUE = 'product-photo';

class ProductPhotoQueue {
  private static instance: ProductPhotoQueue;
  private queue: Queue<PhotoJobData>;
  private worker?: Worker<PhotoJobData>;
  private connection: Redis;
  private logger = new Logger();

  private constructor() {
    this.connection = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.queue = new Queue<PhotoJobData>(QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: { age: 7 * 86_400, count: 500 },
        // a Lambda that did not answer gets one more try
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
      },
    });
  }

  public static getInstance(): ProductPhotoQueue {
    if (!ProductPhotoQueue.instance) ProductPhotoQueue.instance = new ProductPhotoQueue();
    return ProductPhotoQueue.instance;
  }

  /** Queues one playlist's photo; a job already waiting for it takes the stronger options. */
  public async add(playlistId: number, options: { force?: boolean; repick?: boolean } = {}): Promise<void> {
    const jobId = `pp-${playlistId}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
        await existing.updateData({
          playlistId,
          force: existing.data.force || options.force,
          repick: existing.data.repick || options.repick,
        });
        return;
      }
      if (state === 'active') {
        // it may already be past what changed: run once more afterwards
        if (options.force || options.repick) await this.queue.add('photo', { playlistId, ...options }, { delay: 30_000 });
        return;
      }
      await existing.remove().catch(() => {});
    }
    await this.queue.add('photo', { playlistId, ...options }, { jobId });
  }

  /** Queues every featured playlist; returns how many. */
  public async addAllFeatured(): Promise<number> {
    const playlists = await PrismaInstance.getInstance().playlist.findMany({
      where: { featured: true, slug: { not: '' } },
      select: { id: true },
      orderBy: { score: 'desc' },
    });
    for (const playlist of playlists) await this.add(playlist.id);
    return playlists.length;
  }

  public async counts(): Promise<{ waiting: number; active: number; failed: number }> {
    const counts = await this.queue.getJobCounts('waiting', 'delayed', 'prioritized', 'active', 'failed');
    return {
      waiting: (counts['waiting'] || 0) + (counts['delayed'] || 0) + (counts['prioritized'] || 0),
      active: counts['active'] || 0,
      failed: counts['failed'] || 0,
    };
  }

  public startWorker(): void {
    if (this.worker) return;
    this.worker = new Worker<PhotoJobData>(
      QUEUE,
      async (job) => {
        const { playlistId, force, repick } = job.data;
        const result = await generateProductPhoto(playlistId, { force, repick });
        if (result.status === 'skipped') {
          this.logger.log(
            color.yellow.bold(`Product photo of playlist ${white.bold(playlistId)} skipped: ${white.bold(result.reason)}`)
          );
        }
        return result;
      },
      { connection: this.connection.duplicate(), concurrency: 1 }
    );
    this.worker.on('failed', (job, error) => {
      this.logger.log(
        color.red.bold(`Product photo of playlist ${white.bold(job?.data.playlistId)} failed: ${white.bold(error.message)}`)
      );
    });
    this.startNightlySweep();
    this.logger.log(color.blue.bold('Product photo worker started'));
  }

  /** Every night: every featured playlist (a photo still right costs nothing), then the old files. */
  private startNightlySweep(): void {
    new CronJob('30 1 * * *', async () => {
      if (process.env['ENVIRONMENT'] === 'development') return;
      if (!(await new Utils().isMainServer())) return;
      try {
        const queued = await this.addAllFeatured();
        await cleanupPhotoFiles();
        this.logger.log(color.blue.bold(`Nightly product photo check: ${white.bold(queued)} playlists queued`));
      } catch (error: any) {
        this.logger.log(color.red.bold(`Nightly product photo check failed: ${error.message}`));
      }
    }).start();
  }

  public async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

export default ProductPhotoQueue;
