import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline } from '../helpers/db';
import { createTestUser, authHeader } from '../helpers/auth';

/**
 * Authorization matrix: for representative protected endpoints, assert
 * 401 without a token, 403 with the wrong group, and non-401/403 with the
 * right group. Catches the scariest class of regression (an admin route
 * accidentally exposed) cheaply.
 */
describe('authorization matrix', () => {
  let app: FastifyInstance;
  let userToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    userToken = (await createTestUser({ groups: ['users'] })).token;
    adminToken = (await createTestUser({ groups: ['admin', 'users'] })).token;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const cases: { name: string; method: 'GET' | 'POST'; url: string; group: 'admin' | 'users' }[] = [
    { name: 'admin last plays', method: 'GET', url: '/lastplays', group: 'admin' },
    { name: 'admin payment verify', method: 'GET', url: '/verify/0', group: 'admin' },
    { name: 'account overview', method: 'GET', url: '/account/overview', group: 'users' },
  ];

  for (const c of cases) {
    describe(`${c.method} ${c.url} (${c.group} only)`, () => {
      it('rejects anonymous requests with 401', async () => {
        const res = await app.inject({ method: c.method, url: c.url });
        expect(res.statusCode).toBe(401);
      });

      it('rejects a tampered token with 401', async () => {
        const res = await app.inject({
          method: c.method,
          url: c.url,
          headers: { authorization: 'Bearer not.a.token' },
        });
        expect(res.statusCode).toBe(401);
      });

      if (c.group === 'admin') {
        it('rejects a regular user with 403', async () => {
          const res = await app.inject({
            method: c.method,
            url: c.url,
            headers: authHeader(userToken),
          });
          expect(res.statusCode).toBe(403);
        });
      }

      it(`lets a ${c.group} member through the auth layer`, async () => {
        const token = c.group === 'admin' ? adminToken : userToken;
        const res = await app.inject({
          method: c.method,
          url: c.url,
          headers: authHeader(token),
        });
        expect([401, 403]).not.toContain(res.statusCode);
      });
    });
  }
});
