import dotenv from 'dotenv';
import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import GeneratorQueue from './generatorQueue';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

dotenv.config();

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
  private shutdownInProgress = false;

  constructor() {
    this.generatorQueue = GeneratorQueue.getInstance();
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
        await this.generatorQueue.shutdown();
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
      
      this.logger.log(
        color.green.bold(
          `Queue worker started successfully with ${white.bold(
            workerCount.toString()
          )} concurrent workers`
        )
      );

      // Log queue status every 30 seconds
      setInterval(async () => {
        try {
          const status = await this.generatorQueue.getQueueStatus();
          this.logger.log(
            blue.bold('Queue Status:') +
            ` Waiting: ${white.bold(status.waiting.toString())}` +
            ` | Active: ${white.bold(status.active.toString())}` +
            ` | Completed: ${white.bold(status.completed.toString())}` +
            ` | Failed: ${white.bold(status.failed.toString())}`
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