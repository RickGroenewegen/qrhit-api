import { Queue, Worker, QueueEvents } from 'bullmq';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import Redis from 'ioredis';
import cluster from 'cluster';
import * as fs from 'fs/promises';
import * as path from 'path';
import PrismaInstance from './prisma';
import { GoogleGenAI } from '@google/genai';
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';

interface AssetJobData {
  companyAssetId: number;
  companyId: number;
  brandingImagePaths: string[];
  instructions?: string;
  llmProvider: 'gemini' | 'openai';
}

interface AssetJobResult {
  success: boolean;
  images?: string[];
  error?: string;
}

const PRODUCT_IMAGE_COUNT = 7;


class AssetQueue {
  private static instance: AssetQueue;
  private queue: Queue<AssetJobData>;
  private workers: Worker<AssetJobData>[] = [];
  private queueEvents?: QueueEvents;
  private logger = new Logger();
  private connection: Redis;

  private constructor() {
    const redisUrl = process.env['REDIS_URL'] || 'redis://localhost:6379';

    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.queue = new Queue<AssetJobData>('company-assets', {
      connection: this.connection as any,
      defaultJobOptions: {
        removeOnComplete: {
          count: 50,
          age: 24 * 3600,
        },
        removeOnFail: {
          count: 25,
          age: 48 * 3600,
        },
        attempts: 1,
      },
    });

    if (cluster.isPrimary || !cluster.isWorker) {
      this.queueEvents = new QueueEvents('company-assets', {
        connection: this.connection.duplicate() as any,
      });

      this.setupEventListeners();
    }

    this.logger.log(
      color.blue.bold('AssetQueue initialized successfully')
    );
  }

  public static getInstance(): AssetQueue {
    if (!AssetQueue.instance) {
      AssetQueue.instance = new AssetQueue();
    }
    return AssetQueue.instance;
  }

  private setupEventListeners(): void {
    if (!this.queueEvents) return;

    this.queueEvents.on('completed', async ({ jobId }) => {
      this.logger.log(
        color.green.bold(
          `Asset job ${white.bold(jobId)} completed successfully`
        )
      );
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.log(
        color.red.bold(
          `Asset job ${white.bold(jobId)} failed: ${failedReason}`
        )
      );
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      this.logger.log(
        color.blue.bold(
          `Asset job ${white.bold(jobId)} progress: ${JSON.stringify(data)}`
        )
      );
    });
  }

  public async queueAssetJob(data: AssetJobData): Promise<string> {
    try {
      const job = await this.queue.add(
        'generate-assets',
        data,
        {
          jobId: `asset-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        }
      );

      this.logger.log(
        color.blue.bold(
          `Queued asset generation for company asset ${white.bold(
            data.companyAssetId.toString()
          )} with job ID: ${white.bold(job.id || 'unknown')}`
        )
      );

      return job.id || '';
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error queueing asset job for company asset ${data.companyAssetId}: ${error}`
        )
      );
      throw error;
    }
  }

  public startWorkers(concurrency: number = 1): void {
    if (process.env['RUN_QUEUE_WORKERS'] !== 'true') {
      this.logger.log(
        color.yellow.bold(
          'Asset queue workers not started (RUN_QUEUE_WORKERS not enabled)'
        )
      );
      return;
    }

    for (let i = 0; i < concurrency; i++) {
      const worker = new Worker<AssetJobData>(
        'company-assets',
        async (job) => {
          this.logger.log(
            color.blue.bold(
              `Processing asset job ${white.bold(
                job.id || 'unknown'
              )} for company asset ${white.bold(job.data.companyAssetId.toString())}`
            )
          );

          try {
            return await this.processAssetJob(job);
          } catch (error) {
            this.logger.log(
              color.red.bold(
                `Error processing asset job ${job.id}: ${error}`
              )
            );

            // Mark the asset as failed
            const prisma = PrismaInstance.getInstance();
            await prisma.companyAsset.update({
              where: { id: job.data.companyAssetId },
              data: {
                status: 'failed',
                errorMessage: error instanceof Error ? error.message : String(error),
              },
            });

            throw error;
          }
        },
        {
          connection: this.connection.duplicate() as any,
          concurrency: 1,
        }
      );

      this.workers.push(worker);

      worker.on('completed', (job) => {
        this.logger.log(
          color.green.bold(
            `Worker ${i + 1} completed asset job: ${white.bold(
              job.id || 'unknown'
            )}`
          )
        );
      });

      worker.on('failed', (job, err) => {
        this.logger.log(
          color.red.bold(
            `Worker ${i + 1} failed asset job ${white.bold(
              job?.id || 'unknown'
            )}: ${err.message}`
          )
        );
      });
    }

    this.logger.log(
      color.blue.bold(
        `Started ${white.bold(concurrency.toString())} asset worker(s)`
      )
    );
  }

