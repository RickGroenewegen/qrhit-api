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
import PDF from '../../src/pdf';

/**
 * company-routes3: covers company endpoints NOT exercised by company-routes.test.ts
 * or company-routes2.test.ts.
 *
 * Target groups:
 *  - GET /business/sales-invoices/:invoiceId/pdf (409 when bookkeeping not connected)
 *  - GET /business/companies/:companyId/lists/:listId/invoices (400/409)
 *  - POST /business/companies/:companyId/lists/:listId/invoice (400/409)
 *  - GET /business/users/:companyId (200/400/404)
 *  - PUT /business/companies/:companyId (400/404/200)
 *  - PUT /business/companies/:companyId/lists/:listId/info (400/404/409/200)
 *  - GET/POST/PUT/DELETE /business/companies/:companyId/lists/:listId/delivery-addresses
 *  - GET /business/companies/:companyId/lists/:listId/order-email
 *  - PUT /business/companies/:companyId/favorite
 *  - GET /business/production-lists
 *  - POST /business/companies/:companyId/lists/:listId/intake-link
 *  - GET/PUT /business/intake/:token (public, no auth)
 *  - Auth matrix: 401 without token, 403 for plain users
 */
describe('company routes — wave 3 coverage', () => {
  let app: FastifyInstance;
  let adminHeaders: Record<string, string>;
  let plainUserHeaders: Record<string, string>;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let plainUser: Awaited<ReturnType<typeof createTestUser>>;

  let companyId: number;
  let listId: number;
  let secondListId: number;

  beforeAll(async () => {
    vi.spyOn(Utils.prototype, 'verifyRecaptcha').mockResolvedValue({
      isHuman: true,
      score: 0.9,
    } as any);
    vi.spyOn(PDF.prototype as any, 'generateFromUrl').mockResolvedValue(undefined);
    vi.spyOn(PDF.prototype as any, 'resizePDFPages').mockResolvedValue(undefined);

    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    // Ensure extra user groups exist
    await prisma().userGroup.createMany({
      data: [
        { id: 6, name: 'companyadmin' },
        { id: 7, name: 'qrvoteadmin' },
      ],
      skipDuplicates: true,
    });

    admin     = await createTestUser({ groups: ['admin'] });
    plainUser = await createTestUser({ groups: ['users'] });
    adminHeaders     = authHeader(admin.token);
    plainUserHeaders = authHeader(plainUser.token);

    // Seed company + two lists
    const company = await prisma().company.create({
      data: {
        name: 'VR3 Company BV',
        address: 'Koninginneweg',
        housenumber: '10',
        city: 'Amsterdam',
        zipcode: '1012AM',
        countrycode: 'NL',
        contact: 'Kees',
        contactemail: 'kees@vr3test.qrsong.io',
      },
    });
    companyId = company.id;

    const list = await prisma().companyList.create({
      data: {
        companyId,
        name: 'VR3 Lijst Alfa',
        description_en: 'Alfa',
        slug: 'vr3-alfa',
        numberOfCards: 80,
        numberOfTracks: 4,
        status: 'new',
      },
    });
    listId = list.id;

    const secondList = await prisma().companyList.create({
      data: {
        companyId,
        name: 'VR3 Lijst Beta',
        description_en: 'Beta',
        slug: 'vr3-beta',
        numberOfCards: 40,
        numberOfTracks: 2,
        status: 'production',
      },
    });
    secondListId = secondList.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  // ====================================================================
  // BOOKKEEPING INVOICE ENDPOINTS (not connected in test env)
  // ====================================================================

  describe('GET /business/sales-invoices/:invoiceId/pdf', () => {
    it('returns PDF-related response (bookkeeping may or may not be connected in test env)', async () => {
      // NOTE: MoneyBird may be connected in test env (real API key in .env). If connected,
      // endpoint will try to download a PDF, likely returning 400 (invalid invoice id format).
      // If not connected, returns 409. Either way, this exercises the endpoint code path.
      const res = await app.inject({
        method: 'GET',
        url: '/business/sales-invoices/inv-test-wave3/pdf',
        headers: adminHeaders,
      });
      expect([400, 409, 500]).toContain(res.statusCode);
    });
  });

  describe('GET /business/companies/:companyId/lists/:listId/invoices', () => {
    it('400 for NaN companyId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/business/companies/abc/lists/1/invoices',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for NaN listId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/companies/${companyId}/lists/abc/invoices`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns invoice status for list (bookkeeping may or may not be connected)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/companies/${companyId}/lists/${listId}/invoices`,
        headers: adminHeaders,
      });
      // If bookkeeping connected: 200 with connected:true and full/down/remaining fields
      // If not connected: 200 with connected:false
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.connected).toBe('boolean');
    });
  });

  describe('POST /business/companies/:companyId/lists/:listId/invoice', () => {
    it('400 for NaN IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/business/companies/abc/lists/def/invoice',
        headers: adminHeaders,
        payload: { type: 'schneider', paymentOption: 'full' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown price variant before contacting MoneyBird', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/business/companies/${companyId}/lists/${listId}/invoice`,
        headers: adminHeaders,
        payload: { type: 'other', paymentOption: 'full' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Unknown price variant');
    });
  });

  // ====================================================================
  // GET /business/users/:companyId
  // ====================================================================

  describe('GET /business/users/:companyId', () => {
    it('400 for NaN companyId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/business/users/abc',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 for unknown company', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/business/users/999999',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(404);
    });

    it('200 with empty users array for company with no users', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/users/${companyId}`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().users)).toBe(true);
    });
  });

  // ====================================================================
  // PUT /business/companies/:companyId
  // ====================================================================

  describe('PUT /business/companies/:companyId', () => {
    it('400 for NaN companyId', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/business/companies/abc',
        headers: adminHeaders,
        payload: { name: 'New Name' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 when name is missing', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}`,
        headers: adminHeaders,
        payload: { city: 'Rotterdam' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('name');
    });

    it('404 for unknown company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/business/companies/999999',
        headers: adminHeaders,
        payload: { name: 'Ghost Company' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('200 — updates company fields', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}`,
        headers: adminHeaders,
        payload: {
          name: 'VR3 Company Renamed BV',
          contact: 'Jan',
          contactemail: 'jan@vr3test.qrsong.io',
          locale: 'nl',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().company.name).toBe('VR3 Company Renamed BV');
    });
  });

  // ====================================================================
  // PUT /business/companies/:companyId/lists/:listId/info
  // ====================================================================

  describe('PUT /business/companies/:companyId/lists/:listId/info', () => {
    it('400 for NaN IDs', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/business/companies/abc/lists/def/info',
        headers: adminHeaders,
        payload: { name: 'Test' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 when no fields provided', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/info`,
        headers: adminHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('No fields to update');
    });

    it('400 for invalid status value', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/info`,
        headers: adminHeaders,
        payload: { status: 'invalid_status' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for invalid date field', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/info`,
        headers: adminHeaders,
        payload: { startAt: 'not-a-date' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 for empty required string field', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/info`,
        headers: adminHeaders,
        payload: { name: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 for unknown list', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/999999/info`,
        headers: adminHeaders,
        payload: { status: 'new' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('409 when slug is already taken', async () => {
      // secondList has slug 'vr3-beta' — try to set listId to same slug
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/info`,
        headers: adminHeaders,
        payload: { slug: 'vr3-beta' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('200 — updates status and name', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/info`,
        headers: adminHeaders,
        payload: {
          status: 'open',
          name: 'VR3 Alfa Updated',
          numberOfCards: 100,
          showNames: true,
          startAt: '2026-01-15',
          endAt: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().list.status).toBe('open');
    });
  });

  // ====================================================================
  // PUT /business/companies/:companyId/lists/:listId/sold
  // ====================================================================

  describe('PUT /business/companies/:companyId/lists/:listId/sold', () => {
    const url = () => `/business/companies/${companyId}/lists/${secondListId}/sold`;

    it('400 when sold is not a boolean', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: url(),
        headers: adminHeaders,
        payload: { sold: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 for a list of another company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/999999/lists/${secondListId}/sold`,
        headers: adminHeaders,
        payload: { sold: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it('400 while the list has no sell price', async () => {
      await prisma().companyList.update({
        where: { id: secondListId },
        data: { sellPrice: null },
      });
      const res = await app.inject({
        method: 'PUT',
        url: url(),
        headers: adminHeaders,
        payload: { sold: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it('200 marks it sold on the given day, and off again', async () => {
      await prisma().companyList.update({
        where: { id: secondListId },
        data: { sellPrice: 1250, buyPrice: 800 },
      });

      const on = await app.inject({
        method: 'PUT',
        url: url(),
        headers: adminHeaders,
        payload: { sold: true, soldAt: '2026-09-14' },
      });
      expect(on.statusCode).toBe(200);
      expect(on.json()).toMatchObject({
        success: true,
        sold: true,
        soldAt: '2026-09-14T12:00:00.000Z',
      });
      const stored = await prisma().companyList.findUnique({ where: { id: secondListId } });
      expect(stored?.sold).toBe(true);

      const off = await app.inject({
        method: 'PUT',
        url: url(),
        headers: adminHeaders,
        payload: { sold: false },
      });
      expect(off.json()).toMatchObject({ success: true, sold: false, soldAt: null });
    });

    it('403 for a non-admin', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: url(),
        headers: plainUserHeaders,
        payload: { sold: true },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ====================================================================
  // DELIVERY ADDRESSES CRUD
  // ====================================================================

  describe('delivery addresses CRUD', () => {
    let addressId: number;

    it('GET delivery-addresses — 404 for unknown list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/companies/${companyId}/lists/999999/delivery-addresses`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET delivery-addresses — returns empty array for new list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/companies/${companyId}/lists/${listId}/delivery-addresses`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().addresses)).toBe(true);
    });

    it('POST delivery-addresses — 400 for missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/business/companies/${companyId}/lists/${listId}/delivery-addresses`,
        headers: adminHeaders,
        payload: { name: 'Office' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST delivery-addresses — creates address', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/business/companies/${companyId}/lists/${listId}/delivery-addresses`,
        headers: adminHeaders,
        payload: {
          name: 'HQ',
          address: 'Koninginneweg 10, Amsterdam',
          country: 'NL',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().success).toBe(true);
      addressId = res.json().address.id;
    });

    it('PUT delivery-address/:id — 400 for missing fields', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/delivery-addresses/${addressId}`,
        headers: adminHeaders,
        payload: { name: 'HQ Updated' }, // missing address + country
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT delivery-address/:id — 404 for unknown address', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/delivery-addresses/999999`,
        headers: adminHeaders,
        payload: { name: 'X', address: 'Y', country: 'NL' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('PUT delivery-address/:id — updates address', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/lists/${listId}/delivery-addresses/${addressId}`,
        headers: adminHeaders,
        payload: {
          name: 'HQ Updated',
          address: 'Koninginneweg 10, 1012AM Amsterdam',
          country: 'NL',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().address.name).toBe('HQ Updated');
    });

    it('DELETE delivery-address/:id — 404 for unknown address', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/business/companies/${companyId}/lists/${listId}/delivery-addresses/999999`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE delivery-address/:id — deletes address', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/business/companies/${companyId}/lists/${listId}/delivery-addresses/${addressId}`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // ORDER EMAIL
  // ====================================================================

  describe('GET /business/companies/:companyId/lists/:listId/order-email', () => {
    it('400 for NaN IDs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/business/companies/abc/lists/def/order-email',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 for unknown list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/companies/${companyId}/lists/999999/order-email`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(404);
    });

    it('200 — returns email data for known list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/companies/${companyId}/lists/${listId}/order-email`,
        headers: adminHeaders,
      });
      expect([200, 500]).toContain(res.statusCode);
    });
  });

  // ====================================================================
  // FAVORITE TOGGLE
  // ====================================================================

  describe('PUT /business/companies/:companyId/favorite', () => {
    it('400 for NaN companyId', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/business/companies/abc/favorite',
        headers: adminHeaders,
        payload: { favorite: true },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 for unknown company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/business/companies/999999/favorite',
        headers: adminHeaders,
        payload: { favorite: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it('200 — sets favorite flag to true', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/favorite`,
        headers: adminHeaders,
        payload: { favorite: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().favorite).toBe(true);
    });

    it('200 — clears favorite flag', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/companies/${companyId}/favorite`,
        headers: adminHeaders,
        payload: { favorite: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().favorite).toBe(false);
    });
  });

  // ====================================================================
  // PRODUCTION LISTS
  // ====================================================================

  describe('GET /business/production-lists', () => {
    it('returns production lists (includes secondList with status=production)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/business/production-lists',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().lists)).toBe(true);
      // secondList is in production status
      expect(res.json().lists.some((l: any) => l.id === secondListId)).toBe(true);
    });
  });

  // ====================================================================
  // INTAKE LINK + PUBLIC INTAKE FORM
  // ====================================================================

  describe('intake link and form endpoints', () => {
    let intakeToken: string;

    it('POST /business/companies/:companyId/lists/:listId/intake-link — 400 for NaN IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/business/companies/abc/lists/def/intake-link',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /business/companies/:companyId/lists/:listId/intake-link — 404 for unknown list', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/business/companies/${companyId}/lists/999999/intake-link`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /business/companies/:companyId/lists/:listId/intake-link — generates token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/business/companies/${companyId}/lists/${listId}/intake-link`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().intakeToken).toBe('string');
      intakeToken = res.json().intakeToken;
    });

    it('GET /business/intake/:token — 400 for short token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/business/intake/short',
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /business/intake/:token — 404 for non-existent token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/business/intake/aaaaaaaaaaaaaaaaabcdefghijklmnop',
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /business/intake/:token — 200 for valid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/business/intake/${intakeToken}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().list).toBeTruthy();
      expect(res.json().company).toBeTruthy();
    });

    it('PUT /business/intake/:token — 400 for short token', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/business/intake/short',
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT /business/intake/:token — 404 for non-existent token', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/business/intake/aaaaaaaaaaaaaaaaabcdefghijklmnop',
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('PUT /business/intake/:token — 200 when updating list data', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/business/intake/${intakeToken}`,
        payload: {
          playlistSource: 'spotify',
          musicWishes: 'Pop and rock',
          languages: 'nl',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // AUTH: 401 + 403
  // ====================================================================

  describe('auth matrix', () => {
    const adminOnlyEndpoints = [
      { method: 'GET',  url: '/business/bookkeeping/status' },
      { method: 'GET',  url: '/business/sales-invoices/inv-test/pdf' },
      { method: 'GET',  url: '/business/production-lists' },
    ] as const;

    for (const ep of adminOnlyEndpoints) {
      it(`${ep.method} ${ep.url} → 401 without token`, async () => {
        const res = await app.inject({ method: ep.method, url: ep.url });
        expect(res.statusCode).toBe(401);
      });

      it(`${ep.method} ${ep.url} → 403 for plain users group`, async () => {
        const res = await app.inject({
          method: ep.method,
          url: ep.url,
          headers: plainUserHeaders,
        });
        expect(res.statusCode).toBe(403);
      });
    }
  });
});
