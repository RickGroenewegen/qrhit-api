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

describe('account routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('login', () => {
    it('rejects an unverified account', async () => {
      const { user, password } = await createTestUser();
      await prisma().user.update({
        where: { id: user.id },
        data: { verified: false },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/validate',
        payload: { email: user.email, password },
      });
      expect(res.statusCode).toBe(401);
    });

    it('logs in with correct credentials and sets the auth cookie', async () => {
      const { user, password } = await createTestUser();
      const res = await app.inject({
        method: 'POST',
        url: '/validate',
        payload: { email: user.email, password },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeTruthy();
      expect(body.userGroups).toContain('users');
      expect(res.headers['set-cookie']).toBeTruthy();
    });

    it('rejects wrong passwords with 401', async () => {
      const { user } = await createTestUser();
      const res = await app.inject({
        method: 'POST',
        url: '/validate',
        payload: { email: user.email, password: 'WrongPass1!' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('login rate limiting', () => {
    it('returns 429 after 10 failed attempts for the same ip+email', async () => {
      await flushTestRedis();
      const { user } = await createTestUser();
      const attempt = () =>
        app.inject({
          method: 'POST',
          url: '/validate',
          payload: { email: user.email, password: 'Wrong123!' },
          headers: { 'x-forwarded-for': '198.51.100.1' },
        });

      for (let i = 0; i < 10; i++) {
        expect((await attempt()).statusCode).toBe(401);
      }
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeTruthy();
    });

    it('a successful login clears the counters', async () => {
      await flushTestRedis();
      const { user, password } = await createTestUser();
      const wrong = () =>
        app.inject({
          method: 'POST',
          url: '/validate',
          payload: { email: user.email, password: 'Wrong123!' },
          headers: { 'x-forwarded-for': '198.51.100.2' },
        });
      for (let i = 0; i < 5; i++) await wrong();

      const ok = await app.inject({
        method: 'POST',
        url: '/validate',
        payload: { email: user.email, password },
        headers: { 'x-forwarded-for': '198.51.100.2' },
      });
      expect(ok.statusCode).toBe(200);

      // Counters reset: 10 fresh failures allowed again before a 429.
      for (let i = 0; i < 10; i++) {
        expect((await wrong()).statusCode).toBe(401);
      }
      expect((await wrong()).statusCode).toBe(429);
    });
  });

  describe('authenticated account endpoints', () => {
    it('POST /api/account/logout clears the cookie', async () => {
      const { token } = await createTestUser();
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/logout',
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
