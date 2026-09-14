import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ExcelJS from 'exceljs';

/**
 * Unit tests for src/playlistFromExcel.ts
 * Prisma, Spotify and Redis are mocked; the sheet is built in-memory.
 */

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  searchTracks: vi.fn(),
  createOrUpdatePlaylist: vi.fn(),
  cacheStore: new Map<string, string>(),
}));

vi.mock('console-log-colors', () => ({
  color: new Proxy({}, {
    get: () => new Proxy((s: any) => s, { get: () => (s: any) => s }),
  }),
}));

vi.mock('../../src/logger', () => ({
  default: class Logger {
    log() {}
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => ({ $queryRaw: h.queryRaw }) },
}));

vi.mock('../../src/spotify', () => ({
  default: {
    getInstance: () => ({
      searchTracks: h.searchTracks,
      createOrUpdatePlaylist: h.createOrUpdatePlaylist,
    }),
  },
}));

vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => h.cacheStore.get(key) ?? null,
      set: async (key: string, value: string) => {
        h.cacheStore.set(key, value);
      },
    }),
  },
}));

vi.mock('../../src/utils', () => ({
  default: class Utils {
    cleanTrackName = (s: string) =>
      s.split(' - ')[0].replace(/\(feat\..*?\)/gi, ' ').replace(/\s+/g, ' ').trim();
  },
}));

import PlaylistFromExcel from '../../src/playlistFromExcel';

async function buildSheet(rows: any[][], filename = 'party.xlsx') {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  rows.forEach((r) => sheet.addRow(r));
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { buffer, filename };
}

function parts(file: { buffer: Buffer; filename: string } | null, fields: Record<string, string>) {
  const list: any[] = Object.entries(fields).map(([fieldname, value]) => ({
    type: 'field',
    fieldname,
    value,
  }));
  if (file) {
    list.push({ type: 'file', filename: file.filename, toBuffer: async () => file.buffer });
  }
  return (async function* () {
    for (const p of list) yield p;
  })();
}

async function waitForJob(service: PlaylistFromExcel, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = await service.getJob(jobId);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}

describe('PlaylistFromExcel.parseUpload', () => {
  const service = PlaylistFromExcel.getInstance();

  it('reads artist and title from 0-based columns and skips the header', async () => {
    const file = await buildSheet([
      ['#', 'Title', 'Artist'],
      [1, 'Macarena', 'Los Del Rio'],
      [2, { richText: [{ text: 'Scat' }, { text: 'man' }] }, 'Scatman John'],
      [3, '', 'Nobody'],
      [4, 'Blank artist', ''],
    ]);
    const upload = await service.parseUpload(
      parts(file, { artistColumn: '2', titleColumn: '1', hasHeader: 'true' })
    );

    expect(upload.rows).toEqual([
      { row: 2, artist: 'Los Del Rio', title: 'Macarena' },
      { row: 3, artist: 'Scatman John', title: 'Scatman' },
    ]);
    expect(upload.playlistName).toMatch(/^party \(\d{4}-\d{2}-\d{2}\)$/);
  });

  it('keeps the first row when there is no header and honours a custom name', async () => {
    const file = await buildSheet([['Queen', 'Bohemian Rhapsody']]);
    const upload = await service.parseUpload(
      parts(file, { artistColumn: '0', titleColumn: '1', hasHeader: 'false', playlistName: ' Wedding ' })
    );
    expect(upload.rows).toEqual([{ row: 1, artist: 'Queen', title: 'Bohemian Rhapsody' }]);
    expect(upload.playlistName).toBe('Wedding');
  });

  it('rejects a missing file, equal columns and an empty sheet', async () => {
    await expect(service.parseUpload(parts(null, { artistColumn: '0', titleColumn: '1' }))).rejects.toThrow(
      'No file uploaded'
    );
    const file = await buildSheet([['a', 'b']]);
    await expect(
      service.parseUpload(parts(file, { artistColumn: '1', titleColumn: '1' }))
    ).rejects.toThrow('cannot be the same');
    const empty = await buildSheet([['Artist', 'Title']]);
    await expect(
      service.parseUpload(parts(empty, { artistColumn: '0', titleColumn: '1', hasHeader: 'true' }))
    ).rejects.toThrow('No rows');
  });
});

