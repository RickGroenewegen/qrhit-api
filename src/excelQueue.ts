import { Queue, Worker, QueueEvents } from 'bullmq';
import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import Redis from 'ioredis';
import cluster from 'cluster';
import * as fs from 'fs/promises';
import * as path from 'path';

interface ExcelJobData {
  fileBuffer: Buffer;
  originalFilename: string;
  hasHeader: boolean;
  spotifyColumn: number;
  outputColumn: number;
  playlistName?: string;
  yearColumn?: number;
  clientIp: string;
}

interface ExcelJobResult {
  success: boolean;
  filename?: string;
  error?: string;
}

class ExcelQueue {
  private static instance: ExcelQueue;
  private queue: Queue<ExcelJobData>;
  private workers: Worker<ExcelJobData>[] = [];
  private queueEvents?: QueueEvents;
  private logger = new Logger();
  private connection: Redis;

  private constructor() {
    const redisUrl = process.env['REDIS_URL'] || 'redis://localhost:6379';

    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.queue = new Queue<ExcelJobData>('excel-supplement', {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: {
          count: 50,
          age: 24 * 3600, // 24 hours
        },
        removeOnFail: {
          count: 25,
          age: 48 * 3600, // 48 hours
        },
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    });

    // Only set up event listeners on the primary process
    if (cluster.isPrimary || !cluster.isWorker) {
      this.queueEvents = new QueueEvents('excel-supplement', {
        connection: this.connection.duplicate(),
      });

      this.setupEventListeners();
    }

    this.logger.log(
      color.blue.bold('ExcelQueue initialized successfully')
    );
  }

  public static getInstance(): ExcelQueue {
    if (!ExcelQueue.instance) {
      ExcelQueue.instance = new ExcelQueue();
    }
    return ExcelQueue.instance;
  }

  private setupEventListeners(): void {
    if (!this.queueEvents) return;

    this.queueEvents.on('completed', async ({ jobId }) => {
      this.logger.log(
        color.green.bold(
          `Excel job ${white.bold(jobId)} completed successfully`
        )
      );
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.log(
        color.red.bold(
          `Excel job ${white.bold(jobId)} failed: ${failedReason}`
        )
      );
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      this.logger.log(
        color.blue.bold(
          `Excel job ${white.bold(jobId)} progress: ${JSON.stringify(data)}`
        )
      );
    });
  }

  /**
   * Queue an Excel supplementation job
   */
  public async queueExcelJob(data: ExcelJobData): Promise<string> {
    try {
      const job = await this.queue.add(
        'supplement-excel',
        data,
        {
          jobId: `excel-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        }
      );

      this.logger.log(
        color.blue.bold(
          `Queued Excel supplementation for file ${white.bold(
            data.originalFilename
          )} with job ID: ${white.bold(job.id || 'unknown')}`
        )
      );

      return job.id || '';
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error queueing Excel job for ${data.originalFilename}: ${error}`
        )
      );
      throw error;
    }
  }

  /**
   * Start workers to process Excel jobs
   */
  public startWorkers(concurrency: number = 2): void {
    // Only start workers if RUN_QUEUE_WORKERS is enabled
    if (process.env['RUN_QUEUE_WORKERS'] !== 'true') {
      this.logger.log(
        color.yellow.bold(
          'Excel queue workers not started (RUN_QUEUE_WORKERS not enabled)'
        )
      );
      return;
    }

    for (let i = 0; i < concurrency; i++) {
      const worker = new Worker<ExcelJobData>(
        'excel-supplement',
        async (job) => {
          this.logger.log(
            color.blue.bold(
              `Processing Excel job ${white.bold(
                job.id || 'unknown'
              )} for file ${white.bold(job.data.originalFilename)}`
            )
          );

          try {
            // Lazy load Excel to avoid circular dependency
            const Excel = (await import('./excel')).default;
            const excel = Excel.getInstance();

            await job.updateProgress({ status: 'initializing' });

            // Convert fileBuffer back to Buffer if it was serialized by Redis
            let fileBuffer: Buffer = job.data.fileBuffer;
            if (fileBuffer && typeof fileBuffer === 'object' && !(fileBuffer instanceof Buffer)) {
              // When serialized through Redis, Buffer becomes {type: 'Buffer', data: [...]}
              const serialized = fileBuffer as any;
              if (serialized.type === 'Buffer' && Array.isArray(serialized.data)) {
                fileBuffer = Buffer.from(serialized.data);
              }
            }

            // Process the Excel file
            const resultBuffer = await excel.supplementExcelWithQRLinks(
              fileBuffer,
              job.data.hasHeader,
              job.data.spotifyColumn,
              job.data.outputColumn,
              job.data.clientIp,
              job.data.playlistName,
              job.data.yearColumn
            );

            await job.updateProgress({ status: 'saving' });

            // Save the file to PUBLIC_DIR/excel
            const publicDir = process.env['PUBLIC_DIR'];
            if (!publicDir) {
              throw new Error('PUBLIC_DIR environment variable not set');
            }

            const excelDir = path.join(publicDir, 'excel');

            // Ensure directory exists
            await fs.mkdir(excelDir, { recursive: true });

            const timestamp = Date.now();
            const filename = `supplemented_${timestamp}_${job.data.originalFilename}`;
            const filePath = path.join(excelDir, filename);

            await fs.writeFile(filePath, resultBuffer);

            await job.updateProgress({ status: 'completed' });

            this.logger.log(
              color.green.bold(
                `Excel job ${white.bold(
                  job.id || 'unknown'
                )} completed: ${white.bold(filename)}`
              )
            );

            return {
              success: true,
              filename,
            };
          } catch (error) {
            this.logger.log(
              color.red.bold(
                `Error processing Excel job ${job.id}: ${error}`
              )
            );
            throw error;
          }
        },
        {
          connection: this.connection.duplicate(),
          concurrency: 1, // Process one job at a time per worker
        }
      );

      this.workers.push(worker);

      worker.on('completed', (job) => {
        this.logger.log(
          color.green.bold(
            `Worker ${i + 1} completed Excel job: ${white.bold(
              job.id || 'unknown'
            )}`
          )
        );
      });

      worker.on('failed', (job, err) => {
        this.logger.log(
          color.red.bold(
            `Worker ${i + 1} failed Excel job ${white.bold(
              job?.id || 'unknown'
            )}: ${err.message}`
          )
        );
      });
    }

    this.logger.log(
      color.green.bold(
        `Started ${white.bold(concurrency.toString())} Excel worker(s)`
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
   * Get job status
   */
  public async getJobStatus(jobId: string): Promise<{
    id: string;
    state: string;
    progress: any;
    data: ExcelJobData;
    returnvalue?: ExcelJobResult;
    failedReason?: string;
  } | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return null;
    }

    const state = await job.getState();

    return {
      id: job.id || '',
      state,
      progress: job.progress,
      data: job.data,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  /**
   * Pause the queue
   */
  public async pauseQueue(): Promise<void> {
    await this.queue.pause();
    this.logger.log(color.yellow.bold('Excel queue paused'));
  }

  /**
   * Resume the queue
   */
  public async resumeQueue(): Promise<void> {
    await this.queue.resume();
    this.logger.log(color.green.bold('Excel queue resumed'));
  }

  /**
   * Clear the queue
   */
  public async clearQueue(): Promise<void> {
    await this.queue.drain();
    this.logger.log(color.yellow.bold('Excel queue cleared'));
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
    this.logger.log(color.blue.bold('ExcelQueue closed'));
  }
}

export default ExcelQueue;
