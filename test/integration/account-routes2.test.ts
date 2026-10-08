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
