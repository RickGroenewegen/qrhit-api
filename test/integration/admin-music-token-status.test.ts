import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';

/**
 * GET /admin/music-token-status — surfaces the Spotify/Tidal refresh-token
 * lifetime (used by the admin bulk-actions panel to show when a manual
 * re-login is due) and the current access-token validity.
 */
describe('GET /admin/music-token-status', () => {
  let app: FastifyInstance;
  let adminHeaders: Record<string, string>;
  let customerHeaders: Record<string, string>;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const obtainedAt = Date.now() - 30 * DAY_MS; // refresh token issued 30 days ago

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    const admin = await createTestUser({ groups: ['admin'] });
    const customer = await createTestUser({ groups: ['users'] });
    adminHeaders = authHeader(admin.token);
    customerHeaders = authHeader(customer.token);

    // Spotify connected; Tidal left unset (not connected).
    await prisma().appSetting.create({
      data: { key: 'spotify_refresh_token', value: 'rt-spotify' },
    });
    await prisma().appSetting.create({
      data: { key: 'spotify_token_expires_at', value: String(Date.now() + 3600_000) },
    });
    await prisma().appSetting.create({
      data: { key: 'spotify_refresh_token_obtained_at', value: String(obtainedAt) },
    });
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('rejects a regular user with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/music-token-status',
      headers: customerHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns refresh-token lifetime info for both services', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/music-token-status',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.success).toBe(true);
    expect(typeof body.now).toBe('number');

    const { spotify, tidal } = body.services;

    // Spotify: connected, 6-month (180 day) window measured from obtainedAt.
    expect(spotify.connected).toBe(true);
    expect(spotify.refreshTokenTtlDays).toBe(180);
    expect(spotify.refreshTokenObtainedAt).toBe(obtainedAt);
    expect(spotify.refreshTokenExpiresAt).toBe(obtainedAt + 180 * DAY_MS);
    expect(spotify.refreshTokenExpiresAt).toBeGreaterThan(body.now);
    expect(spotify.accessTokenExpiresAt).toBeGreaterThan(body.now);

    // Tidal: nothing stored → not connected, no timestamps.
    expect(tidal.connected).toBe(false);
    expect(tidal.refreshTokenObtainedAt).toBeNull();
    expect(tidal.refreshTokenExpiresAt).toBeNull();
    expect(tidal.refreshTokenTtlDays).toBe(180);
  });
});