  private async processAssetJob(job: any): Promise<AssetJobResult> {
    const prisma = PrismaInstance.getInstance();
    const { companyAssetId, companyId, brandingImagePaths, instructions, llmProvider } = job.data;
    const extraInstructions = instructions ? `\nAdditional instructions from the user: ${instructions}` : '';

    // Skip if the asset record was deleted
    const existing = await prisma.companyAsset.findUnique({ where: { id: companyAssetId } });
    if (!existing) {
      this.logger.log(color.yellow.bold(`Asset job ${job.id}: record ${companyAssetId} no longer exists, skipping`));
      return { success: false, error: 'Asset record deleted' };
    }

    await prisma.companyAsset.update({
      where: { id: companyAssetId },
      data: { status: 'generating' },
    });
    await job.updateProgress({ status: 'initializing', completed: 0 });

    // Read branding images as buffers
    const brandingBuffers: { buffer: Buffer; mimeType: string; ext: string }[] = [];
    for (const imgPath of brandingImagePaths) {
      const buffer = await fs.readFile(imgPath);
      const ext = path.extname(imgPath).toLowerCase();
      brandingBuffers.push({ buffer, mimeType: ext === '.png' ? 'image/png' : 'image/jpeg', ext });
    }

    // Read the 7 product images
    const assetsDir = process.env['ASSETS_DIR'];
    if (!assetsDir) throw new Error('ASSETS_DIR environment variable not set');
    const productDir = path.join(assetsDir, 'images', 'product');
    const productBuffers: Buffer[] = [];
    for (let i = 1; i <= PRODUCT_IMAGE_COUNT; i++) {
      productBuffers.push(await fs.readFile(path.join(productDir, `product_${i}.jpg`)));
    }

    // Ensure output directory
    const publicDir = process.env['PUBLIC_DIR'];
    if (!publicDir) throw new Error('PUBLIC_DIR environment variable not set');
    const outputDir = path.join(publicDir, 'companydata', 'assets', companyId.toString(), companyAssetId.toString());
    await fs.mkdir(outputDir, { recursive: true });

    const basePrompt = `You are a professional product photographer and brand designer. I'm providing company branding images that define a company's visual identity, plus a product photograph of a QRSong gift box/card on a table.

Generate a new version of the product photograph that incorporates the company's brand identity:
- Keep the exact same background, table surface, lighting, and scene composition — only modify the product itself
- Do NOT change or replace the table/background — it must remain identical to the original photo
- Apply the company's color scheme, visual style, and brand aesthetic to the box/card
- If there's a logo, incorporate it on the product surface
- Keep the same materials — do not change cardboard to plastic or vice versa
- Keep all existing text on cards visible (artist names, song titles, years, QR codes)
- Do NOT invent or add random QR codes anywhere on the product or cards
- Do NOT add any QR codes that aren't already in the original photo
- Generate exactly one image, not a collage or comparison
${extraInstructions}`;

    const generatedImages: string[] = [];
    let firstImageBuffer: Buffer | null = null;

    if (llmProvider === 'openai') {
      await this.generateWithOpenAI(job, basePrompt, brandingBuffers, productBuffers, outputDir, generatedImages, firstImageBuffer, companyAssetId, prisma);
    } else {
      await this.generateWithGemini(job, basePrompt, brandingBuffers, productBuffers, outputDir, generatedImages, firstImageBuffer, companyAssetId, prisma);
    }

    const finalStatus = generatedImages.length > 0 ? 'completed' : 'failed';
    await prisma.companyAsset.update({
      where: { id: companyAssetId },
      data: {
        status: finalStatus,
        images: JSON.stringify(generatedImages),
        errorMessage: generatedImages.length === 0 ? 'No images were generated' : null,
      },
    });

    this.logger.log(
      color.green.bold(
        `Asset job ${white.bold(job.id || 'unknown')} (${llmProvider}) finished: ${generatedImages.length}/${PRODUCT_IMAGE_COUNT} images generated`
      )
    );

    return { success: generatedImages.length > 0, images: generatedImages };
  }

