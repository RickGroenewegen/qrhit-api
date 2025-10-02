import dotenv from 'dotenv';
import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import GeneratorQueue from './generatorQueue';
import MusicFetchQueue from './musicfetchQueue';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

dotenv.config({ quiet: true });

// Configure BigInt serialization
(BigInt.prototype as any).toJSON = function () {
  const int = Number.parseInt(this.toString());
  return int ?? this.toString();
};

// Initialize Sentry for production
if (process.env['ENVIRONMENT'] !== 'development') {
  Sentry.init({
    dsn: 'https://fbb350c809685382751c422a65a9766f@o1181344.ingest.us.sentry.io/4507950233223168',
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });
}

class QueueWorker {
  private logger = new Logger();
  private generatorQueue: GeneratorQueue;
  private musicFetchQueue: MusicFetchQueue;
  private shutdownInProgress = false;

  constructor() {
    this.generatorQueue = GeneratorQueue.getInstance();
    this.musicFetchQueue = MusicFetchQueue.getInstance();
    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    // Graceful shutdown on SIGTERM/SIGINT
    const gracefulShutdown = async (signal: string) => {
      if (this.shutdownInProgress) return;
      this.shutdownInProgress = true;

      this.logger.log(
        color.yellow.bold(`Received ${signal}, starting graceful shutdown...`)
      );

      try {
        await Promise.all([
          this.generatorQueue.shutdown(),
          this.musicFetchQueue.close(),
        ]);
        this.logger.log(color.green.bold('Worker shutdown complete'));
        process.exit(0);
      } catch (error) {
        this.logger.log(
          color.red.bold(`Error during shutdown: ${error}`)
        );
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  }

  public async start(): Promise<void> {
    const workerCount = parseInt(process.env['QUEUE_WORKERS'] || '2');
    const workerId = process.env['WORKER_ID'] || 'standalone';

    this.logger.log(
      blue.bold(`Starting queue worker process ${white.bold(workerId)}`)
    );

    if (!process.env['REDIS_URL']) {
      this.logger.log(
        color.red.bold('REDIS_URL environment variable is required for queue workers')
      );
      process.exit(1);
    }

    try {
      await this.generatorQueue.initializeWorkers(workerCount);

      // Start MusicFetch workers (1 worker to respect rate limits)
      this.musicFetchQueue.startWorkers(1);

      this.logger.log(
        color.green.bold(
          `Queue workers started successfully with ${white.bold(
            workerCount.toString()
          )} Generator workers and 1 MusicFetch worker`
        )
      );

      // Log queue status every 30 seconds
      setInterval(async () => {
        try {
          const [generatorStatus, musicFetchStatus] = await Promise.all([
            this.generatorQueue.getQueueStatus(),
            this.musicFetchQueue.getQueueStatus(),
          ]);

          this.logger.log(
            blue.bold('Generator Queue:') +
            ` Waiting: ${white.bold(generatorStatus.waiting.toString())}` +
            ` | Active: ${white.bold(generatorStatus.active.toString())}` +
            ` | Completed: ${white.bold(generatorStatus.completed.toString())}` +
            ` | Failed: ${white.bold(generatorStatus.failed.toString())}`
          );

          this.logger.log(
            blue.bold('MusicFetch Queue:') +
            ` Waiting: ${white.bold(musicFetchStatus.waiting.toString())}` +
            ` | Active: ${white.bold(musicFetchStatus.active.toString())}` +
            ` | Completed: ${white.bold(musicFetchStatus.completed.toString())}` +
            ` | Failed: ${white.bold(musicFetchStatus.failed.toString())}`
          );
        } catch (error) {
          this.logger.log(
            color.red.bold(`Error fetching queue status: ${error}`)
          );
        }
      }, 30000);

      // Keep the process alive
      process.stdin.resume();
    } catch (error) {
      this.logger.log(
        color.red.bold(`Failed to start worker: ${error}`)
      );
      process.exit(1);
    }
  }
}

// Start the worker
const worker = new QueueWorker();
worker.start().catch((error) => {
  console.error('Failed to start worker:', error);
  process.exit(1);
});