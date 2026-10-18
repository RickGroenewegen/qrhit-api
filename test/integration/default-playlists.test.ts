import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { createTestUser, authHeader } from '../helpers/auth';
import PDF from '../../src/pdf';
import Spotify from '../../src/spotify';
import SpotifyApi from '../../src/spotify_api';

/**
 * The default playlists routes (src/routes/defaultPlaylistRoutes.ts): the
 * catalogue the toolkit fills and the dashboard lists, the brochure view the
 * PDF Lambda prints (public, no prices) and the PDF route; plus the toolkit
 * playlist route's playlistId/description. The Lambda and Spotify are mocked.
 */

const ID = (n: number) => `Playlist${String(n).padStart(14, '0')}`;

function row(themeKey: string, cardCount: 48 | 96 | 192, n: number, extra: Record<string, unknown> = {}) {
  return {
    themeKey,
    cardCount,
    category: themeKey === 'christmas' ? 'themes' : 'decades',
    name: { en: `${themeKey} EN`, nl: `${themeKey} NL`, de: `${themeKey} DE` },
    description: { en: `About ${themeKey}.`, nl: `Over ${themeKey}.`, de: null },
    spotifyPlaylistId: ID(n),
    trackCount: cardCount,
    yearFrom: 1980,
    yearTo: 1989,
    decades: [{ decade: 1980, count: cardCount }],
    artists: ['Queen', 'ABBA'],
    sortOrder: 0,
    ...extra,
  };
}

