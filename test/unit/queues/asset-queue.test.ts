import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * AssetQueue processor logic with BullMQ, Gemini, OpenAI and sharp all
 * mocked. Branding/product input images are real files in the scratch
 * dirs; generated "images" are written to PUBLIC_DIR by the processor so
 * the on-disk contract is asserted too.
 */

const holder = vi.hoisted(() => ({
  queueAdd: vi.fn(async (_name: string, data: any, opts: any) => ({
    id: opts?.jobId || 'job-1',
    data,
  })),
  workerProcessors: [] as ((job: any) => Promise<any>)[],
  generateContent: vi.fn(),
  imagesEdit: vi.fn(),
  prisma: {
    companyAsset: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
  },
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    duplicate() {
      return new FakeRedis();
    }
    on() {}
    quit = async () => undefined;
  }
  return { default: FakeRedis };
});

vi.mock('bullmq', () => ({
  Queue: class {
    add = holder.queueAdd;
    getWaitingCount = async () => 0;
    getActiveCount = async () => 0;
    getCompletedCount = async () => 0;
    getFailedCount = async () => 0;
    getDelayedCount = async () => 0;
  },
  QueueEvents: class {
    on() {}
  },
  Worker: class {
    constructor(_name: string, processor: (job: any) => Promise<any>) {
      holder.workerProcessors.push(processor);
    }
    on() {}
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => holder.prisma },
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: holder.generateContent };
  },
}));

vi.mock('openai', () => ({
  default: class {
    images = { edit: holder.imagesEdit };
  },
  toFile: vi.fn(async (buf: Buffer, name: string) => ({ name, size: buf.length })),
}));

// sharp would choke on our fake "jpegs"; pass buffers through unchanged.
vi.mock('sharp', () => ({
  default: (buf: Buffer) => ({
    png: () => ({ toBuffer: async () => buf }),
  }),
}));

import AssetQueue from '../../../src/assetQueue';

const queue = AssetQueue.getInstance();
const originalRunWorkers = process.env['RUN_QUEUE_WORKERS'];

const ASSETS_DIR = process.env['ASSETS_DIR']!;
const PUBLIC_DIR = process.env['PUBLIC_DIR']!;
const brandingPath = path.join(ASSETS_DIR, 'branding-test.png');
const FAKE_IMAGE_B64 = Buffer.from('generated-image').toString('base64');

beforeAll(() => {
  // Product photos the processor always reads (7 of them) + one branding image
  const productDir = path.join(ASSETS_DIR, 'images', 'product');
  fs.mkdirSync(productDir, { recursive: true });
  for (let i = 1; i <= 7; i++) {
    fs.writeFileSync(path.join(productDir, `product_${i}.jpg`), `jpg-${i}`);
  }
  fs.writeFileSync(brandingPath, 'branding-png');
});

afterAll(() => {
  process.env['RUN_QUEUE_WORKERS'] = originalRunWorkers;
});

function makeJob(overrides: Record<string, any> = {}) {
  return {
    id: 'asset-1',
    data: {
      companyAssetId: 31,
      companyId: 12,
      brandingImagePaths: [brandingPath],
      instructions: 'make it teal',
      llmProvider: 'gemini',
      ...overrides,
    },
    updateProgress: vi.fn(async () => undefined),
  };
}

function geminiImageResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            { text: 'here you go' },
            { inlineData: { data: FAKE_IMAGE_B64 } },
          ],
        },
      },
    ],
  };
}

let processor: (job: any) => Promise<any>;

beforeEach(() => {
  vi.clearAllMocks();
  holder.prisma.companyAsset.findUnique.mockResolvedValue({ id: 31 });
  holder.prisma.companyAsset.update.mockResolvedValue({});
  holder.workerProcessors.length = 0;
  process.env['RUN_QUEUE_WORKERS'] = 'true';
  queue.startWorkers(1);
  processor = holder.workerProcessors[0];
});

describe('queueAssetJob', () => {
  it('enqueues with an asset- prefixed job id', async () => {
    const id = await queue.queueAssetJob(makeJob().data as any);
    expect(id).toMatch(/^asset-\d+-[a-z0-9]+$/);
    expect(holder.queueAdd).toHaveBeenCalledWith(
      'generate-assets',
      expect.objectContaining({ companyAssetId: 31 }),
      { jobId: expect.stringMatching(/^asset-/) }
    );
  });

  it('rethrows enqueue failures', async () => {
    holder.queueAdd.mockRejectedValueOnce(new Error('redis gone'));
    await expect(queue.queueAssetJob(makeJob().data as any)).rejects.toThrow(
      'redis gone'
    );
  });
});

describe('startWorkers gate', () => {
  it('does not start workers unless RUN_QUEUE_WORKERS=true', () => {
    holder.workerProcessors.length = 0;
    process.env['RUN_QUEUE_WORKERS'] = 'false';
    queue.startWorkers(1);
    expect(holder.workerProcessors).toHaveLength(0);
  });
});