describe('PlaylistFromExcel job', () => {
  const service = PlaylistFromExcel.getInstance();

  beforeEach(() => {
    h.queryRaw.mockReset();
    h.searchTracks.mockReset();
    h.createOrUpdatePlaylist.mockReset();
    h.cacheStore.clear();
  });

  it('uses the database first, Spotify for the rest, and keeps sheet order', async () => {
    // Row 1 hits the exact query; row 2 misses both DB queries.
    h.queryRaw.mockImplementation(async (_strings: TemplateStringsArray, ...values: any[]) => {
      if (values.includes('los del rio') && values.includes('macarena')) return [{ trackId: 'db1' }];
      return [];
    });
    h.searchTracks.mockResolvedValue({
      success: true,
      data: {
        tracks: [
          { id: 'wrong', artist: 'Some Cover Band', name: 'Scatman' },
          { id: 'sp2', artist: 'Scatman John', name: 'Scatman (Ski-Ba-Bop-Ba-Dop-Bop)' },
        ],
      },
    });
    h.createOrUpdatePlaylist.mockResolvedValue({
      success: true,
      data: { playlistId: 'pl1', playlistUrl: 'https://open.spotify.com/playlist/pl1' },
    });

    const jobId = service.startJob({
      rows: [
        { row: 2, artist: 'Los Del Rio', title: 'Macarena' },
        { row: 3, artist: 'Scatman John feat. Someone', title: 'Scatman' },
      ],
      filename: 'x.xlsx',
      playlistName: 'Test list',
      artistColumn: 0,
      titleColumn: 1,
      hasHeader: true,
    });

    const job = await waitForJob(service, jobId);
    expect(job.status).toBe('completed');
    expect(job.foundInDb).toBe(1);
    expect(job.foundOnSpotify).toBe(1);
    expect(job.notFound).toEqual([]);
    expect(job.playlistUrl).toBe('https://open.spotify.com/playlist/pl1');
    expect(job.addedCount).toBe(2);
    expect(h.createOrUpdatePlaylist).toHaveBeenCalledWith('Test list', ['db1', 'sp2']);
    // The plain query found an artist match, so the field-filtered query was not needed.
    expect(h.searchTracks).toHaveBeenCalledTimes(1);
    expect(h.searchTracks.mock.calls[0][0]).toBe('Scatman Scatman John');
  });

  it('reports rows that neither source can match and fails when nothing matched', async () => {
    h.queryRaw.mockResolvedValue([]);
    h.searchTracks.mockResolvedValue({
      success: true,
      data: { tracks: [{ id: 'other', artist: 'Different Artist', name: 'Same Title' }] },
    });

    const jobId = service.startJob({
      rows: [{ row: 5, artist: 'Unknown Band', title: 'Same Title' }],
      filename: 'x.xlsx',
      playlistName: 'Empty',
      artistColumn: 0,
      titleColumn: 1,
      hasHeader: true,
    });

    const job = await waitForJob(service, jobId);
    expect(job.status).toBe('failed');
    expect(job.notFound).toEqual([{ row: 5, artist: 'Unknown Band', title: 'Same Title' }]);
    expect(h.createOrUpdatePlaylist).not.toHaveBeenCalled();
    // Both the plain and the field-filtered query were tried.
    expect(h.searchTracks).toHaveBeenCalledTimes(2);
  });

  it('picks the track whose title matches and whose credited artists include the sheet artist', async () => {
    h.queryRaw.mockResolvedValue([]);
    // Spotify ranks another Bruno Mars song first; "Billionaire" is credited
    // to Travie McCoy with Bruno Mars only as a featured artist.
    h.searchTracks.mockResolvedValue({
      success: true,
      data: {
        tracks: [
          { id: 'liquor', artist: 'Bruno Mars', artists: ['Bruno Mars', 'Damian Marley'], name: 'Liquor Store Blues (feat. Damian Marley)' },
          { id: 'bill', artist: 'Travie McCoy', artists: ['Travie McCoy', 'Bruno Mars'], name: 'Billionaire (feat. Bruno Mars)' },
        ],
      },
    });
    h.createOrUpdatePlaylist.mockResolvedValue({
      success: true,
      data: { playlistId: 'pl2', playlistUrl: 'https://open.spotify.com/playlist/pl2' },
    });

    const jobId = service.startJob({
      rows: [{ row: 1, artist: 'Bruno Mars', title: 'Billionaire' }],
      filename: 'x.xlsx',
      playlistName: 'Featured',
      artistColumn: 0,
      titleColumn: 1,
      hasHeader: false,
    });

    const job = await waitForJob(service, jobId);
    expect(job.status).toBe('completed');
    expect(h.createOrUpdatePlaylist).toHaveBeenCalledWith('Featured', ['bill']);
  });

  it('does not accept a track by the right artist with a different title', async () => {
    h.queryRaw.mockResolvedValue([]);
    h.searchTracks.mockResolvedValue({
      success: true,
      data: {
        tracks: [{ id: 'liquor', artist: 'Bruno Mars', artists: ['Bruno Mars'], name: 'Liquor Store Blues' }],
      },
    });

    const jobId = service.startJob({
      rows: [{ row: 1, artist: 'Bruno Mars', title: 'Billionaire' }],
      filename: 'x.xlsx',
      playlistName: 'Strict',
      artistColumn: 0,
      titleColumn: 1,
      hasHeader: false,
    });

    const job = await waitForJob(service, jobId);
    expect(job.status).toBe('failed');
    expect(job.notFound).toEqual([{ row: 1, artist: 'Bruno Mars', title: 'Billionaire' }]);
    expect(h.createOrUpdatePlaylist).not.toHaveBeenCalled();
  });

  it('waits out a Spotify rate limit and retries the same query', async () => {
    h.queryRaw.mockResolvedValue([]);
    h.searchTracks
      .mockResolvedValueOnce({ success: false, retryAfter: 0.1 })
      .mockResolvedValueOnce({
        success: true,
        data: { tracks: [{ id: 'sp9', artist: 'Queen', name: 'Bohemian Rhapsody' }] },
      });
    h.createOrUpdatePlaylist.mockResolvedValue({
      success: true,
      data: { playlistId: 'pl9', playlistUrl: 'https://open.spotify.com/playlist/pl9' },
    });

    const jobId = service.startJob({
      rows: [{ row: 1, artist: 'Queen', title: 'Bohemian Rhapsody - Remastered 2011' }],
      filename: 'x.xlsx',
      playlistName: 'Retry',
      artistColumn: 0,
      titleColumn: 1,
      hasHeader: false,
    });

    const job = await waitForJob(service, jobId);
    expect(job.status).toBe('completed');
    expect(h.searchTracks).toHaveBeenCalledTimes(2);
    expect(h.searchTracks.mock.calls[0][0]).toBe(h.searchTracks.mock.calls[1][0]);
    expect(h.createOrUpdatePlaylist).toHaveBeenCalledWith('Retry', ['sp9']);
  });

  it('surfaces a Spotify playlist error as a failed job', async () => {
    h.queryRaw.mockResolvedValue([{ trackId: 'db1' }]);
    h.createOrUpdatePlaylist.mockResolvedValue({ success: false, error: 'Spotify authentication required' });

    const jobId = service.startJob({
      rows: [{ row: 1, artist: 'A', title: 'B' }],
      filename: 'x.xlsx',
      playlistName: 'Broken',
      artistColumn: 0,
      titleColumn: 1,
      hasHeader: false,
    });

    const job = await waitForJob(service, jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Spotify authentication required');
  });
});
