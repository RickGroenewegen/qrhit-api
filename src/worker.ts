import dotenv from 'dotenv';
import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import GeneratorQueue from './generatorQueue';
import ExcelQueue from './excelQueue';
import ErrorTracking from './errorTracking';

dotenv.config({ quiet: true });
ErrorTracking.getInstance().init('worker');

// Configure BigInt serialization
(BigInt.prototype as any).toJSON = function () {
  const int = Number.parseInt(this.toString());
  return int ?? this.toString();
};

class QueueWorker {
  private logger = new Logger();
  private generatorQueue: GeneratorQueue;
  private excelQueue: ExcelQueue;
  private shutdownInProgress = false;

  constructor() {
    this.generatorQueue = GeneratorQueue.getInstance();
    this.excelQueue = ExcelQueue.getInstance();
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
          this.excelQueue.close(),
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

      // Start Excel workers (2 workers for concurrent Excel processing)
      this.excelQueue.startWorkers(2);

      this.logger.log(
        color.green.bold(
          `Queue workers started successfully with ${white.bold(
            workerCount.toString()
          )} Generator workers and 2 Excel workers`
        )
      );

      // Log queue status every 30 seconds
      setInterval(async () => {
        try {
          const [generatorStatus, excelStatus] = await Promise.all([
            this.generatorQueue.getQueueStatus(),
            this.excelQueue.getQueueStatus(),
          ]);

          this.logger.log(
            blue.bold('Generator Queue:') +
            ` Waiting: ${white.bold(generatorStatus.waiting.toString())}` +
            ` | Active: ${white.bold(generatorStatus.active.toString())}` +
            ` | Completed: ${white.bold(generatorStatus.completed.toString())}` +
            ` | Failed: ${white.bold(generatorStatus.failed.toString())}`
          );

          this.logger.log(
            blue.bold('Excel Queue:') +
            ` Waiting: ${white.bold(excelStatus.waiting.toString())}` +
            ` | Active: ${white.bold(excelStatus.active.toString())}` +
            ` | Completed: ${white.bold(excelStatus.completed.toString())}` +
            ` | Failed: ${white.bold(excelStatus.failed.toString())}`
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