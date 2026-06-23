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
 * account-routes2: covers account endpoints NOT exercised by account.test.ts
 * or account-customer.test.ts.
 *
 * Target groups:
 *  - POST /api/account/games-request-activation (400/200)
 *  - POST /api/account/games-validate-activation (400/200)
 *  - PUT /account/voting-portal/:id (400/403/404/200)
 *  - DELETE /account/voting-portal/:id (400/404/200)
 */
describe('account routes — wave 2 coverage', () => {
  let app: FastifyInstance;
  let userHeaders: Record<string, string>;
  let unauthHeaders: Record<string, string>;
  let testUser: Awaited<ReturnType<typeof createTestUser>>;
  let otherUser: Awaited<ReturnType<typeof createTestUser>>;

  let companyId: number;
  let listId: number;

  beforeAll(async () => {
    vi.spyOn(Utils.prototype, 'verifyRecaptcha').mockResolvedValue({
      isHuman: true,
      score: 0.9,
    } as any);

    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    testUser  = await createTestUser({ groups: ['users'] });
    otherUser = await createTestUser({ groups: ['users'] });
    userHeaders   = authHeader(testUser.token);
    unauthHeaders = {};

    // Ensure companyadmin group exists
    await prisma().userGroup.createMany({
      data: [{ id: 6, name: 'companyadmin' }],
      skipDuplicates: true,
    });

    // Create a company and attach testUser to it (voting-portal ownership is via user.companyId)
    const company = await prisma().company.create({
      data: {
        name: 'AR2 Company BV',
        address: 'Teststraat 1',
        housenumber: '1',
        city: 'Utrecht',
        zipcode: '3511CA',
        countrycode: 'NL',
        contact: 'Pieter',
        contactemail: 'pieter@ar2test.qrsong.io',
      },
    });
    companyId = company.id;

    // Associate testUser with this company so updateCompanyList passes the ownership check
    await prisma().user.update({
      where: { id: testUser.user.id },
      data: { companyId },
    });

    const list = await prisma().companyList.create({
      data: {
        companyId,
        name: 'AR2 Test List',
        description_en: 'Test',
        slug: 'ar2-test-list',
        numberOfCards: 50,
        numberOfTracks: 3,
        status: 'new',
      },
    });
    listId = list.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  // ====================================================================
  // GAMES REQUEST ACTIVATION
  // ====================================================================

  describe('POST /api/account/games-request-activation', () => {
    it('400 for missing email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-request-activation',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidEmail');
    });

    it('400 for invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-request-activation',
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidEmail');
    });

    it('200 with generic message when no paid order for email (no enumeration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-request-activation',
        payload: { email: 'no-orders@test.qrsong.io' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      // Generic message to avoid email enumeration
      expect(typeof res.json().message).toBe('string');
    });

    it('200 with generic message when email has paid order (sends activation email)', async () => {
      // Set up: create a paid payment for testUser
      await prisma().payment.create({
        data: {
          userId:   testUser.user.id,
          paymentId: 'tr_ar2_games_act',
          orderId:  'QR999002',
          status:   'paid',
          fullname: 'AR2 Test User',
          email:    testUser.user.email,
          totalPrice: 40,
          productPriceWithoutTax: 33,
          shippingPriceWithoutTax: 4,
          productVATPrice: 2.5,
          shippingVATPrice: 0.5,
          totalVATPrice: 3,
          taxRate: 21,
          countrycode: 'NL',
          address: 'Teststraat',
          city: 'Utrecht',
          zipcode: '3511CA',
          housenumber: '1',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-request-activation',
        payload: { email: testUser.user.email },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // GAMES VALIDATE ACTIVATION
  // ====================================================================

  describe('POST /api/account/games-validate-activation', () => {
    it('400 for missing code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-validate-activation',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidCode');
    });

    it('400 for code shorter than 6 digits', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-validate-activation',
        payload: { code: '123' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidCode');
    });

    it('400 for code longer than 6 digits', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-validate-activation',
        payload: { code: '1234567' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidCode');
    });

    it('400 for non-existent code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-validate-activation',
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidCode');
    });

    it('400 for expired code', async () => {
      // Seed an expired activation code
      const expiresAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      await prisma().user.update({
        where: { id: testUser.user.id },
        data: {
          gamesActivationCode: '999888',
          gamesActivationCodeExpiry: expiresAt,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-validate-activation',
        payload: { code: '999888' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('codeExpired');
    });

    it('200 for valid unexpired code', async () => {
      // Seed a fresh activation code
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
      await prisma().user.update({
        where: { id: testUser.user.id },
        data: {
          gamesActivationCode: '777666',
          gamesActivationCodeExpiry: expiresAt,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/games-validate-activation',
        payload: { code: '777666' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(typeof res.json().userHash).toBe('string');

      // Code should be cleared after validation
      const user = await prisma().user.findUnique({
        where: { id: testUser.user.id },
      });
      expect(user!.gamesActivationCode).toBeNull();
    });
  });

  // ====================================================================
  // VOTING PORTAL: PUT /account/voting-portal/:id
  // ====================================================================

  describe('PUT /account/voting-portal/:id', () => {
    it('400 for NaN id', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/account/voting-portal/abc',
        headers: userHeaders,
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('401 without token', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/account/voting-portal/${listId}`,
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('404 for non-existent list', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/account/voting-portal/999999',
        headers: userHeaders,
        payload: { name: 'Ghost' },
      });
      expect([403, 404]).toContain(res.statusCode);
    });

    it('403 or 500 when trying to update another user\'s list', async () => {
      // otherUser has no companyId, so gets "User does not belong to a company" → 500
      // If otherUser had a different companyId, they'd get "Access denied" → 403
      const otherUserHeaders = authHeader(otherUser.token);
      const res = await app.inject({
        method: 'PUT',
        url: `/account/voting-portal/${listId}`,
        headers: otherUserHeaders,
        payload: { name: 'Stolen', slug: 'stolen', description: 'X', numberOfTracks: 1, numberOfCards: 1, minimumNumberOfTracks: 0 },
      });
      expect([403, 500]).toContain(res.statusCode);
    });

    it('200 — updates list name and other fields', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/account/voting-portal/${listId}`,
        headers: userHeaders,
        payload: {
          name: 'AR2 Updated Name',
          slug: 'ar2-test-list-updated',
          description: 'Updated description',
          numberOfTracks: 4,
          numberOfCards: 50,
          minimumNumberOfTracks: 1,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  // ====================================================================
  // VOTING PORTAL: DELETE /account/voting-portal/:id
  // ====================================================================

  describe('DELETE /account/voting-portal/:id', () => {
    let deleteListId: number;

    beforeAll(async () => {
      // Create a separate list for deletion tests (so main listId stays intact)
      const delList = await prisma().companyList.create({
        data: {
          companyId,
          name: 'AR2 Delete Test',
          description_en: 'Delete Me',
          slug: 'ar2-delete-test',
          numberOfCards: 20,
          numberOfTracks: 2,
          status: 'new',
        },
      });
      deleteListId = delList.id;
    });

    it('400 for NaN id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/account/voting-portal/abc',
        headers: userHeaders,
      });
      expect(res.statusCode).toBe(400);
    });

    it('401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/account/voting-portal/${deleteListId}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('404 for non-existent list', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/account/voting-portal/999999',
        headers: userHeaders,
      });
      expect([403, 404]).toContain(res.statusCode);
    });

    it('403 or 500 when trying to delete another user\'s list', async () => {
      // otherUser has no companyId → 500 ("User does not belong to a company")
      // If they had a different companyId, they'd get 403 ("Access denied")
      const otherUserHeaders = authHeader(otherUser.token);
      const res = await app.inject({
        method: 'DELETE',
        url: `/account/voting-portal/${deleteListId}`,
        headers: otherUserHeaders,
      });
      expect([403, 500]).toContain(res.statusCode);
    });

    it('200 — deletes the list', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/account/voting-portal/${deleteListId}`,
        headers: userHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // Verify it's gone
      const deleted = await prisma().companyList.findUnique({
        where: { id: deleteListId },
      });
      expect(deleted).toBeNull();
    });
  });
});
