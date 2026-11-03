import { describe, it, expect, vi } from 'vitest';

/**
 * createSiteMap leaves out a featured playlist whose source is gone
 * (`linkBroken`, src/linkCheck): its product page is a 404. Files and the
 * blog are stand-ins; only the product pages are looked at.
 */

const h = vi.hoisted(() => ({ writeFile: vi.fn(async () => {}) }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, promises: { ...actual.promises, writeFile: h.writeFile } };
});
vi.mock('../../src/blog', () => ({
  default: { getInstance: () => ({ getSitemapEntries: async () => [] }) },
}));
vi.mock('../../src/spotify', () => ({
  CACHE_KEY_PLAYLIST: 'playlist2_',
  CACHE_KEY_PLAYLIST_DB: 'playlistdb2_',
  CACHE_KEY_TRACKS: 'tracks2_',
  CACHE_KEY_TRACK_COUNT: 'trackcount2_',
}));

import { createSiteMap } from '../../src/data/misc';

describe('createSiteMap', () => {
  it('asks only for product pages that work (linkBroken = false)', async () => {
    const findMany = vi.fn(async () => [
      { slug: 'live-list', updatedAt: new Date('2026-11-01T00:00:00Z'), featuredLocale: null },
    ]);
    const deps: any = {
      prisma: {
        playlist: { findMany },
        eventBase: { findMany: vi.fn(async () => []) },
        calendarEvent: { findMany: vi.fn(async () => []) },
      },
      translate: { allLocales: ['en'] },
      logger: { log: vi.fn() },
    };

    await createSiteMap(deps);

    expect(findMany.mock.calls[0][0].where).toMatchObject({ featured: true, linkBroken: false });
    const written = h.writeFile.mock.calls.map((c: any[]) => String(c[1])).join('\n');
    expect(written).toContain('/en/product/live-list');
  });
});