describe('default playlists routes', () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let user: Record<string, string>;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    admin = authHeader((await createTestUser({ groups: ['admin'] })).token);
    user = authHeader((await createTestUser({ groups: ['users'] })).token);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await prisma().defaultPlaylist.deleteMany({});
  });

  const put = (playlists: unknown[], headers = admin) =>
    app.inject({ method: 'PUT', url: '/business/default-playlists', headers, payload: { playlists } });

  it('is admin only, except the view the Lambda prints', async () => {
    for (const [method, url] of [
      ['GET', '/business/default-playlists'],
      ['PUT', '/business/default-playlists'],
      ['DELETE', '/business/default-playlists/1'],
      ['POST', '/business/default-playlists/pdf'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: user, payload: {} })).statusCode).toBe(403);
    }
  });

  it('upserts on theme and size and lists by sortOrder, themeKey, cardCount', async () => {
    const first = await put([
      row('christmas', 192, 1, { sortOrder: 20 }),
      row('80s-hits', 96, 2, { sortOrder: 10 }),
      row('christmas', 48, 3, { sortOrder: 20 }),
      row('80s-hits', 48, 4, { sortOrder: 10 }),
      row('70s-hits', 48, 5, { sortOrder: 10, yearFrom: 1970, yearTo: 1979, decades: [{ decade: 1970, count: 48 }] }),
    ]);
    expect(first.statusCode).toBe(200);
    const saved = first.json().playlists;
    // In the order sent, with the database id and the Spotify link.
    expect(saved.map((p: any) => `${p.themeKey}/${p.cardCount}`)).toEqual([
      'christmas/192',
      '80s-hits/96',
      'christmas/48',
      '80s-hits/48',
      '70s-hits/48',
    ]);
    expect(saved[0]).toMatchObject({
      id: expect.any(Number),
      category: 'themes',
      name: { en: 'christmas EN', nl: 'christmas NL', de: 'christmas DE' },
      description: { en: 'About christmas.', nl: 'Over christmas.', de: null },
      spotifyPlaylistId: ID(1),
      spotifyUrl: `https://open.spotify.com/playlist/${ID(1)}`,
      decades: [{ decade: 1980, count: 192 }],
      artists: ['Queen', 'ABBA'],
      sortOrder: 20,
      updatedAt: expect.any(String),
    });

    const list = await app.inject({ method: 'GET', url: '/business/default-playlists', headers: admin });
    expect(list.statusCode).toBe(200);
    expect(list.json().playlists.map((p: any) => `${p.themeKey}/${p.cardCount}`)).toEqual([
      '70s-hits/48',
      '80s-hits/48',
      '80s-hits/96',
      'christmas/48',
      'christmas/192',
    ]);

    // The same theme and size again: updated in place, same id.
    const again = await put([row('christmas', 192, 9, { name: { en: 'Christmas', nl: 'Kerst', de: 'Weihnachten' } })]);
    expect(again.statusCode).toBe(200);
    expect(again.json().playlists[0]).toMatchObject({ id: saved[0].id, spotifyPlaylistId: ID(9), name: { nl: 'Kerst' } });
    expect(await prisma().defaultPlaylist.count()).toBe(5);
  });

  it('refuses bad input with a clear error and stores nothing', async () => {
    const bad = await put([row('80s-hits', 48, 1), row('80s-hits', 100 as any, 2)]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ success: false, error: 'playlists[1]: cardCount must be 48, 96, 192' });
    const noBody = await app.inject({ method: 'PUT', url: '/business/default-playlists', headers: admin, payload: {} });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().error).toBe('body must be { playlists: [...] }');
    expect(await prisma().defaultPlaylist.count()).toBe(0);
  });

  it('refuses a Spotify playlist that already belongs to another theme or size', async () => {
    await put([row('80s-hits', 48, 1)]);
    const res = await put([row('90s-hits', 96, 7), row('christmas', 48, 1)]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(`spotifyPlaylistId ${ID(1)} is already 80s-hits/48; delete that row first`);
    // The whole call is refused, not half of it.
    expect(await prisma().defaultPlaylist.count()).toBe(1);
  });

  it('deletes one row and answers 404 for an unknown one', async () => {
    const [saved] = (await put([row('80s-hits', 48, 1)])).json().playlists;
    expect((await app.inject({ method: 'DELETE', url: '/business/default-playlists/999999', headers: admin })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/business/default-playlists/abc', headers: admin })).statusCode).toBe(400);
    const res = await app.inject({ method: 'DELETE', url: `/business/default-playlists/${saved.id}`, headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(await prisma().defaultPlaylist.count()).toBe(0);
  });

  describe('brochure', () => {
    let ids: Record<string, number>;

    beforeEach(async () => {
      const saved = (
        await put([row('80s-hits', 48, 1), row('80s-hits', 96, 2), row('80s-hits', 192, 3), row('christmas', 192, 4)])
      ).json().playlists;
      ids = Object.fromEntries(saved.map((p: any) => [`${p.themeKey}/${p.cardCount}`, p.id]));
    });

    it('renders the view without a session, in the language asked for, with only the sizes asked for', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/default-playlists/view?locale=nl&ids=${ids['80s-hits/48']},${ids['christmas/192']}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<html lang="nl">');
      expect(res.body).toContain('Standaard playlists');
      expect(res.body).toContain('80s-hits NL');
      expect(res.body).toContain('christmas NL');
      expect(res.body).toContain(`href="https://open.spotify.com/playlist/${ID(1)}"`);
      expect(res.body).toContain(`href="https://open.spotify.com/playlist/${ID(4)}"`);
      expect(res.body).not.toContain(ID(2));
      expect(res.body).not.toContain(ID(3));
      // A QR code per selected size.
      expect(res.body.match(/viewBox="0 0 41 41"/g)).toHaveLength(2);
    });

    it('falls back to English for another language and refuses bad or unknown ids', async () => {
      const en = await app.inject({ method: 'GET', url: `/business/default-playlists/view?locale=fr&ids=${ids['80s-hits/96']}` });
      expect(en.statusCode).toBe(200);
      expect(en.body).toContain('<html lang="en">');
      expect(en.body).toContain('Default playlists');
      expect((await app.inject({ method: 'GET', url: '/business/default-playlists/view?locale=nl&ids=1,x' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/business/default-playlists/view?locale=nl' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/business/default-playlists/view?ids=999998,999999' })).statusCode).toBe(404);
    });

    it('prints the PDF through the Lambda and names the download', async () => {
      const render = vi.spyOn(PDF.prototype, 'renderUrlToPdfBuffer').mockResolvedValue(Buffer.from('%PDF-1.7 test'));
      const res = await app.inject({
        method: 'POST',
        url: '/business/default-playlists/pdf',
        headers: admin,
        payload: { locale: 'de', ids: [ids['christmas/192'], ids['80s-hits/48'], 999999] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      const today = new Date().toISOString().slice(0, 10);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="QRSong_Standard-Playlists_${today}.pdf"`);
      expect(res.rawPayload.toString()).toBe('%PDF-1.7 test');
      // The unknown id is left out of the page the Lambda prints.
      const [url, options] = render.mock.calls[0];
      expect(url).toMatch(/\/business\/default-playlists\/view\?locale=de&ids=\d+%2C\d+$/);
      expect(new URL(url).searchParams.get('ids')!.split(',').map(Number).sort()).toEqual(
        [ids['80s-hits/48'], ids['christmas/192']].sort()
      );
      expect(options).toEqual({ format: 'a4', marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 });
      render.mockRestore();
    });

    it('refuses a PDF of nothing', async () => {
      const render = vi.spyOn(PDF.prototype, 'renderUrlToPdfBuffer');
      const unknown = await app.inject({
        method: 'POST',
        url: '/business/default-playlists/pdf',
        headers: admin,
        payload: { locale: 'nl', ids: [999999] },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error).toBe('none of these ids is a default playlist');
      const empty = await app.inject({ method: 'POST', url: '/business/default-playlists/pdf', headers: admin, payload: { ids: [] } });
      expect(empty.statusCode).toBe(400);
      expect(render).not.toHaveBeenCalled();
      render.mockRestore();
    });
  });
});

describe('POST /admin/toolkit/playlist: playlistId and description', () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let write: any;
  const OURS = 'Ours11111111111111111A';
  const tracks = ['4uLU6hMCjMI75M1A2tKUQC', '7GhIk7Il098yCjg4BQjzvb'];

  beforeAll(async () => {
    vi.spyOn(SpotifyApi.prototype, 'getOwnUserId').mockResolvedValue('qrsong');
    write = vi.spyOn(Spotify.prototype, 'createOrUpdatePlaylist');
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    admin = authHeader((await createTestUser({ groups: ['admin'] })).token);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeTestApp(app);
  });

  beforeEach(() => {
    write.mockReset();
    write.mockResolvedValue({
      success: true,
      data: { playlistId: OURS, playlistUrl: `https://open.spotify.com/playlist/${OURS}`, playlistName: '80s Hits (96)' },
    });
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/admin/toolkit/playlist', headers: admin, payload });

  it('passes playlistId and description on and answers as before', async () => {
    const res = await post({ name: '80s Hits (96)', trackIds: tracks, playlistId: OURS, description: 'Big hair.' });
    expect(res.statusCode).toBe(200);
    expect(write).toHaveBeenCalledWith('80s Hits (96)', tracks, { playlistId: OURS, description: 'Big hair.' });
    expect(res.json()).toEqual({
      success: true,
      playlistId: OURS,
      playlistUrl: `https://open.spotify.com/playlist/${OURS}`,
      playlistName: '80s Hits (96)',
      owner: 'qrsong',
      trackCount: 2,
    });
  });

  it('stays the same for the old callers', async () => {
    expect((await post({ name: 'Acme', trackIds: tracks })).statusCode).toBe(200);
    expect(write).toHaveBeenCalledWith('Acme', tracks, {});
  });

  it('validates the new fields before calling Spotify', async () => {
    const badId = await post({ name: 'Acme', trackIds: tracks, playlistId: 'https://open.spotify.com/playlist/x' });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error).toBe('playlistId must be a Spotify playlist id');
    const badDescription = await post({ name: 'Acme', trackIds: tracks, description: ['x'] });
    expect(badDescription.statusCode).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it('answers 403 for a playlist that is not ours, 404 for an unknown one and 502 otherwise', async () => {
    write.mockResolvedValueOnce({ success: false, error: 'Playlist belongs to someone', data: { reason: 'not_owned' } });
    const notOurs = await post({ name: 'Acme', trackIds: tracks, playlistId: OURS });
    expect(notOurs.statusCode).toBe(403);
    expect(notOurs.json()).toEqual({ success: false, error: 'Playlist belongs to someone' });

    write.mockResolvedValueOnce({ success: false, error: 'Spotify has no playlist', data: { reason: 'not_found' } });
    expect((await post({ name: 'Acme', trackIds: tracks, playlistId: OURS })).statusCode).toBe(404);

    write.mockResolvedValueOnce({ success: false, error: 'Spotify API error: 500' });
    expect((await post({ name: 'Acme', trackIds: tracks, playlistId: OURS })).statusCode).toBe(502);
  });
});
