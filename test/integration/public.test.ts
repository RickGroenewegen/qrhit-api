import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import {
  MAX_CARDS,
  MAX_CARDS_PHYSICAL,
} from '../../src/config/constants';
import { outbound } from '../helpers/recording-mock';
import Cache from '../../src/cache';

describe('public routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  beforeEach(() => {
    outbound.reset();
  });

  it('GET /api/pricing returns the pricing constants', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pricing' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.boxUnitPrice).toBeGreaterThan(0);
    expect(body.boxMaxCards).toBeGreaterThan(0);
    expect(Array.isArray(body.boxTierPrices)).toBe(true);
    // The frontend reads its card caps from here, so they must be served.
    expect(body.maxCardsPhysical).toBe(MAX_CARDS_PHYSICAL);
    expect(body.maxCardsDigital).toBe(MAX_CARDS);
  });

  describe('GET /api/pricing/tiers', () => {
    const CACHE_KEY = 'pricingTiers_v1';

    beforeEach(async () => {
      await Cache.getInstance().executeCommand('del', CACHE_KEY);
    });

    it('returns nulls, and does not cache, when the printer has no price', async () => {
      // The recording printer mock resolves every call to undefined.
      const res = await app.inject({ method: 'GET', url: '/api/pricing/tiers' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.currency).toBe('EUR');
      expect(body.data.rows.map((r: any) => r.quantity)).toEqual([
        50, 100, 150, 200, 300, 500,
      ]);
      expect(body.data.rows.every((r: any) => r.digital === null)).toBe(true);
      expect(await Cache.getInstance().get(CACHE_KEY)).toBeFalsy();
    });

    it('returns one row per sample deck size with PDF, sheets and printed totals', async () => {
      outbound.respondWith(
        'PrintEnBind',
        'getOrderType',
        async (
          quantity: number,
          digital: boolean,
          _productType: string,
          _playlistId: string,
          subType: string
        ) => ({
          id: 1,
          digital,
          amount: digital ? 13 : subType === 'sheets' ? 15 + quantity / 50 : 20 + quantity / 10,
        })
      );

      const res = await app.inject({ method: 'GET', url: '/api/pricing/tiers' });
      expect(res.statusCode).toBe(200);
      const rows = res.json().data.rows;
      expect(rows[0]).toEqual({ quantity: 50, digital: 13, sheets: 16, physical: 25 });
      expect(rows[5]).toEqual({ quantity: 500, digital: 13, sheets: 25, physical: 70 });
      // Each cell is its own printer lookup: 6 sizes x 3 formats.
      expect(outbound.calls('PrintEnBind', 'getOrderType').length).toBe(18);

      // A complete table is cached, so the next request skips the printer.
      outbound.reset();
      const again = await app.inject({ method: 'GET', url: '/api/pricing/tiers' });
      expect(again.json().data.rows).toEqual(rows);
      expect(outbound.calls('PrintEnBind', 'getOrderType').length).toBe(0);
    });
  });

  it('GET /robots.txt serves plain text allowing Googlebot', async () => {
    const res = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('Googlebot');
  });

  it('GET /ip echoes the resolved client IP', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clientIp).toBe('203.0.113.7');
  });

  it('POST /contact hands the form to the mail service (mocked)', async () => {
    const payload = { name: 'Rick', email: 'rick@test.dev', message: 'Hi!' };
    const res = await app.inject({
      method: 'POST',
      url: '/contact',
      payload,
    });
    expect(res.statusCode).toBe(200);
    const calls = outbound.calls('Mail', 'sendContactForm');
    expect(calls.length).toBe(1);
    expect(calls[0].args[0]).toMatchObject(payload);
  });

  it('POST /newsletter_subscribe rejects invalid emails with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/newsletter_subscribe',
      payload: { email: 'not-an-email', captchaToken: 't' },
    });
    expect(res.statusCode).toBe(400);
    expect(outbound.calls('Mail', 'subscribeToNewsletter').length).toBe(0);
  });

  it('POST /newsletter_subscribe subscribes valid emails', async () => {
    outbound.respondWith('Mail', 'subscribeToNewsletter', async () => true);
    const res = await app.inject({
      method: 'POST',
      url: '/newsletter_subscribe',
      payload: { email: 'rick@test.dev', captchaToken: 't' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(outbound.calls('Mail', 'subscribeToNewsletter')[0].args[0]).toBe(
      'rick@test.dev'
    );
  });
});
