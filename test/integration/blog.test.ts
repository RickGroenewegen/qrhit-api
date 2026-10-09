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
import { createTestUser, authHeader } from '../helpers/auth';
import { readFileSync } from 'fs';
import { join } from 'path';

interface IndexedPost {
  id: number;
  slugs: Record<string, string>;
  titles: Record<string, string>;
}

// The posts are markdown files committed to the repo (src/_data/blog); the
// admin CRUD these tests used to cover was removed on 2026-09-12.
const blogIndex: IndexedPost[] = JSON.parse(
  readFileSync(join(__dirname, '../../src/_data/blog/index.json'), 'utf8')
).posts;
const post = blogIndex.find((p) => p.slugs?.en && p.slugs?.nl && p.slugs.en !== p.slugs.nl)!;

/**
 * The public blog endpoints (markdown posts in src/_data/blog), and the admin
 * tracking endpoints backed by shipping.ts.
 */
describe('blog and tracking routes', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    const admin = await createTestUser({ groups: ['admin'] });
    headers = authHeader(admin.token);
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('public blog endpoints', () => {
    it('has no admin blog routes any more', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/blogs', headers });
      expect(res.statusCode).toBe(404);
    });

    it('rejects an unsupported locale', async () => {
      const res = await app.inject({ method: 'GET', url: '/blogs/xx' });
      expect(res.json().success).toBe(false);
    });

    it('lists the posts that exist in the locale', async () => {
      const res = await app.inject({ method: 'GET', url: '/blogs/en' });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blogs.length).toBeGreaterThan(0);
      const listed = body.blogs.find((b: any) => b.id === post.id);
      expect(listed?.title).toBe(post.titles.en);
    });

    it('serves a post by its locale slug with the slugs of every locale', async () => {
      const res = await app.inject({ method: 'GET', url: `/blogs/en/${post.slugs.en}` });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.title).toBe(post.titles.en);
      expect(body.blog.content.length).toBeGreaterThan(0);
      expect(body.blog.allSlugs.nl).toBe(post.slugs.nl);
    });

    it('falls back to another locale slug for old links', async () => {
      const res = await app.inject({ method: 'GET', url: `/blogs/en/${post.slugs.nl}` });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.title).toBe(post.titles.en);
    });

    it('reports an unknown slug', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/blogs/en/does-not-exist',
      });
      expect(res.json().success).toBe(false);
    });
  });

  describe('admin tracking endpoints', () => {
    beforeAll(async () => {
      const user = await prisma().user.create({
        data: {
          userId: 'tracked-user',
          email: 'tracked@test.qrsong.io',
          displayName: 'Tracked',
          hash: 'tracked-hash',
        },
      });
      const base = {
        userId: user.id,
        totalPrice: 30,
        productPriceWithoutTax: 24,
        shippingPriceWithoutTax: 0,
        productVATPrice: 6,
        shippingVATPrice: 0,
        totalVATPrice: 6,
        status: 'paid',
        email: 'tracked@test.qrsong.io',
      };
      await prisma().payment.create({
        data: {
          ...base,
          paymentId: 'tr_track_shipped',
          fullname: 'Shipped Customer',
          printApiStatus: 'Shipped',
          shippingCode: '3SABC0000000001',
          countrycode: 'NL',
          shippingStartDateTime: new Date(),
        },
      });
      await prisma().payment.create({
        data: {
          ...base,
          paymentId: 'tr_track_delivered',
          fullname: 'Delivered Customer',
          printApiStatus: 'Delivered',
          shippingCode: '3SABC0000000002',
          countrycode: 'DE',
          shippingStartDateTime: new Date(Date.now() - 2 * 86400000),
          shippingDeliveryDateTime: new Date(),
        },
      });
    });

    it('lists in-transit orders', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/in-transit',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.totalItems).toBe(1);
      expect(body.data[0].fullname).toBe('Shipped Customer');
    });

    it('lists delivered orders with a text filter', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/delivered',
        headers,
        payload: { textSearch: 'Delivered Customer' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns the available country codes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/tracking/country-codes',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toContain('NL');
      expect(data).toContain('DE');
    });

    it('rejects an export with an invalid status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/export',
        headers,
        payload: { status: 'Wrong' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('exports tracking data as an xlsx file', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/export',
        headers,
        payload: { status: 'Delivered' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheet');
      expect(res.rawPayload.length).toBeGreaterThan(100);
    });

    it('toggles shipping ignore on a payment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/tracking/toggle-ignore',
        headers,
        payload: { paymentId: 'tr_track_shipped', ignore: true },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().payment.findUnique({
        where: { paymentId: 'tr_track_shipped' },
      });
      expect(row!.shippingIgnore).toBe(true);
    });
  });
});
