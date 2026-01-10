import { Queue, Worker, QueueEvents } from 'bullmq';
import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import Mollie from './mollie';
import Redis from 'ioredis';
import cluster from 'cluster';
import PrismaInstance from './prisma';
import Translation from './translation';
import { promises as fs } from 'fs';

interface GenerateJobData {
  paymentId: string;
  ip: string;
  refreshPlaylists: string;
  forceFinalize?: boolean;
  skipMainMail?: boolean;
  onlyProductMail?: boolean;
  userAgent?: string;
  onCompleteData?:
    | {
        // Instead of callback ID, store the data needed to recreate the callback
        type: 'checkPrinter';
        paymentId: string;
        clientIp: string;
        paymentHasPlaylistId?: number;
      }
    | {
        type: 'sendDigitalEmail';
        paymentId: string;
        playlistId: string;
        userHash: string;
      };
}

class GeneratorQueue {
  private static instance: GeneratorQueue;
  private queue: Queue<GenerateJobData>;
  private workers: Worker<GenerateJobData>[] = [];
  private queueEvents?: QueueEvents;
  private logger = new Logger();
  private connection: Redis;

  private constructor() {
    const redisUrl = process.env['REDIS_URL'] || 'redis://localhost:6379';

    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.queue = new Queue<GenerateJobData>('generator', {
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
          delay: 2000,
        },
      },
    });

    // Only set up event listeners on the primary/master process
    // to avoid duplicate logging from all cluster workers
    if (cluster.isPrimary || !cluster.isWorker) {
      this.queueEvents = new QueueEvents('generator', {
        connection: this.connection.duplicate(),
      });

      this.setupEventListeners();
    }
  }

  public static getInstance(): GeneratorQueue {
    if (!GeneratorQueue.instance) {
      GeneratorQueue.instance = new GeneratorQueue();
    }
    return GeneratorQueue.instance;
  }

  private setupEventListeners(): void {
    if (!this.queueEvents) return;

    this.queueEvents.on('completed', async ({ jobId, returnvalue }) => {
      // this.logger.log(
      //   color.green.bold(`Job ${white.bold(jobId)} completed successfully`)
      // );

      // Check if there's callback data for this job
      const job = await this.queue.getJob(jobId);
      if (job?.data.onCompleteData) {
        try {
          await this.executeCallback(job.data.onCompleteData);
          this.logger.log(
            color.green.bold(
              `Executed completion callback for job ${white.bold(jobId)}`
            )
          );
        } catch (error) {
          this.logger.log(
            color.red.bold(
              `Error executing callback for job ${white.bold(jobId)}: ${error}`
            )
          );
        }
      }
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.log(
        color.red.bold(
          `Job ${white.bold(jobId)} failed: ${white.bold(failedReason)}`
        )
      );
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      // this.logger.log(
      //   blue.bold(
      //     `Job ${white.bold(jobId)} progress: ${white.bold(
      //       JSON.stringify(data)
      //     )}`
      //   )
      // );
    });
  }

  private async executeCallback(
    callbackData: GenerateJobData['onCompleteData']
  ): Promise<void> {
    if (!callbackData) return;

    // Recreate and execute the callback based on its type
    if (callbackData.type === 'checkPrinter') {
      // Set eligableForPrinter to true now that PDFs are regenerated
      if (callbackData.paymentHasPlaylistId) {
        const prisma = PrismaInstance.getInstance();
        await prisma.paymentHasPlaylist.update({
          where: { id: callbackData.paymentHasPlaylistId },
          data: {
            eligableForPrinter: true,
            eligableForPrinterAt: new Date(),
          },
        });
      }

      // Lazy load to avoid circular dependency
      const Suggestion = (await import('./suggestion')).default;
      const suggestion = Suggestion.getInstance();
      await (suggestion as any).checkIfReadyForPrinter(
        callbackData.paymentId,
        callbackData.clientIp
      );
    } else if (callbackData.type === 'sendDigitalEmail') {
      // Send digital list email after PDF generation completes
      const Mail = (await import('./mail')).default;
      const mail = Mail.getInstance();
      const prisma = PrismaInstance.getInstance();

      // Get payment with user info
      const payment = await prisma.payment.findFirst({
        where: { paymentId: callbackData.paymentId },
        include: {
          user: {
            select: { hash: true },
          },
        },
      });

      if (!payment) {
        this.logger.log(
          color.red.bold(
            `Payment not found for digital email: ${callbackData.paymentId}`
          )
        );
        return;
      }

      // Get playlist info
      // Dynamically build description fields select based on available locales
      const allLocales = new Translation().allLocales;
      const descriptionFields = allLocales.reduce((acc, locale) => {
        acc[`description_${locale}`] = true;
        return acc;
      }, {} as Record<string, boolean>);

      const playlist = await prisma.playlist.findFirst({
        where: { playlistId: callbackData.playlistId },
        select: {
          id: true,
          playlistId: true,
          name: true,
          image: true,
          numberOfTracks: true,
          featured: true,
          ...descriptionFields,
        },
      });

      if (!playlist) {
        this.logger.log(
          color.red.bold(
            `Playlist not found for digital email: ${callbackData.playlistId}`
          )
        );
        return;
      }

      // Format playlist for email - use locale-specific description or fallback to English
      const description =
        (playlist as any)[`description_${payment.locale}`] ||
        (playlist as any)['description_en'] ||
        '';

      const playlistForEmail = {
        id: playlist.id.toString(),
        playlistId: playlist.playlistId,
        name: playlist.name,
        description,
        image: playlist.image,
        numberOfTracks: playlist.numberOfTracks,
        featured: playlist.featured,
      };

      // Send the digital list email
      await mail.sendEmail('digital', payment, [playlistForEmail], '', '');

      this.logger.log(
        color.green.bold(
          `Digital list email sent for payment ${white.bold(
            callbackData.paymentId
          )}`
        )
      );

      // Clear suggestionsPending flag to allow user to make more changes
      await prisma.paymentHasPlaylist.updateMany({
        where: {
          paymentId: payment.id,
          playlistId: playlist.id,
        },
        data: {
          suggestionsPending: false,
        },
      });

      this.logger.log(
        color.blue.bold(
          `Cleared suggestionsPending flag for payment ${callbackData.paymentId} - user can now make more changes`
        )
      );
    }
  }

  public async addGenerateJob(
    data: GenerateJobData
  ): Promise<string> {
    const job = await this.queue.add('generate', data, {
      priority: data.forceFinalize ? 1 : 10,
    });

    this.logger.log(
      blue.bold(
        `Added generate job to queue for payment: ${white.bold(
          data.paymentId
        )} with job ID: ${white.bold(job.id || 'unknown')}${
          data.onCompleteData ? ' (with completion callback)' : ''
        }`
      )
    );

    return job.id || '';
  }

  public async initializeWorkers(concurrency: number = 2): Promise<void> {
    this.logger.log(
      blue.bold(
        `Initializing ${white.bold(
          concurrency.toString()
        )} workers for generator queue`
      )
    );

    for (let i = 0; i < concurrency; i++) {
      const worker = new Worker<GenerateJobData>(
        'generator',
        async (job) => {
          const {
            paymentId,
            ip,
            refreshPlaylists,
            forceFinalize,
            skipMainMail,
            onlyProductMail,
            userAgent,
          } = job.data;

          this.logger.log(
            blue.bold(
              `Worker ${white.bold(i + 1)} processing job ${white.bold(
                job.id || 'unknown'
              )} for payment: ${white.bold(paymentId)}`
            )
          );

          await job.updateProgress({ status: 'initializing', workerId: i + 1 });

          try {
            // Lazy load Generator to avoid circular dependency
            const Generator = (await import('./generator')).default;
            const generator = Generator.getInstance();
            const mollie = new Mollie();

            await job.updateProgress({ status: 'processing', workerId: i + 1 });

            await generator.generate(
              paymentId,
              ip,
              refreshPlaylists,
              mollie,
              forceFinalize || false,
              skipMainMail || false,
              onlyProductMail || false,
              userAgent || ''
            );

            await job.updateProgress({ status: 'completed', workerId: i + 1 });

            this.logger.log(
              color.green.bold(
                `Worker ${white.bold(i + 1)} completed job ${white.bold(
                  job.id || 'unknown'
                )} for payment: ${white.bold(paymentId)}`
              )
            );

            return { success: true, paymentId, workerId: i + 1 };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            this.logger.log(
              color.red.bold(
                `Worker ${white.bold(i + 1)} error processing job ${white.bold(
                  job.id || 'unknown'
                )}:\n  Message: ${errorMessage}${errorStack ? `\n  Stack: ${errorStack}` : ''}`
              )
            );
            throw error;
          }
        },
        {
          connection: this.connection.duplicate(),
          concurrency: 1,
          autorun: true,
        }
      );

      worker.on('error', (error) => {
        this.logger.log(
          color.red.bold(`Worker ${i + 1} error: ${error.message}`)
        );
      });

      this.workers.push(worker);
    }

    this.logger.log(
      color.green.bold(
        `Successfully initialized ${white.bold(
          concurrency.toString()
        )} BullMQ workers`
      )
    );
  }

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

  public async getDetailedQueueStatus(): Promise<{
    counts: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      paused: number;
    };
    jobs: {
      waiting: any[];
      active: any[];
      completed: any[];
      failed: any[];
      delayed: any[];
    };
    queueInfo: {
      isPaused: boolean;
      name: string;
      workerCount: number;
    };
  }> {
    const [
      waiting,
      active,
      completed,
      failed,
      delayed,
      waitingJobs,
      activeJobs,
      completedJobs,
      failedJobs,
      delayedJobs,
      isPaused,
    ] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
      this.queue.getWaiting(0, 50),
      this.queue.getActive(0, 50),
      this.queue.getCompleted(0, 50),
      this.queue.getFailed(0, 50),
      this.queue.getDelayed(0, 50),
      this.queue.isPaused(),
    ]);

    const formatJob = (job: any) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      opts: {
        attempts: job.opts?.attempts,
        delay: job.opts?.delay,
        priority: job.opts?.priority,
      },
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn,
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
      stacktrace: job.stacktrace,
    });

    return {
      counts: {
        waiting,
        active,
        completed,
        failed,
        delayed,
        paused: isPaused ? 1 : 0,
      },
      jobs: {
        waiting: waitingJobs.map(formatJob),
        active: activeJobs.map(formatJob),
        completed: completedJobs.map(formatJob),
        failed: failedJobs.map(formatJob),
        delayed: delayedJobs.map(formatJob),
      },
      queueInfo: {
        isPaused,
        name: this.queue.name,
        workerCount: this.workers.length,
      },
    };
  }

  public async getJobsByStatus(
    status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed',
    start: number = 0,
    end: number = 50
  ): Promise<any[]> {
    let jobs: any[] = [];

    switch (status) {
      case 'waiting':
        jobs = await this.queue.getWaiting(start, end);
        break;
      case 'active':
        jobs = await this.queue.getActive(start, end);
        break;
      case 'completed':
        jobs = await this.queue.getCompleted(start, end);
        break;
      case 'failed':
        jobs = await this.queue.getFailed(start, end);
        break;
      case 'delayed':
        jobs = await this.queue.getDelayed(start, end);
        break;
    }

    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      opts: job.opts,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn,
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
      stacktrace: job.stacktrace,
    }));
  }

  public async retryJob(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (job && (await job.isFailed())) {
      await job.retry();
    }
  }

  public async removeJob(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (job) {
      await job.remove();
    }
  }

  public async pauseQueue(): Promise<void> {
    await this.queue.pause();
  }

  public async resumeQueue(): Promise<void> {
    await this.queue.resume();
  }

  public async getJobStatus(jobId: string): Promise<any> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn,
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
    };
  }

  public async shutdown(): Promise<void> {
    this.logger.log(blue.bold('Shutting down generator queue...'));

    // Only close queueEvents if it was initialized (on primary process)
    if (this.queueEvents) {
      await this.queueEvents.close();
    }

    for (const worker of this.workers) {
      await worker.close();
    }

    await this.queue.close();
    this.connection.disconnect();

    this.logger.log(color.green.bold('Generator queue shut down successfully'));
  }

  public async clearQueue(): Promise<void> {
    await this.queue.drain();
    this.logger.log(color.yellow.bold('Queue has been cleared'));
  }

  public async retryFailedJobs(): Promise<void> {
    const failedJobs = await this.queue.getFailed();
    for (const job of failedJobs) {
      await job.retry();
    }
    this.logger.log(
      blue.bold(
        `Retrying ${white.bold(failedJobs.length.toString())} failed jobs`
      )
    );
  }
}

export default GeneratorQueue;
