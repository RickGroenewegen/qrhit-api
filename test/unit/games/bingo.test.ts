import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Unit tests for src/bingo.ts with all I/O collaborators mocked:
 * prisma (fake), PDF (buffer stub), cache (Map-backed). The card
 * generation math, QR data round-trip and upgrade-payment logic are
 * exercised against real behavior; PDF/ZIP orchestration runs against
 * scratch dirs with a stubbed PDF renderer (archiver runs for real).
 */

const h = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  return {
    cacheStore,
    cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string) => {
      cacheStore.set(key, value);
    }),
    cacheDel: vi.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
    generatePdfFromUrl: vi.fn(async () => Buffer.from('%PDF-fake')),
    prisma: {
      $queryRaw: vi.fn(),
      bingoFile: { create: vi.fn(async (args: any) => ({ id: 1, ...args.data })) },
      gamesPurchase: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: any) => ({ id: 5, ...args.data })),
      },
      paymentHasPlaylist: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ paymentId: 77 })),
      },
      payment: {
        findUnique: vi.fn(async () => ({ countrycode: 'NL', taxRate: 21 })),
      },
      user: {
        findUnique: vi.fn(async () => ({ hash: 'user-hash-1' })),
      },
    },
  };
});

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({ get: h.cacheGet, set: h.cacheSet, del: h.cacheDel }),
  },
}));

vi.mock('../../../src/pdf', () => ({
  default: class {
    generatePdfFromUrl = h.generatePdfFromUrl;
  },
}));

import Bingo, { BingoTrack, BingoSheet } from '../../../src/bingo';

const bingo = Bingo.getInstance();

function makeTracks(count: number): BingoTrack[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    trackId: `isrc-${i + 1}`,
    name: `Track ${i + 1}`,
    artist: `Artist ${i + 1}`,
    year: 1960 + (i % 60),
    bingoNumber: i + 1,
  }));
}

describe('validateConfig', () => {
  it('rejects fewer than 75 tracks', () => {
    const result = bingo.validateConfig(74, 10, 2);
    expect(result.valid).toBe(false);
    expect(result.warning).toContain('Minimum 75 tracks');
    expect(result.sheetsNeeded).toBe(20);
    expect(result.tracksNeeded).toBe(48);
  });

  it('accepts 75+ tracks without warning when pool covers the ideal spread', () => {
    const result = bingo.validateConfig(100, 5, 3);
    expect(result).toEqual({
      valid: true,
      sheetsNeeded: 15,
      tracksNeeded: 72,
      totalTracksPerRound: 24,
      warning: undefined,
    });
  });

  it('warns when tracks repeat across rounds (pool < 24 * rounds)', () => {
    const result = bingo.validateConfig(80, 5, 5);
    expect(result.valid).toBe(true);
    expect(result.tracksNeeded).toBe(120);
    expect(result.warning).toContain('some songs will repeat');
  });
});

describe('generateSheets', () => {
  const tracks = makeTracks(80);

  it('generates contestants x rounds sheets with correct round/sheet numbering', () => {
    const sheets = bingo.generateSheets(tracks, 3, 2);
    expect(sheets).toHaveLength(6);
    expect(sheets.map((s) => [s.round, s.sheetNumber])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 2],
      [2, 3],
    ]);
  });

  it('builds 5x5 grids with exactly one free space in the center', () => {
    const [sheet] = bingo.generateSheets(tracks, 1, 1);
    expect(sheet.grid).toHaveLength(5);
    for (const row of sheet.grid) expect(row).toHaveLength(5);

    expect(sheet.grid[2][2].isFreeSpace).toBe(true);
    expect(sheet.grid[2][2].track).toBeNull();

    const freeSpaces = sheet.grid.flat().filter((c) => c.isFreeSpace);
    expect(freeSpaces).toHaveLength(1);
  });

  it('fills each card with 24 distinct tracks drawn from the pool', () => {
    const [sheet] = bingo.generateSheets(tracks, 1, 1);
    const cardTracks = sheet.grid
      .flat()
      .filter((c) => !c.isFreeSpace)
      .map((c) => c.track!);

    expect(cardTracks).toHaveLength(24);
    expect(cardTracks.every((t) => t !== null)).toBe(true);

    const ids = new Set(cardTracks.map((t) => t.id));
    expect(ids.size).toBe(24);

    const poolIds = new Set(tracks.map((t) => t.id));
    for (const id of ids) expect(poolIds.has(id)).toBe(true);
  });
});

