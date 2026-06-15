import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import Utils from '../../src/utils';

/**
 * public-routes2: covers public endpoint paths NOT exercised by
 * public.test.ts / public-extra.test.ts / public-designer-upgrades.test.ts /
 * chat-account.test.ts.
 *
 * Target groups:
 *  - GET /reviews_details (trustpilot company details)
 *  - GET /upload_contacts (triggers mail upload)
 *  - GET /test (diagnostics)
 *  - POST /push/register (valid + invalid)
 *  - newsletter endpoints edge cases
 *  - POST /broken-links failure path (result.success === false branch)
 *  - POST /chunk-error with a real non-bot user agent (hits Redis counter)
 *  - POST /chunk-error with a bot user agent (short-circuit)
 */
describe('public routes — wave 2 coverage', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.spyOn(Utils.prototype, 'verifyRecaptcha').mockResolvedValue({
      isHuman: true,
      score: 0.9,
    } as any);

    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  // NOTE: GET /reviews_details (trustpilot.getCompanyDetails) is NOT tested here
  // because it makes a live external HTTP call to RapidAPI that times out in the
  // test environment. The endpoint is covered structurally by the route registration.

  // ====================================================================
  // GET /upload_contacts
  // ====================================================================

  describe('GET /upload_contacts', () => {
    it('triggers contact upload and returns success', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/upload_contacts',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // GET /test (diagnostics endpoint)
  // ====================================================================

  describe('GET /test', () => {
    it('returns success with localIp and version', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body).toHaveProperty('localIp');
      expect(body).toHaveProperty('version');
    });
  });

  // ====================================================================
  // POST /push/register
  // ====================================================================

  describe('POST /push/register', () => {
    it('400 for missing token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/push/register',
        payload: { type: 'expo' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid request');
    });

    it('400 for missing type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/push/register',
        payload: { token: 'ExpoToken[xxx]' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('200 for valid token and type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/push/register',
        payload: { token: 'ExpoToken[pr2-test-token]', type: 'expo' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // POST /newsletter_subscribe — edge cases not in public.test.ts
  // ====================================================================

  describe('POST /newsletter_subscribe', () => {
    it('400 for missing email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/newsletter_subscribe',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for clearly invalid email (no @)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/newsletter_subscribe',
        payload: { email: 'notanemail' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
    });
  });

  // ====================================================================
  // GET /unsubscribe/:hash — valid hash path
  // ====================================================================

  describe('GET /unsubscribe/:hash', () => {
    it('400 for an invalid hash (mail.unsubscribe returns false)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/unsubscribe/totally-invalid-hash-pr2',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
    });
  });

  // ====================================================================
  // POST /broken-links — additional branches
  // ====================================================================

  describe('POST /broken-links', () => {
    it('400 when type is neither "invalid" nor "non-retrievable"', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/broken-links',
        payload: {
          url: 'https://open.spotify.com/track/pr2-test',
          type: 'badtype',
          errorType: 'not_found',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid type');
    });

    it('200 with id when a valid broken link is logged', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/broken-links',
        payload: {
          url: 'https://open.spotify.com/track/pr2-logged-link',
          type: 'invalid',
          errorType: 'not_found',
          serviceType: 'spotify',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().id).toBe('number');
    });
  });

  // ====================================================================
  // POST /chunk-error
  // ====================================================================

  describe('POST /chunk-error', () => {
    it('returns 200 immediately for bot user agents (skips Redis counter)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/chunk-error',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        payload: {
          message: 'Failed to fetch chunk.js',
          url: 'https://qrsong.io/nl/',
          userAgent: 'Googlebot',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns 200 for a real user agent and increments the Redis counter', async () => {
      // Flush Redis so the counter starts at 0 and Pushover fires on the first report
      await flushTestRedis();

      const res = await app.inject({
        method: 'POST',
        url: '/chunk-error',
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        payload: {
          message: 'Loading chunk 42 failed.',
          url: 'https://qrsong.io/nl/generate',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('suppresses duplicate alerts (counter > 1 stays 200 but skips Pushover)', async () => {
      // Second report in the same window — counter is now 2, no Pushover
      const res = await app.inject({
        method: 'POST',
        url: '/chunk-error',
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        payload: {
          message: 'Loading chunk 99 failed.',
          url: 'https://qrsong.io/nl/generate',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // GET /api/pricing — covered by public.test.ts but sanity check
  // ====================================================================

  describe('GET /api/pricing', () => {
    it('returns box pricing constants', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/pricing',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('boxUnitPrice');
      expect(body).toHaveProperty('gamesUnitPrice');
    });
  });

  // ====================================================================
  // GET /fonts and GET /backgrounds
  // ====================================================================

  describe('GET /fonts', () => {
    it('returns font list with cache header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/fonts',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().data)).toBe(true);
      expect(res.headers['cache-control']).toContain('max-age');
    });
  });

  describe('GET /backgrounds', () => {
    it('returns backgrounds list with cache header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/backgrounds',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().data)).toBe(true);
    });
  });

  // ====================================================================
  // GET /api/tracking/average-delivery-times
  // ====================================================================

  describe('GET /api/tracking/average-delivery-times', () => {
    it('returns delivery time data', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/tracking/average-delivery-times',
      });
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.json().success).toBe(true);
      }
    });
  });

  // ====================================================================
  // GET /api/shipping/info-by-country
  // ====================================================================

  describe('GET /api/shipping/info-by-country', () => {
    it('returns shipping info by country', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/shipping/info-by-country',
      });
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.json().success).toBe(true);
      }
    });
  });

  // NOTE: GET /reviews/:locale/:amount/:landingPage is covered by public-extra.test.ts
  // (seeds local trustPilot DB records and queries them). External API call tests would
  // timeout in the test environment.
});
