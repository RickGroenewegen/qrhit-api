import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';

/**
 * The public Channable feed URL and the admin "build now" route.
 *
 * The feed URL is what the agency configures as their Channable import
 * source, so the contract that matters here is: the right token gets CSV, the
 * wrong one gets nothing that hints the endpoint exists.
 */
describe('Channable feed routes', () => {
  let app: FastifyInstance;
  const TOKEN = 'integration-feed-token';
  const FEED_DIR = path.join(process.env['PUBLIC_DIR']!, 'channable');

  beforeAll(async () => {
    process.env['CHANNABLE_FEED_TOKEN'] = TOKEN;
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    // Pre-build an empty feed so the route serves a file rather than kicking
    // off a full build inside the request.
    await fs.mkdir(FEED_DIR, { recursive: true });
    const header = 'id,offer_id,content_language,target_country,title\r\n';
    await fs.writeFile(path.join(FEED_DIR, 'feed.csv'), header + 'en~US~1_3_1,1_3_1,en,US,Test\r\n');
    await fs.writeFile(path.join(FEED_DIR, 'feed_DE.csv'), header);
  });

  afterAll(async () => {
    await closeTestApp(app);
    await fs.rm(FEED_DIR, { recursive: true, force: true });
  });

  it('serves the feed as CSV with the right token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channable/feed.csv?token=${TOKEN}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('qrsong_feed.csv');
    expect(res.body).toContain('en~US~1_3_1');
  });

  it('404s without a token, rather than 401ing and confirming the URL exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/channable/feed.csv' });
    expect(res.statusCode).toBe(404);
  });

  it('404s on a wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/channable/feed.csv?token=nope',
    });
    expect(res.statusCode).toBe(404);
  });

  it('serves a per-country slice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channable/feed.csv?token=${TOKEN}&country=de`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('qrsong_feed_DE.csv');
    expect(res.body).not.toContain('en~US~1_3_1');
  });

  it('404s on a country we do not sell in', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channable/feed.csv?token=${TOKEN}&country=JP`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires admin auth to trigger a build', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: '/admin/channable/generate-feed',
    });
    expect(anon.statusCode).toBe(401);

    const plain = await createTestUser({ groups: ['users'] });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/admin/channable/generate-feed',
      headers: authHeader(plain.token),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('lets an admin trigger a build', async () => {
    const admin = await createTestUser({ groups: ['admin'] });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/channable/generate-feed',
      headers: authHeader(admin.token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
  });
});