describe('generateQRData / parseQRData round trip', () => {
  it('encodes 24 bingo numbers in position order with the QRSSM prefix', () => {
    const [sheet] = bingo.generateSheets(makeTracks(75), 1, 1);
    sheet.round = 3;
    sheet.sheetNumber = 7;

    const data = bingo.generateQRData(sheet);
    expect(data).toMatch(/^QRSSM:BC:R3S7:(\d+,){23}\d+$/);

    const parsed = bingo.parseQRData(data);
    expect(parsed).not.toBeNull();
    expect(parsed!.round).toBe(3);
    expect(parsed!.sheet).toBe(7);
    expect(parsed!.positions.size).toBe(24);
    // Free space (position 12) must not be mapped
    expect(parsed!.positions.has(12)).toBe(false);

    // Positions map back onto the grid cells in reading order
    const expectedNumbers: number[] = [];
    for (const cell of sheet.grid.flat()) {
      if (!cell.isFreeSpace) expectedNumbers.push(cell.track!.bingoNumber!);
    }
    let i = 0;
    for (let pos = 0; pos < 25; pos++) {
      if (pos === 12) continue;
      expect(parsed!.positions.get(pos)).toBe(expectedNumbers[i++]);
    }
  });

  it('parses the legacy BINGO: prefix', () => {
    const numbers = Array.from({ length: 24 }, (_, i) => i + 1).join(',');
    const parsed = bingo.parseQRData(`BINGO:R2S4:${numbers}`);
    expect(parsed).toMatchObject({ round: 2, sheet: 4 });
    expect(parsed!.positions.get(0)).toBe(1);
    expect(parsed!.positions.get(24)).toBe(24);
  });

  it('rejects malformed payloads', () => {
    expect(bingo.parseQRData('')).toBeNull();
    expect(bingo.parseQRData('HELLO:R1S1:1,2,3')).toBeNull();
    expect(bingo.parseQRData('BINGO:R1S1:')).toBeNull();
    // 23 numbers instead of 24
    const short = Array.from({ length: 23 }, (_, i) => i + 1).join(',');
    expect(bingo.parseQRData(`BINGO:R1S1:${short}`)).toBeNull();
    // Non-numeric entry
    const bad = Array.from({ length: 23 }, (_, i) => i + 1).join(',') + ',x';
    expect(bingo.parseQRData(`BINGO:R1S1:${bad}`)).toBeNull();
    // Missing sheet part
    expect(bingo.parseQRData('BINGO:R1:1,2,3')).toBeNull();
  });

  it('skips cells without bingoNumbers, which makes the payload unparseable (24-number contract)', () => {
    const tracksWithoutNumbers = makeTracks(30).map((t) => ({
      ...t,
      bingoNumber: undefined,
    }));
    const [sheet] = bingo.generateSheets(tracksWithoutNumbers, 1, 1);
    const data = bingo.generateQRData(sheet);
    expect(data).toBe(`QRSSM:BC:R1S1:`);
    expect(bingo.parseQRData(data)).toBeNull();
  });
});

