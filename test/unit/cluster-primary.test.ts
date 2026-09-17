import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the fork-first boot: the primary settles the one-time
 * background backfill, then forks one worker per CPU before the application
 * is loaded, and respawns a dead worker into the slot it held.
 *
 * clusterPrimary.ts keeps a module-level "already started" flag, so every test
 * loads a fresh copy of the module.
 */

const events: string[] = [];
const clusterMock = {
  isPrimary: true,
  fork: vi.fn(),
  on: vi.fn(),
};
const backfill = vi.fn();
const ensureFile = vi.fn();

vi.mock('cluster', () => ({ default: clusterMock }));
vi.mock('os', () => ({ default: { cpus: () => [{}, {}, {}] } }));
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => ({ fake: 'prisma' }) },
}));
vi.mock('../../src/legacyBackground', () => ({
  backfillLegacyDefaultBackground: backfill,
  ensureLegacyDefaultBackgroundFile: ensureFile,
}));
vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

async function loadModule() {
  vi.resetModules();
  return import('../../src/clusterPrimary');
}

beforeEach(() => {
  events.length = 0;
  let nextId = 1;
  clusterMock.isPrimary = true;
  clusterMock.fork.mockReset().mockImplementation((env: { WORKER_ID: string }) => {
    events.push(`fork:${env.WORKER_ID}`);
    return { id: nextId++ };
  });
  clusterMock.on.mockReset();
  backfill.mockReset().mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('backfill-done');
    return null;
  });
  ensureFile.mockReset().mockResolvedValue(false);
});

describe('startClusterWorkers', () => {
  it('does nothing in a worker', async () => {
    clusterMock.isPrimary = false;
    const { startClusterWorkers } = await loadModule();
    await startClusterWorkers();
    expect(backfill).not.toHaveBeenCalled();
    expect(clusterMock.fork).not.toHaveBeenCalled();
  });

  it('settles the backfill before forking one worker per CPU', async () => {
    const { startClusterWorkers } = await loadModule();
    await startClusterWorkers();
    expect(backfill).toHaveBeenCalledWith({ fake: 'prisma' });
    expect(events).toEqual(['backfill-done', 'fork:0', 'fork:1', 'fork:2']);
  });

  it('forks only once, however often it is called', async () => {
    const { startClusterWorkers } = await loadModule();
    await startClusterWorkers();
    await startClusterWorkers();
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(clusterMock.fork).toHaveBeenCalledTimes(3);
  });

  it('still forks when the backfill or the artwork copy fails', async () => {
    backfill.mockReset().mockRejectedValue(new Error('db down'));
    ensureFile.mockReset().mockRejectedValue(new Error('disk full'));
    const { startClusterWorkers } = await loadModule();
    await expect(startClusterWorkers()).resolves.toBeUndefined();
    expect(clusterMock.fork).toHaveBeenCalledTimes(3);
  });

  it('respawns a dead worker into the slot it held', async () => {
    const { startClusterWorkers } = await loadModule();
    await startClusterWorkers();
    const onExit = clusterMock.on.mock.calls.find(([name]) => name === 'exit')![1];

    // Worker id 2 held slot 1; its replacement gets id 4.
    onExit({ id: 2, process: { pid: 1234 } }, 1, null);
    expect(clusterMock.fork).toHaveBeenLastCalledWith({ WORKER_ID: '1' });

    // The replacement dying again must land in slot 1 as well.
    onExit({ id: 4, process: { pid: 5678 } }, 1, null);
    expect(clusterMock.fork).toHaveBeenLastCalledWith({ WORKER_ID: '1' });
  });
});
