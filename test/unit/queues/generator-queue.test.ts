import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Generator queue logic with BullMQ fully mocked: job enqueueing
 * priorities, the worker processor's lifecycle (progress, success,
 * rethrow-for-retry) and the completion callback dispatch.
 */

const holder = vi.hoisted(() => ({
  queueAdd: vi.fn(async (_name: string, data: any) => ({ id: 'job-1', data })),
  queueGetJob: vi.fn(),
  queueEventHandlers: new Map<string, (...args: any[]) => any>(),
  workerProcessors: [] as ((job: any) => Promise<any>)[],
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
  },
  QueueEvents: class {
    on(event: string, handler: (...args: any[]) => any) {
      holder.queueEventHandlers.set(event, handler);
    }
  },
  Worker: class {
    constructor(_name: string, processor: (job: any) => Promise<any>) {
      holder.workerProcessors.push(processor);
    }
    on() {}
  },
}));

const generateSpy = vi.fn(async () => undefined);
vi.mock('../../../src/generator', () => ({
  default: { getInstance: () => ({ generate: generateSpy }) },
}));

const checkIfReadyForPrinterSpy = vi.fn(async () => undefined);
vi.mock('../../../src/suggestion', () => ({
  default: { getInstance: () => ({ checkIfReadyForPrinter: checkIfReadyForPrinterSpy }) },
}));

vi.mock('../../../src/mollie', () => ({
  default: class {},
}));

import GeneratorQueue from '../../../src/generatorQueue';

const queue = GeneratorQueue.getInstance();

describe('GeneratorQueue.addGenerateJob', () => {
  beforeEach(() => {
    holder.queueAdd.mockClear();
  });

  it('enqueues normal jobs at priority 10', async () => {
    const id = await queue.addGenerateJob({ paymentId: 'p1', ip: '1.1.1.1' } as any);
    expect(id).toBe('job-1');
    expect(holder.queueAdd).toHaveBeenCalledWith(
      'generate',
      expect.objectContaining({ paymentId: 'p1' }),
      { priority: 10 }
    );
  });

  it('prioritizes forceFinalize jobs', async () => {
    await queue.addGenerateJob({ paymentId: 'p2', forceFinalize: true } as any);
    expect(holder.queueAdd).toHaveBeenCalledWith(
      'generate',
      expect.anything(),
      { priority: 1 }
    );
  });
});

describe('worker processor', () => {
  let processor: (job: any) => Promise<any>;

  beforeEach(async () => {
    generateSpy.mockClear();
    holder.workerProcessors.length = 0;
    await queue.initializeWorkers(1);
    processor = holder.workerProcessors[0];
  });

  function makeJob(data: Record<string, unknown> = {}) {
    return {
      id: 'job-42',
      data: { paymentId: 'pay-1', ip: '2.2.2.2', refreshPlaylists: false, ...data },
      updateProgress: vi.fn(async () => undefined),
    };
  }

  it('runs the generator and reports progress through to completed', async () => {
    const job = makeJob({ forceFinalize: true, userAgent: 'UA' });
    const result = await processor(job);

    expect(generateSpy).toHaveBeenCalledWith(
      'pay-1',
      '2.2.2.2',
      false,
      expect.anything(), // mollie instance
      true,
      false,
      false,
      'UA'
    );
    expect(result).toMatchObject({ success: true, paymentId: 'pay-1' });

    const statuses = job.updateProgress.mock.calls.map((c: any[]) => c[0].status);
    expect(statuses).toEqual(['initializing', 'processing', 'completed']);
  });

  it('rethrows generator errors so BullMQ can retry', async () => {
    generateSpy.mockRejectedValueOnce(new Error('pdf exploded'));
    await expect(processor(makeJob())).rejects.toThrow('pdf exploded');
  });
});

describe('completion callbacks', () => {
  it('dispatches checkPrinter callbacks after a job completes', async () => {
    const completed = holder.queueEventHandlers.get('completed');
    expect(completed).toBeTruthy();

    holder.queueGetJob.mockResolvedValueOnce({
      data: {
        paymentId: 'pay-9',
        onCompleteData: {
          type: 'checkPrinter',
          paymentId: 'pay-9',
          clientIp: '3.3.3.3',
        },
      },
    });

    await completed!({ jobId: 'job-9', returnvalue: '{}' });
    expect(checkIfReadyForPrinterSpy).toHaveBeenCalledWith('pay-9', '3.3.3.3');
  });

  it('does nothing when the job has no callback data', async () => {
    checkIfReadyForPrinterSpy.mockClear();
    holder.queueGetJob.mockResolvedValueOnce({ data: { paymentId: 'pay-10' } });
    const completed = holder.queueEventHandlers.get('completed');
    await completed!({ jobId: 'job-10', returnvalue: '{}' });
    expect(checkIfReadyForPrinterSpy).not.toHaveBeenCalled();
  });
});
