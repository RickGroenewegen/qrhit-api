import { Queue, Worker, QueueEvents } from 'bullmq';
import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import Redis from 'ioredis';
import cluster from 'cluster';
import MusicFetch from './musicfetch';

interface MusicFetchJobData {
  type: 'playlist' | 'bulk';
  playlistId?: number;
  trackIds?: number[];
}

class MusicFetchQueue {
  private static instance: MusicFetchQueue;
  private queue: Queue<MusicFetchJobData>;
  private workers: Worker<MusicFetchJobData>[] = [];
  private queueEvents?: QueueEvents;
  private logger = new Logger();
  private connection: Redis;

  private constructor() {
    const redisUrl = process.env['REDIS_URL'] || 'redis://localhost:6379';

    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.queue = new Queue<MusicFetchJobData>('musicfetch', {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: {
          count: 100,
          age: 24 * 3600, // 24 hours
        },
        removeOnFail: {
          count: 50,
          age: 24 * 3600, // 24 hours
        },
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5 seconds delay between retries
        },
      },
    });

    // Only set up event listeners on the primary process
    if (cluster.isPrimary || !cluster.isWorker) {
      this.queueEvents = new QueueEvents('musicfetch', {
        connection: this.connection.duplicate(),
      });

      this.setupEventListeners();
    }

    this.logger.log(
      color.blue.bold('MusicFetchQueue initialized successfully')
    );
  }

  public static getInstance(): MusicFetchQueue {
    if (!MusicFetchQueue.instance) {
      MusicFetchQueue.instance = new MusicFetchQueue();
    }
    return MusicFetchQueue.instance;
  }

  private setupEventListeners(): void {
    if (!this.queueEvents) return;

    this.queueEvents.on('completed', async ({ jobId }) => {
      this.logger.log(
        color.green.bold(
          `MusicFetch job ${white.bold(jobId)} completed successfully`
        )
      );
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.log(
        color.red.bold(
          `MusicFetch job ${white.bold(jobId)} failed: ${failedReason}`
        )
      );
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      this.logger.log(
        color.blue.bold(
          `MusicFetch job ${white.bold(jobId)} progress: ${JSON.stringify(data)}`
        )
      );
    });
  }

  /**
   * Queue a playlist for MusicFetch processing
   */
  public async queuePlaylist(playlistId: number): Promise<string> {
    try {
      const job = await this.queue.add(
        'process-playlist',
        {
          type: 'playlist',
          playlistId,
        },
        {
          jobId: `playlist-${playlistId}-${Date.now()}`,
        }
      );

      this.logger.log(
        color.blue.bold(
          `Queued MusicFetch processing for playlist ${white.bold(
            playlistId.toString()
          )} with job ID: ${white.bold(job.id || 'unknown')}`
        )
      );

      return job.id || '';
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error queueing playlist ${playlistId} for MusicFetch: ${error}`
        )
      );
      throw error;
    }
  }

  /**
   * Queue bulk tracks for MusicFetch processing
   */
  public async queueBulkTracks(trackIds?: number[]): Promise<string> {
    try {
      const job = await this.queue.add(
        'process-bulk',
        {
          type: 'bulk',
          trackIds,
        },
        {
          jobId: `bulk-${Date.now()}`,
        }
      );

      this.logger.log(
        color.blue.bold(
          `Queued MusicFetch bulk processing with job ID: ${white.bold(
            job.id || 'unknown'
          )}`
        )
      );

      return job.id || '';
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error queueing bulk tracks for MusicFetch: ${error}`)
      );
      throw error;
    }
  }

  /**
   * Start workers to process MusicFetch jobs
   */
  public startWorkers(concurrency: number = 1): void {
    // Only start workers if RUN_QUEUE_WORKERS is enabled
    if (process.env['RUN_QUEUE_WORKERS'] !== 'true') {
      this.logger.log(
        color.yellow.bold(
          'MusicFetch queue workers not started (RUN_QUEUE_WORKERS not enabled)'
        )
      );
      return;
    }

    for (let i = 0; i < concurrency; i++) {
      const worker = new Worker<MusicFetchJobData>(
        'musicfetch',
        async (job) => {
          this.logger.log(
            color.blue.bold(
              `Processing MusicFetch job ${white.bold(
                job.id || 'unknown'
              )} of type ${white.bold(job.data.type)}`
            )
          );

          const musicFetch = MusicFetch.getInstance();

          try {
            if (job.data.type === 'playlist' && job.data.playlistId) {
              await musicFetch.processPlaylistTracks(job.data.playlistId);
              return {
                success: true,
                message: `Processed playlist ${job.data.playlistId}`,
              };
            } else if (job.data.type === 'bulk') {
              const result = await musicFetch.processBulkTracks(
                job.data.trackIds
              );
              return {
                success: true,
                message: 'Processed bulk tracks',
                result,
              };
            } else {
              throw new Error(`Unknown job type: ${job.data.type}`);
            }
          } catch (error) {
            this.logger.log(
              color.red.bold(
                `Error processing MusicFetch job ${job.id}: ${error}`
              )
            );
            throw error;
          }
        },
        {
          connection: this.connection.duplicate(),
          concurrency: 1, // Process one job at a time to respect rate limits
        }
      );

      this.workers.push(worker);

      worker.on('completed', (job) => {
        this.logger.log(
          color.green.bold(
            `Worker ${i + 1} completed MusicFetch job: ${white.bold(
              job.id || 'unknown'
            )}`
          )
        );
      });

      worker.on('failed', (job, err) => {
        this.logger.log(
          color.red.bold(
            `Worker ${i + 1} failed MusicFetch job ${white.bold(
              job?.id || 'unknown'
            )}: ${err.message}`
          )
        );
      });
    }

    this.logger.log(
      color.green.bold(
        `Started ${white.bold(concurrency.toString())} MusicFetch worker(s)`
      )
    );
  }

  /**
   * Get queue status
   */
  public async getQueueStatus(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  /**
   * Pause the queue
   */
  public async pauseQueue(): Promise<void> {
    await this.queue.pause();
    this.logger.log(color.yellow.bold('MusicFetch queue paused'));
  }

  /**
   * Resume the queue
   */
  public async resumeQueue(): Promise<void> {
    await this.queue.resume();
    this.logger.log(color.green.bold('MusicFetch queue resumed'));
  }

  /**
   * Clear the queue
   */
  public async clearQueue(): Promise<void> {
    await this.queue.drain();
    this.logger.log(color.yellow.bold('MusicFetch queue cleared'));
  }

  /**
   * Close the queue and workers
   */
  public async close(): Promise<void> {
    await Promise.all([
      this.queue.close(),
      ...this.workers.map((w) => w.close()),
      this.queueEvents?.close(),
    ]);
    await this.connection.quit();
    this.logger.log(color.blue.bold('MusicFetchQueue closed'));
  }
}

export default MusicFetchQueue;