describe('processor (gemini path)', () => {
  it('skips jobs whose asset record was deleted', async () => {
    holder.prisma.companyAsset.findUnique.mockResolvedValueOnce(null);
    const result = await processor(makeJob());
    expect(result).toEqual({ success: false, error: 'Asset record deleted' });
    expect(holder.generateContent).not.toHaveBeenCalled();
    expect(holder.prisma.companyAsset.update).not.toHaveBeenCalled();
  });

  it('generates 7 rebranded product images and marks the asset completed', async () => {
    holder.generateContent.mockResolvedValue(geminiImageResponse());

    const job = makeJob({ companyAssetId: 32 });
    const result = await processor(job);

    expect(result.success).toBe(true);
    expect(result.images).toHaveLength(7);
    expect(holder.generateContent).toHaveBeenCalledTimes(7);

    // First call: prompt + branding + product, no reference image
    const firstParts = holder.generateContent.mock.calls[0][0].contents[0].parts;
    expect(firstParts[0].text).toContain('make it teal');
    expect(firstParts[0].text).not.toContain('reference image');
    expect(firstParts).toHaveLength(3); // prompt + 1 branding + product

    // Later calls include the first generated image as style reference
    const secondParts = holder.generateContent.mock.calls[1][0].contents[0].parts;
    expect(secondParts[0].text).toContain('reference image');
    expect(secondParts).toHaveLength(4); // prompt + branding + reference + product

    // Files were written to the company's asset output dir
    const outputDir = path.join(PUBLIC_DIR, 'companydata', 'assets', '12', '32');
    for (const filename of result.images!) {
      expect(filename).toMatch(/^product_\d_\d+\.png$/);
      expect(fs.readFileSync(path.join(outputDir, filename)).toString()).toBe(
        'generated-image'
      );
    }

    // Status walked generating -> completed with the images persisted
    const updates = holder.prisma.companyAsset.update.mock.calls.map(
      (c: any[]) => c[0].data
    );
    expect(updates[0]).toEqual({ status: 'generating' });
    const final = updates[updates.length - 1];
    expect(final.status).toBe('completed');
    expect(JSON.parse(final.images)).toHaveLength(7);
    expect(final.errorMessage).toBeNull();

    // Per-image progress was reported to both prisma and the job
    const progressUpdates = updates.filter((u: any) => u.progress !== undefined);
    expect(progressUpdates.map((u: any) => u.progress)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const jobStatuses = job.updateProgress.mock.calls.map((c: any[]) => c[0]);
    expect(jobStatuses[0]).toEqual({ status: 'initializing', completed: 0 });
    expect(jobStatuses[jobStatuses.length - 1]).toEqual({
      status: 'generating',
      completed: 7,
    });
  });

  it('marks the asset failed when no images come back', async () => {
    holder.generateContent.mockResolvedValue({ candidates: [] });

    const result = await processor(makeJob({ companyAssetId: 33 }));
    expect(result).toEqual({ success: false, images: [] });

    const final = holder.prisma.companyAsset.update.mock.calls.at(-1)![0].data;
    expect(final).toMatchObject({
      status: 'failed',
      errorMessage: 'No images were generated',
    });
  });

  it('keeps going when individual generations fail (partial success)', async () => {
    holder.generateContent
      .mockRejectedValueOnce(new Error('quota'))
      .mockResolvedValue(geminiImageResponse());

    const result = await processor(makeJob({ companyAssetId: 34 }));
    expect(result.success).toBe(true);
    expect(result.images).toHaveLength(6);
  });

  it('marks the asset failed and rethrows when setup blows up (worker catch path)', async () => {
    const job = makeJob({
      companyAssetId: 35,
      brandingImagePaths: [path.join(ASSETS_DIR, 'does-not-exist.png')],
    });

    await expect(processor(job)).rejects.toThrow();
    const failUpdate = holder.prisma.companyAsset.update.mock.calls.at(-1)![0];
    expect(failUpdate.where).toEqual({ id: 35 });
    expect(failUpdate.data.status).toBe('failed');
    expect(failUpdate.data.errorMessage).toContain('does-not-exist.png');
  });
});

describe('processor (openai path)', () => {
  it('generates images via images.edit with gpt-image-2', async () => {
    holder.imagesEdit.mockResolvedValue({
      data: [{ b64_json: FAKE_IMAGE_B64 }],
    });

    const result = await processor(
      makeJob({ companyAssetId: 36, llmProvider: 'openai' })
    );

    expect(result.success).toBe(true);
    expect(result.images).toHaveLength(7);
    expect(holder.generateContent).not.toHaveBeenCalled();
    expect(holder.imagesEdit).toHaveBeenCalledTimes(7);

    const firstCall = holder.imagesEdit.mock.calls[0][0];
    expect(firstCall.model).toBe('gpt-image-2');
    expect(firstCall.size).toBe('1024x1024');
    // First call: 1 branding + 1 product image
    expect(firstCall.image).toHaveLength(2);
    // Later calls also carry the first result as reference
    expect(holder.imagesEdit.mock.calls[1][0].image).toHaveLength(3);
  });

  it('counts empty responses as missing images', async () => {
    holder.imagesEdit.mockResolvedValue({ data: [{}] });
    const result = await processor(
      makeJob({ companyAssetId: 37, llmProvider: 'openai' })
    );
    expect(result).toEqual({ success: false, images: [] });
  });
});

describe('getQueueStatus', () => {
  it('aggregates queue counters', async () => {
    expect(await queue.getQueueStatus()).toEqual({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    });
  });
});
