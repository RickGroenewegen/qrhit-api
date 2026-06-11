import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { outbound } from '../helpers/recording-mock';

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
