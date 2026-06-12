import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ExcelQueue logic with BullMQ fully mocked (same pattern as
 * generator-queue.test.ts): job enqueueing, the worker processor's
 * buffer revival + file writing, the RUN_QUEUE_WORKERS gate and the
 * job/queue status helpers.
 */

const holder = vi.hoisted(() => ({
  queueAdd: vi.fn(async (_name: string, data: any, opts: any) => ({
    id: opts?.jobId || 'job-1',
    data,
  })),
  queueGetJob: vi.fn(),
  counts: {
    getWaitingCount: vi.fn(async () => 1),
    getActiveCount: vi.fn(async () => 2),
    getCompletedCount: vi.fn(async () => 3),
    getFailedCount: vi.fn(async () => 4),
    getDelayedCount: vi.fn(async () => 5),
  },
  queueEventHandlers: new Map<string, (...args: any[]) => any>(),
  workerProcessors: [] as ((job: any) => Promise<any>)[],
  supplement: vi.fn(async () => Buffer.from('xlsx-result')),
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
    getJob = holder.queueGetJob;
    getWaitingCount = holder.counts.getWaitingCount;
    getActiveCount = holder.counts.getActiveCount;
    getCompletedCount = holder.counts.getCompletedCount;
    getFailedCount = holder.counts.getFailedCount;
    getDelayedCount = holder.counts.getDelayedCount;
    pause = async () => undefined;
    resume = async () => undefined;
    drain = async () => undefined;
    close = async () => undefined;
  },
  QueueEvents: class {
    on(event: string, handler: (...args: any[]) => any) {
      holder.queueEventHandlers.set(event, handler);
    }
    close = async () => undefined;
  },
  Worker: class {
    constructor(_name: string, processor: (job: any) => Promise<any>) {
      holder.workerProcessors.push(processor);
    }
    on() {}
    close = async () => undefined;
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

// The worker lazy-imports ./excel; the mock intercepts that dynamic import.
vi.mock('../../../src/excel', () => ({
  default: {
    getInstance: () => ({ supplementExcelWithQRLinks: holder.supplement }),
  },
}));

import ExcelQueue from '../../../src/excelQueue';

const queue = ExcelQueue.getInstance();
const originalRunWorkers = process.env['RUN_QUEUE_WORKERS'];

afterAll(() => {
  process.env['RUN_QUEUE_WORKERS'] = originalRunWorkers;
});

function jobData(overrides: Record<string, any> = {}) {
  return {
    fileBuffer: Buffer.from('input-xlsx'),
    originalFilename: 'tracks.xlsx',
    hasHeader: true,
    spotifyColumn: 2,
    outputColumn: 5,
    playlistName: 'My List',
    yearColumn: 3,
    clientIp: '1.2.3.4',
    ...overrides,
  };
}

describe('queueExcelJob', () => {
  beforeEach(() => holder.queueAdd.mockClear());

  it('enqueues with a unique excel- prefixed job id', async () => {
    const id = await queue.queueExcelJob(jobData() as any);
    expect(id).toMatch(/^excel-\d+-[a-z0-9]+$/);
    expect(holder.queueAdd).toHaveBeenCalledWith(
      'supplement-excel',
      expect.objectContaining({ originalFilename: 'tracks.xlsx' }),
      { jobId: expect.stringMatching(/^excel-/) }
    );
  });

  it('rethrows enqueue failures', async () => {
    holder.queueAdd.mockRejectedValueOnce(new Error('redis gone'));
    await expect(queue.queueExcelJob(jobData() as any)).rejects.toThrow(
      'redis gone'
    );
  });
});

describe('startWorkers gate', () => {
  it('does not start workers unless RUN_QUEUE_WORKERS=true', () => {
    holder.workerProcessors.length = 0;
    process.env['RUN_QUEUE_WORKERS'] = 'false';
    queue.startWorkers(2);
    expect(holder.workerProcessors).toHaveLength(0);
  });

  it('starts the requested number of workers when enabled', () => {
    holder.workerProcessors.length = 0;
    process.env['RUN_QUEUE_WORKERS'] = 'true';
    queue.startWorkers(2);
    expect(holder.workerProcessors).toHaveLength(2);
  });
});

describe('worker processor', () => {
  let processor: (job: any) => Promise<any>;

  beforeEach(() => {
    holder.supplement.mockClear();
    holder.supplement.mockResolvedValue(Buffer.from('xlsx-result'));
    holder.workerProcessors.length = 0;
    process.env['RUN_QUEUE_WORKERS'] = 'true';
    queue.startWorkers(1);
    processor = holder.workerProcessors[0];
  });

  function makeJob(data: Record<string, any>) {
    return {
      id: 'excel-1',
      data,
      updateProgress: vi.fn(async () => undefined),
    };
  }

  it('processes the file and writes the supplemented result to PUBLIC_DIR/excel', async () => {
    const job = makeJob(jobData());
    const result = await processor(job);

    expect(holder.supplement).toHaveBeenCalledWith(
      expect.any(Buffer),
      true,
      2,
      5,
      '1.2.3.4',
      'My List',
      3
    );

    expect(result.success).toBe(true);
    expect(result.filename).toMatch(/^supplemented_\d+_tracks\.xlsx$/);

    const written = path.join(
      process.env['PUBLIC_DIR']!,
      'excel',
      result.filename
    );
    expect(fs.readFileSync(written).toString()).toBe('xlsx-result');

    const statuses = job.updateProgress.mock.calls.map((c: any[]) => c[0].status);
    expect(statuses).toEqual(['initializing', 'saving', 'completed']);
  });

  it('revives Redis-serialized buffers ({type:Buffer,data:[...]}) before processing', async () => {
    const raw = Buffer.from('round-trip');
    const job = makeJob(
      jobData({ fileBuffer: { type: 'Buffer', data: Array.from(raw) } })
    );
    await processor(job);

    const received = holder.supplement.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(received)).toBe(true);
    expect(received.toString()).toBe('round-trip');
  });

  it('rethrows processing errors so BullMQ can retry', async () => {
    holder.supplement.mockRejectedValueOnce(new Error('bad spreadsheet'));
    await expect(processor(makeJob(jobData()))).rejects.toThrow(
      'bad spreadsheet'
    );
  });
});

describe('queue lifecycle and events', () => {
  it('registered completed/failed/progress event loggers that tolerate invocation', async () => {
    for (const event of ['completed', 'failed', 'progress'] as const) {
      const handler = holder.queueEventHandlers.get(event);
      expect(handler).toBeTruthy();
      await handler!({
        jobId: 'excel-1',
        failedReason: 'x',
        data: { status: 'saving' },
      });
    }
  });

  it('pause/resume/clear/close delegate to the underlying queue without throwing', async () => {
    await expect(queue.pauseQueue()).resolves.toBeUndefined();
    await expect(queue.resumeQueue()).resolves.toBeUndefined();
    await expect(queue.clearQueue()).resolves.toBeUndefined();
    await expect(queue.close()).resolves.toBeUndefined();
  });
});

describe('status helpers', () => {
  it('aggregates queue counters', async () => {
    expect(await queue.getQueueStatus()).toEqual({
      waiting: 1,
      active: 2,
      completed: 3,
      failed: 4,
      delayed: 5,
    });
  });

  it('returns null for unknown jobs', async () => {
    holder.queueGetJob.mockResolvedValueOnce(null);
    expect(await queue.getJobStatus('nope')).toBeNull();
  });

  it('maps job fields into the status payload', async () => {
    holder.queueGetJob.mockResolvedValueOnce({
      id: 'excel-9',
      getState: async () => 'completed',
      progress: { status: 'completed' },
      data: { originalFilename: 'a.xlsx' },
      returnvalue: { success: true, filename: 'out.xlsx' },
      failedReason: undefined,
    });

    expect(await queue.getJobStatus('excel-9')).toEqual({
      id: 'excel-9',
      state: 'completed',
      progress: { status: 'completed' },
      data: { originalFilename: 'a.xlsx' },
      returnvalue: { success: true, filename: 'out.xlsx' },
      failedReason: undefined,
    });
  });
});
