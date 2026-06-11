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

/**
 * Blog CRUD + public blog endpoints, and the admin tracking endpoints
 * backed by shipping.ts.
 */
describe('blog and tracking routes', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let blogId: number;

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

  describe('blog admin CRUD', () => {
    // SECURITY BUG (documented, not fixed here): routes/blogRoutes.ts guards
    // every admin route with `fastify.authenticate && fastify.authenticate(...)`
    // but `fastify.authenticate` is never decorated anywhere, so the
    // preHandler is undefined and ALL /admin/blogs* endpoints are publicly
    // accessible without a token. When this is fixed, this test should
    // expect 401.
    it('currently allows unauthenticated access to admin blog routes (missing authenticate decorator)', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/blogs' });
      expect(res.statusCode).toBe(200);
    });

    it('requires an english title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/blogs',
        headers,
        payload: { title_nl: 'Alleen Nederlands' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates a blog with slugs per locale', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/blogs',
        headers,
        payload: {
          title_en: 'My First Post',
          title_nl: 'Mijn Eerste Post',
          content_en: '<p>Hello world</p>',
          content_nl: '<p>Hallo wereld</p>',
          summary_en: 'Hello',
          active: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.slug_en).toBe('my-first-post');
      expect(body.blog.slug_nl).toBe('mijn-eerste-post');
      expect(body.blog.active).toBe(true);
      blogId = body.blog.id;
    });

    it('deduplicates slugs on a second blog with the same title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/blogs',
        headers,
        payload: { title_en: 'My First Post', content_en: 'Other content' },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.slug_en).toBe('my-first-post-1');
      expect(body.blog.active).toBe(false);
    });

    it('lists all blogs for the admin including inactive', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/blogs',
        headers,
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blogs).toHaveLength(2);
    });

    it('gets a blog by id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/blogs/${blogId}`,
        headers,
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.id).toBe(blogId);
    });

    it('400s a non-numeric blog id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/blogs/abc',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('gets a localized admin blog', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/blogs/nl/${blogId}`,
        headers,
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.title ?? body.blog.title_nl).toContain('Mijn');
    });

    it('updates a blog and regenerates the slug', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/admin/blogs/${blogId}`,
        headers,
        payload: { title_en: 'My Renamed Post' },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.slug_en).toBe('my-renamed-post');
    });
  });

  describe('public blog endpoints', () => {
    it('rejects an unsupported locale', async () => {
      const res = await app.inject({ method: 'GET', url: '/blogs/xx' });
      expect(res.json().success).toBe(false);
    });

    it('lists only active blogs', async () => {
      const res = await app.inject({ method: 'GET', url: '/blogs/en' });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blogs).toHaveLength(1);
      expect(body.blogs[0].title).toBe('My Renamed Post');
    });

    it('serves a blog by its locale slug with hreflang slugs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/blogs/en/my-renamed-post',
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.allSlugs.nl).toBe('mijn-eerste-post');
    });

    it('falls back to other-locale slugs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/blogs/en/mijn-eerste-post',
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.blog.title).toBe('My Renamed Post');
    });

    it('reports an unknown slug', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/blogs/en/does-not-exist',
      });
      expect(res.json().success).toBe(false);
    });
  });

  describe('blog deletion', () => {
    it('deletes a blog', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/blogs/${blogId}`,
        headers,
      });
      expect(res.json().success).toBe(true);
      const row = await prisma().blog.findUnique({ where: { id: blogId } });
      expect(row).toBeNull();
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
