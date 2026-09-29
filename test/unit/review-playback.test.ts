import { describe, it, expect, vi, beforeEach } from 'vitest';

// Review.processPlaybackCounts: the hourly pass over the Redis scan list that
// marks orders review-eligible (25+ unique tracks) and stamps firstScannedAt
// on order lines seen for the first time ("Played" in the dashboard).

const { prismaMock, cacheMock } = vi.hoisted(() => ({
  prismaMock: {
    paymentHasPlaylist: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    playlistHasTrack: {
      findFirst: vi.fn(),
    },
    payment: {
      update: vi.fn(),
    },
  },
  cacheMock: {
    executeCommand: vi.fn(),
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));
vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));
vi.mock('../../src/mail', () => ({
  default: { getInstance: () => ({ sendReviewEmail: vi.fn() }) },
}));
vi.mock('../../src/utils', () => ({
  default: class {
    isMainServer() {
      return Promise.resolve(false);
    }
  },
}));
// The constructor schedules the hourly jobs; no timers in a unit test
vi.mock('cron', () => ({ CronJob: class {} }));

import Review from '../../src/review';

const review = Review.getInstance();

function scan(php: number, trackId: number, timestamp?: string) {
  return JSON.stringify({ ip: '1.2.3.4', trackId, php, timestamp });
}

function line(id: number, playlistId: number, firstScannedAt: Date | null = null) {
  return {
    id,
    paymentId: 100 + id,
    playlistId,
    firstScannedAt,
    payment: { id: 100 + id, paymentId: `tr_${id}`, reviewAllowed: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.paymentHasPlaylist.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.playlistHasTrack.findFirst.mockResolvedValue({ trackId: 1 });
});

describe('processPlaybackCounts: first scan', () => {
  it('stamps an unplayed line with its earliest scan in the list', async () => {
    cacheMock.executeCommand.mockResolvedValue([
      scan(7, 11, '2026-09-28T10:05:00.000Z'),
      scan(7, 12, '2026-09-28T10:01:00.000Z'),
      scan(7, 11, '2026-09-28T10:03:00.000Z'),
    ]);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([line(7, 70)]);

    await review.processPlaybackCounts();

    expect(prismaMock.playlistHasTrack.findFirst).toHaveBeenCalledWith({
      where: { playlistId: 70, trackId: { in: [11, 12] } },
      select: { trackId: true },
    });
    expect(prismaMock.paymentHasPlaylist.updateMany).toHaveBeenCalledWith({
      where: { id: 7, firstScannedAt: null },
      data: { firstScannedAt: new Date('2026-09-28T10:01:00.000Z') },
    });
  });

  it('leaves a line that already has a stamp alone', async () => {
    cacheMock.executeCommand.mockResolvedValue([scan(7, 11, '2026-09-28T10:05:00.000Z')]);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      line(7, 70, new Date('2026-09-01T12:00:00.000Z')),
    ]);

    await review.processPlaybackCounts();

    expect(prismaMock.playlistHasTrack.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.paymentHasPlaylist.updateMany).not.toHaveBeenCalled();
  });

  it('ignores a php whose scanned tracks are not cards of its playlist', async () => {
    cacheMock.executeCommand.mockResolvedValue([scan(7, 999, '2026-09-28T10:05:00.000Z')]);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([line(7, 70)]);
    prismaMock.playlistHasTrack.findFirst.mockResolvedValue(null);

    await review.processPlaybackCounts();

    expect(prismaMock.paymentHasPlaylist.updateMany).not.toHaveBeenCalled();
  });

  it('falls back to now when the scans carry no timestamp', async () => {
    cacheMock.executeCommand.mockResolvedValue([scan(7, 11)]);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([line(7, 70)]);
    const before = Date.now();

    await review.processPlaybackCounts();

    const { data } = prismaMock.paymentHasPlaylist.updateMany.mock.calls[0][0];
    expect(data.firstScannedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('keeps stamping the other lines when one update fails', async () => {
    cacheMock.executeCommand.mockResolvedValue([
      scan(7, 11, '2026-09-28T10:05:00.000Z'),
      scan(8, 21, '2026-09-28T10:06:00.000Z'),
    ]);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([line(7, 70), line(8, 80)]);
    prismaMock.paymentHasPlaylist.updateMany
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ count: 1 });

    const result = await review.processPlaybackCounts();

    expect(result.success).toBe(true);
    expect(prismaMock.paymentHasPlaylist.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.paymentHasPlaylist.updateMany.mock.calls[1][0].where).toEqual({
      id: 8,
      firstScannedAt: null,
    });
  });

  it('still marks review eligibility at 25 unique tracks', async () => {
    const scans = Array.from({ length: 25 }, (_, i) =>
      scan(7, i + 1, '2026-09-28T10:05:00.000Z')
    );
    cacheMock.executeCommand.mockResolvedValue(scans);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([line(7, 70)]);

    await review.processPlaybackCounts();

    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: 107 },
      data: { reviewAllowed: 1, reviewAllowedAt: expect.any(Date) },
    });
    expect(prismaMock.paymentHasPlaylist.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the scan list is empty', async () => {
    cacheMock.executeCommand.mockResolvedValue([]);

    await review.processPlaybackCounts();

    expect(prismaMock.paymentHasPlaylist.findMany).not.toHaveBeenCalled();
    expect(prismaMock.paymentHasPlaylist.updateMany).not.toHaveBeenCalled();
  });
});
