import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * MusicFetchQueue with BullMQ mocked: enqueue payloads/job ids, the
 * worker processor's playlist/bulk dispatch and its unknown-type guard.
 */

const holder = vi.hoisted(() => ({
  queueAdd: vi.fn(async (_name: string, data: any, opts: any) => ({
    id: opts?.jobId || 'job-1',
    data,
  })),
  workerProcessors: [] as ((job: any) => Promise<any>)[],
  queueEventHandlers: new Map<string, (...args: any[]) => any>(),
  processPlaylistTracks: vi.fn(async () => undefined),
  processBulkTracks: vi.fn(async () => ({
    totalProcessed: 2,
    successful: 2,
    failed: 0,
    skipped: 0,
    errors: [],
  })),
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
    getWaitingCount = async () => 6;
    getActiveCount = async () => 0;
    getCompletedCount = async () => 1;
    getFailedCount = async () => 0;
    getDelayedCount = async () => 0;
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

vi.mock('../../../src/musicfetch', () => ({
  default: {
    getInstance: () => ({
      processPlaylistTracks: holder.processPlaylistTracks,
      processBulkTracks: holder.processBulkTracks,
    }),
  },
}));

import MusicFetchQueue from '../../../src/musicfetchQueue';

const queue = MusicFetchQueue.getInstance();
const originalRunWorkers = process.env['RUN_QUEUE_WORKERS'];

afterAll(() => {
  process.env['RUN_QUEUE_WORKERS'] = originalRunWorkers;
});

describe('enqueueing', () => {
  beforeEach(() => holder.queueAdd.mockClear());

  it('queues playlist jobs with the playlist id embedded in the job id', async () => {
    const id = await queue.queuePlaylist(123);
    expect(id).toMatch(/^playlist-123-\d+$/);
    expect(holder.queueAdd).toHaveBeenCalledWith(
      'process-playlist',
      { type: 'playlist', playlistId: 123 },
      { jobId: expect.stringMatching(/^playlist-123-/) }
    );
  });

  it('queues bulk jobs with optional track ids', async () => {
    const id = await queue.queueBulkTracks([7, 8]);
    expect(id).toMatch(/^bulk-\d+$/);
    expect(holder.queueAdd).toHaveBeenCalledWith(
      'process-bulk',
      { type: 'bulk', trackIds: [7, 8] },
      { jobId: expect.stringMatching(/^bulk-/) }
    );

    await queue.queueBulkTracks();
    expect(holder.queueAdd).toHaveBeenLastCalledWith(
      'process-bulk',
      { type: 'bulk', trackIds: undefined },
      expect.anything()
    );
  });

  it('rethrows enqueue failures', async () => {
    holder.queueAdd.mockRejectedValueOnce(new Error('redis gone'));
    await expect(queue.queuePlaylist(1)).rejects.toThrow('redis gone');
  });
});

describe('queue lifecycle, events and status', () => {
  it('aggregates queue counters', async () => {
    expect(await queue.getQueueStatus()).toEqual({
      waiting: 6,
      active: 0,
      completed: 1,
      failed: 0,
      delayed: 0,
    });
  });

  it('registered completed/failed/progress event loggers that tolerate invocation', async () => {
    for (const event of ['completed', 'failed', 'progress'] as const) {
      const handler = holder.queueEventHandlers.get(event);
      expect(handler).toBeTruthy();
      await handler!({ jobId: 'j1', failedReason: 'x', data: {} });
    }
  });

  it('pause/resume/clear/close delegate to the underlying queue without throwing', async () => {
    await expect(queue.pauseQueue()).resolves.toBeUndefined();
    await expect(queue.resumeQueue()).resolves.toBeUndefined();
    await expect(queue.clearQueue()).resolves.toBeUndefined();
    await expect(queue.close()).resolves.toBeUndefined();
  });
});

describe('worker processor', () => {
  let processor: (job: any) => Promise<any>;

  beforeEach(() => {
    holder.processPlaylistTracks.mockClear();
    holder.processBulkTracks.mockClear();
    holder.workerProcessors.length = 0;
    process.env['RUN_QUEUE_WORKERS'] = 'true';
    queue.startWorkers(1);
    processor = holder.workerProcessors[0];
  });

  it('is gated behind RUN_QUEUE_WORKERS', () => {
    holder.workerProcessors.length = 0;
    process.env['RUN_QUEUE_WORKERS'] = 'false';
    queue.startWorkers(3);
    expect(holder.workerProcessors).toHaveLength(0);
  });

  it('dispatches playlist jobs to processPlaylistTracks', async () => {
    const result = await processor({
      id: 'j1',
      data: { type: 'playlist', playlistId: 55 },
    });
    expect(holder.processPlaylistTracks).toHaveBeenCalledWith(55);
    expect(result).toEqual({ success: true, message: 'Processed playlist 55' });
  });

  it('dispatches bulk jobs and returns the bulk result', async () => {
    const result = await processor({
      id: 'j2',
      data: { type: 'bulk', trackIds: [1, 2] },
    });
    expect(holder.processBulkTracks).toHaveBeenCalledWith([1, 2]);
    expect(result).toMatchObject({
      success: true,
      message: 'Processed bulk tracks',
      result: { successful: 2 },
    });
  });

  it('rejects playlist jobs without a playlist id as unknown', async () => {
    await expect(
      processor({ id: 'j3', data: { type: 'playlist' } })
    ).rejects.toThrow('Unknown job type: playlist');
    expect(holder.processPlaylistTracks).not.toHaveBeenCalled();
  });

  it('rethrows processing errors for BullMQ retries', async () => {
    holder.processBulkTracks.mockRejectedValueOnce(new Error('api down'));
    await expect(
      processor({ id: 'j4', data: { type: 'bulk' } })
    ).rejects.toThrow('api down');
  });
});