describe('generateDefaultBingo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.cacheStore.clear();
    h.prisma.bingoFile.create.mockImplementation(async (args: any) => ({
      id: 1,
      ...args.data,
    }));
  });

  function trackRows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      trackId: `isrc-${i + 1}`,
      name: `Track ${i + 1}`,
      artist: `Artist ${i + 1}`,
      year: 1980 + (i % 40),
      trackOrder: i,
    }));
  }

  it('skips generation when the playlist has fewer than 40 tracks', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce(trackRows(39));

    const result = await bingo.generateDefaultBingo(
      'pay-1',
      'uhash',
      'plist',
      10,
      'My Playlist',
      'qr',
      'en',
      55
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient tracks: 39 < 40');
    expect(h.generatePdfFromUrl).not.toHaveBeenCalled();
    expect(h.prisma.bingoFile.create).not.toHaveBeenCalled();
  });

  it('generates PDFs, zips them, stores a BingoFile row and returns a download URL', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce(trackRows(50));

    const result = await bingo.generateDefaultBingo(
      'pay-2',
      'uhash',
      'plist-id',
      11,
      'Party Mix',
      'qr',
      'nl',
      66
    );

    expect(result.success).toBe(true);
    expect(result.downloadUrl).toMatch(
      /^http:\/\/localhost:3004\/public\/bingo\/pay-2_.*_bingo_[0-9a-f]{16}\.zip$/
    );

    // PDF rendered twice: bingo cards + host cards, via the cached config
    expect(h.generatePdfFromUrl).toHaveBeenCalledTimes(2);
    const [cardsUrl] = h.generatePdfFromUrl.mock.calls[0] as any[];
    const [hostUrl] = h.generatePdfFromUrl.mock.calls[1] as any[];
    expect(cardsUrl).toMatch(/\/bingo\/render\/[0-9a-f]{16}$/);
    expect(hostUrl).toMatch(/\/bingo\/render-hostcards\/[0-9a-f]{16}$/);

    // Config was cached with default contestants/rounds, then cleaned up
    const setCall = h.cacheSet.mock.calls.find(([k]: any[]) =>
      String(k).startsWith('bingo_config:')
    );
    expect(setCall).toBeTruthy();
    expect(JSON.parse(setCall![1])).toMatchObject({
      paymentId: 'pay-2',
      contestants: 20,
      rounds: 5,
      locale: 'nl',
    });
    expect(h.cacheDel).toHaveBeenCalledWith(setCall![0]);

    // BingoFile row stores config + the ISRCs that were used
    expect(h.prisma.bingoFile.create).toHaveBeenCalledTimes(1);
    const createData = h.prisma.bingoFile.create.mock.calls[0][0].data;
    expect(createData).toMatchObject({
      paymentHasPlaylistId: 66,
      contestants: 20,
      rounds: 5,
      trackCount: 50,
    });
    expect(createData.selectedTrackIds).toHaveLength(50);
    expect(createData.selectedTrackIds[0]).toBe('isrc-1');

    // The ZIP exists in the scratch public dir; intermediate PDFs are gone
    const bingoDir = path.join(process.env['PUBLIC_DIR']!, 'bingo');
    expect(fs.existsSync(path.join(bingoDir, createData.filename))).toBe(true);
    const leftovers = fs
      .readdirSync(bingoDir)
      .filter((f) => f.endsWith('.pdf'));
    expect(leftovers).toEqual([]);
  });

  it('falls back to English file labels for an unknown locale', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce(trackRows(40));

    const result = await bingo.generateDefaultBingo(
      'pay-3',
      'uhash',
      'plist-id',
      12,
      'Mix',
      'qr',
      'xx',
      67
    );
    expect(result.success).toBe(true);
    const cachedConfig = h.cacheSet.mock.calls.find(([k]: any[]) =>
      String(k).startsWith('bingo_config:')
    );
    expect(JSON.parse(cachedConfig![1]).locale).toBe('xx');
  });

  it('returns the error and keeps going when PDF generation explodes', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce(trackRows(45));
    h.generatePdfFromUrl.mockRejectedValueOnce(new Error('chromium died'));

    const result = await bingo.generateDefaultBingo(
      'pay-4',
      'uhash',
      'plist-id',
      13,
      'Mix',
      'qr',
      'en',
      68
    );

    expect(result).toEqual({ success: false, error: 'chromium died' });
    expect(h.prisma.bingoFile.create).not.toHaveBeenCalled();
  });
});