  private async generateWithGemini(
    job: any, basePrompt: string,
    brandingBuffers: { buffer: Buffer; mimeType: string }[],
    productBuffers: Buffer[], outputDir: string,
    generatedImages: string[], firstImageBuffer: Buffer | null,
    companyAssetId: number, prisma: any,
  ): Promise<void> {
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY environment variable not set');
    const savedGoogleKey = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    const ai = new GoogleGenAI({ apiKey });
    if (savedGoogleKey) process.env['GOOGLE_API_KEY'] = savedGoogleKey;

    const brandingParts = brandingBuffers.map(b => ({
      inlineData: { data: b.buffer.toString('base64'), mimeType: b.mimeType },
    }));

    for (let i = 0; i < PRODUCT_IMAGE_COUNT; i++) {
      this.logger.log(color.blue.bold(`Asset job ${white.bold(job.id || 'unknown')} (gemini): image ${i + 1}/${PRODUCT_IMAGE_COUNT}`));

      try {
        const isFirst = i === 0;
        const parts: any[] = [];

        if (isFirst) {
          parts.push({ text: basePrompt });
        } else {
          parts.push({ text: basePrompt + '\n\nI am also providing a reference image — use it ONLY to copy the brand colors, logo, and design style. The LAST image is the product photo you must rebrand. Keep that product photo\'s exact composition and layout.' });
        }

        parts.push(...brandingParts);
        if (!isFirst && firstImageBuffer) {
          parts.push({ inlineData: { data: firstImageBuffer.toString('base64'), mimeType: 'image/png' } });
        }
        parts.push({ inlineData: { data: productBuffers[i].toString('base64'), mimeType: 'image/jpeg' } });

        const response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-image-preview',
          contents: [{ role: 'user', parts }],
          config: { responseModalities: ['TEXT', 'IMAGE'] },
        });

        let saved = false;
        if (response.candidates?.[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData?.data) {
              const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
              const filename = `product_${i + 1}_${Date.now()}.png`;
              await fs.writeFile(path.join(outputDir, filename), imageBuffer);
              generatedImages.push(filename);
              saved = true;
              if (isFirst) firstImageBuffer = imageBuffer;
              break;
            }
          }
        }

        if (!saved) {
          this.logger.log(color.yellow.bold(`Asset job ${job.id} (gemini): no image for product ${i + 1}`));
        }
      } catch (error) {
        this.logger.log(color.red.bold(`Asset job ${job.id} (gemini): error image ${i + 1}: ${error}`));
      }

      await prisma.companyAsset.update({ where: { id: companyAssetId }, data: { progress: i + 1 } });
      await job.updateProgress({ status: 'generating', completed: i + 1 });
    }
  }

  private async generateWithOpenAI(
    job: any, basePrompt: string,
    brandingBuffers: { buffer: Buffer; mimeType: string; ext: string }[],
    productBuffers: Buffer[], outputDir: string,
    generatedImages: string[], firstImageBuffer: Buffer | null,
    companyAssetId: number, prisma: any,
  ): Promise<void> {
    const openai = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] || process.env['OPENAI_TOKEN'] });

    for (let i = 0; i < PRODUCT_IMAGE_COUNT; i++) {
      this.logger.log(color.blue.bold(`Asset job ${white.bold(job.id || 'unknown')} (openai): image ${i + 1}/${PRODUCT_IMAGE_COUNT}`));

      try {
        const isFirst = i === 0;
        let prompt = basePrompt;
        if (!isFirst && firstImageBuffer) {
          prompt += '\n\nThe first images are branding references. Use them ONLY to copy the brand colors, logo, and design style. The LAST image is the product photo you must rebrand. Keep that product photo\'s exact composition and layout.';
        }

        // OpenAI images.edit: branding images + optional reference + product image
        // Convert all images to PNG via sharp to ensure valid format
        const imageInputs: any[] = [];
        for (let b = 0; b < brandingBuffers.length; b++) {
          const pngBuf = await sharp(brandingBuffers[b].buffer).png().toBuffer();
          imageInputs.push(await toFile(pngBuf, `branding_${b}.png`, { type: 'image/png' }));
        }
        if (!isFirst && firstImageBuffer) {
          imageInputs.push(await toFile(firstImageBuffer, 'reference.png', { type: 'image/png' }));
        }
        const productPng = await sharp(productBuffers[i]).png().toBuffer();
        imageInputs.push(await toFile(productPng, `product_${i + 1}.png`, { type: 'image/png' }));

        const response = await openai.images.edit({
          model: 'gpt-image-1.5',
          image: imageInputs.length === 1 ? imageInputs[0] : imageInputs,
          prompt,
          size: '1024x1024',
        });

        if (response.data?.[0]?.b64_json) {
          const imageBuffer = Buffer.from(response.data[0].b64_json, 'base64');
          const filename = `product_${i + 1}_${Date.now()}.png`;
          await fs.writeFile(path.join(outputDir, filename), imageBuffer);
          generatedImages.push(filename);
          if (isFirst) firstImageBuffer = imageBuffer;
        } else {
          this.logger.log(color.yellow.bold(`Asset job ${job.id} (openai): no image for product ${i + 1}`));
        }
      } catch (error) {
        this.logger.log(color.red.bold(`Asset job ${job.id} (openai): error image ${i + 1}: ${error}`));
      }

      await prisma.companyAsset.update({ where: { id: companyAssetId }, data: { progress: i + 1 } });
      await job.updateProgress({ status: 'generating', completed: i + 1 });
    }
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

  public async close(): Promise<void> {
    await Promise.all([
      this.queue.close(),
      ...this.workers.map((w) => w.close()),
      this.queueEvents?.close(),
    ]);
    await this.connection.quit();
    this.logger.log(color.blue.bold('AssetQueue closed'));
  }
}

export default AssetQueue;
