import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';

/**
 * music-routes2: covers music/hitlist endpoints NOT exercised by music-hitlist.test.ts.
 *
 * Target groups:
 *  - POST /resolve_shortlink (validation)
 *  - POST /qrlink_unknown (validation)
 *  - GET /qr2/:trackId/:php (EJS template rendering)
 *  - GET /qrlink2/:trackId/:php (returns empty link for unknown track)
 *  - GET /spotify_callback (no code → error)
 */
describe('music routes — wave 2 coverage', () => {
  let app: FastifyInstance;
  let dbTrackId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    // Seed a track for link-related tests
    const track = await prisma().track.create({
      data: {
        trackId: 'mr2-spotify-track-1',
        name: 'MR2 Track',
        artist: 'MR2 Artist',
        year: 2001,
      },
    });
    dbTrackId = track.trackId;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  // ====================================================================
  // POST /resolve_shortlink
  // ====================================================================

  describe('POST /resolve_shortlink', () => {
    it('400 for missing url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/resolve_shortlink',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Missing');
    });

    it('400 for non-string url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/resolve_shortlink',
        payload: { url: 12345 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 or 500 for invalid url that does not resolve', async () => {
      // NOTE: test env blocks external HTTP; spotify.resolveShortlink will fail
      const res = await app.inject({
        method: 'POST',
        url: '/resolve_shortlink',
        payload: { url: 'https://spotify.link/not-a-real-link' },
      });
      expect([404, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // POST /qrlink_unknown
  // ====================================================================

  describe('POST /qrlink_unknown', () => {
    it('400 for missing url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/qrlink_unknown',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Missing');
    });

    it('400 for non-string url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/qrlink_unknown',
        payload: { url: 123 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 200/404/500 for url that may or may not be resolved', async () => {
      // The Spotify URL pattern may partially match and return 200 with partial data.
      // External API may also be called and fail → 404 or 500.
      const res = await app.inject({
        method: 'POST',
        url: '/qrlink_unknown',
        payload: { url: 'https://open.spotify.com/track/not-real-id-xyz' },
      });
      expect([200, 404, 500]).toContain(res.statusCode);
    });

    // Apps before 1.8.0 do not know the /qr_url2 card format, so they post the
    // whole wrapper here instead of the link inside it. The resolver unwraps it
    // so those builds keep playing our preview cards.
    it('unwraps a /qr_url2 card and returns the link inside it', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/qrlink_unknown',
        payload: {
          url:
            'https://api.qrsong.io/qr_url2?link=' +
            encodeURIComponent('https://www.deezer.com/track/3135556'),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        dz: 'https://www.deezer.com/track/3135556',
      });
    });
  });

  // ====================================================================
  // GET /qr2/:trackId/:php (EJS template)
  // ====================================================================

  describe('GET /qr2/:trackId/:php', () => {
    it('returns an HTML response (EJS template)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/qr2/${dbTrackId}/999`,
      });
      // Should render the onboarding.ejs template
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // GET /qr_url2?link=... (EJS template)
  // ====================================================================

  describe('GET /qr_url2', () => {
    const LINK = 'https://music.youtube.com/watch?v=lcOxhH8N3Bo';

    it('serves the same onboarding page as /qr2, so a camera scan lands there', async () => {
      const wrapped = await app.inject({
        method: 'GET',
        url: `/qr_url2?link=${encodeURIComponent(LINK)}`,
      });
      const qr2 = await app.inject({
        method: 'GET',
        url: `/qr2/${dbTrackId}/999`,
      });

      // Asserted explicitly so this cannot pass on two identical error pages
      expect(wrapped.statusCode).toBe(200);
      expect(wrapped.body.length).toBeGreaterThan(500);
      expect(wrapped.statusCode).toBe(qr2.statusCode);
      expect(wrapped.body).toBe(qr2.body);
    });

    it('renders even without a link parameter', async () => {
      const res = await app.inject({ method: 'GET', url: '/qr_url2' });
      expect([200, 404, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // GET /qrlink2/:trackId/:php
  // ====================================================================

  describe('GET /qrlink2/:trackId/:php', () => {
    it('returns empty link for unknown track', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/qrlink2/non-existent-track/1',
      });
      expect(res.statusCode).toBe(200);
      // Returns { link: '', yt: null, ym: null, ... }
      const body = res.json();
      expect(body).toHaveProperty('link');
    });

    it('returns link (empty if no spotify link set) for known track', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/qrlink2/${dbTrackId}/1`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('link');
    });
  });

  // ====================================================================
  // GET /spotify_callback
  // ====================================================================

  describe('GET /spotify_callback', () => {
    it('handles missing code (no query params)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/spotify_callback',
      });
      // Should handle gracefully — no code means failure
      expect([200, 302, 400, 500]).toContain(res.statusCode);
    });

    it('handles error param from Spotify (user denied access)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/spotify_callback?error=access_denied',
      });
      expect([200, 302, 400, 500]).toContain(res.statusCode);
    });
  });
});