describe('processBingoUpgradePayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.prisma.gamesPurchase.findFirst.mockResolvedValue(null);
    h.prisma.paymentHasPlaylist.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ paymentId: 77 });
    h.prisma.payment.findUnique.mockResolvedValue({
      countrycode: 'NL',
      taxRate: 21,
    });
    h.prisma.user.findUnique.mockResolvedValue({ hash: 'user-hash-1' });
  });

  it('rejects empty / unparseable id input', async () => {
    const result = await bingo.processBingoUpgradePayment('a,b,c', 1);
    expect(result).toEqual({
      success: false,
      error: 'No valid playlist IDs provided',
    });
    expect(h.prisma.paymentHasPlaylist.updateMany).not.toHaveBeenCalled();
  });

  it('parses comma-separated string ids and recalculates the tier price', async () => {
    h.prisma.paymentHasPlaylist.updateMany.mockResolvedValue({ count: 3 });

    const result = await bingo.processBingoUpgradePayment('1, 2,3', 9);
    expect(result).toEqual({ success: true });

    // 3 playlists => 20% off => 4.00 each
    expect(h.prisma.paymentHasPlaylist.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2, 3] }, gamesEnabled: false },
      data: { gamesEnabled: true, gamesPrice: 4.0 },
    });
    expect(h.prisma.gamesPurchase.create).toHaveBeenCalledWith({
      data: {
        userId: 9,
        totalPrice: 12.0,
        playlistCount: 3,
        pricePerPlaylist: 4.0,
        type: 'upgrade',
        countrycode: 'NL',
        taxRate: 21,
        molliePaymentId: null,
      },
    });
    // Dashboard cache cleared for the purchasing user
    expect(h.cacheDel).toHaveBeenCalledWith('playlists:user:user-hash-1');
  });

  it('honors an explicit pricePerPlaylist override', async () => {
    await bingo.processBingoUpgradePayment([4], 9, 1.23, 'tr_x');
    expect(h.prisma.paymentHasPlaylist.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { gamesEnabled: true, gamesPrice: 1.23 },
      })
    );
    expect(h.prisma.gamesPurchase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalPrice: 1.23,
          molliePaymentId: 'tr_x',
        }),
      })
    );
  });

  it('ignores replayed webhooks when a GamesPurchase already exists for the Mollie id', async () => {
    h.prisma.gamesPurchase.findFirst.mockResolvedValue({ id: 1 });

    const result = await bingo.processBingoUpgradePayment([1], 9, undefined, 'tr_dup');
    expect(result).toEqual({ success: true });
    expect(h.prisma.paymentHasPlaylist.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.gamesPurchase.create).not.toHaveBeenCalled();
  });

  it('returns idempotently when every playlist was already upgraded (claim count 0)', async () => {
    h.prisma.paymentHasPlaylist.updateMany.mockResolvedValue({ count: 0 });

    const result = await bingo.processBingoUpgradePayment([1, 2], 9);
    expect(result).toEqual({ success: true });
    expect(h.prisma.gamesPurchase.create).not.toHaveBeenCalled();
    expect(h.cacheDel).not.toHaveBeenCalled();
  });

  it('still records the purchase without country data when payment lookup fails', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);

    const result = await bingo.processBingoUpgradePayment(8, 9);
    expect(result).toEqual({ success: true });
    expect(h.prisma.gamesPurchase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ countrycode: null, taxRate: null }),
      })
    );
  });

  it('reports failure when the database errors out', async () => {
    h.prisma.paymentHasPlaylist.updateMany.mockRejectedValueOnce(
      new Error('db down')
    );
    const result = await bingo.processBingoUpgradePayment([1], 9);
    expect(result).toEqual({ success: false, error: 'db down' });
  });
});
