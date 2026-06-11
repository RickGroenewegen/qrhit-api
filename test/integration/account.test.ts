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

describe('account routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Registration & reset flows verify a captcha against Google; never in tests.
    vi.spyOn(Utils.prototype, 'verifyRecaptcha').mockResolvedValue({
      isHuman: true,
      score: 0.9,
    });
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('register → verify → login', () => {
    const email = 'new-user@test.qrsong.io';
    const password = 'Sup3rSecret!';

    it('registers a new account', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/account/register',
        payload: {
          displayName: 'New User',
          email,
          password1: password,
          password2: password,
          captchaToken: 'token',
          locale: 'en',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const user = await prisma().user.findUnique({ where: { email } });
      expect(user).toBeTruthy();
      expect(user!.verified).toBe(false);
      expect(user!.verificationHash).toBeTruthy();
    });

    it('rejects login before verification', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/validate',
        payload: { email, password },
      });
      expect(res.statusCode).toBe(401);
    });

    it('verifies the account with the stored hash', async () => {
      const user = await prisma().user.findUnique({ where: { email } });
      const res = await app.inject({
        method: 'POST',
        url: '/account/verify',
        payload: { verificationHash: user!.verificationHash },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const verified = await prisma().user.findUnique({ where: { email } });
      expect(verified!.verified).toBe(true);
    });

    it('rejects an invalid verification hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/account/verify',
        payload: { verificationHash: 'nope' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('logs in with correct credentials and sets the auth cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/validate',
        payload: { email, password },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeTruthy();
      expect(body.userGroups).toContain('users');
      expect(res.headers['set-cookie']).toBeTruthy();
    });

    it('rejects wrong passwords with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/validate',
        payload: { email, password: 'WrongPass1!' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('registration validation', () => {
    const base = {
      displayName: 'X',
      email: 'val@test.qrsong.io',
      captchaToken: 't',
    };

    it('rejects mismatched passwords', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/account/register',
        payload: { ...base, password1: 'Abcdef12!', password2: 'Abcdef13!' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('passwordsDoNotMatch');
    });

    it('rejects weak passwords with a specific error', async () => {
      const cases: [string, string][] = [
        ['short1A', 'passwordTooShort'],
        ['alllowercase1', 'passwordNeedsUppercase'],
        ['ALLUPPERCASE1', 'passwordNeedsLowercase'],
        ['NoDigitsHere', 'passwordNeedsNumber'],
        ['NoSpecial12', 'passwordNeedsSpecialCharacter'],
      ];
      for (const [pw, error] of cases) {
        const res = await app.inject({
          method: 'POST',
          url: '/account/register',
          payload: { ...base, password1: pw, password2: pw },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe(error);
      }
    });

    it('returns 409 for an already upgraded account', async () => {
      const { user } = await createTestUser();
      await prisma().user.update({
        where: { id: user.id },
        data: { upgraded: true },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/account/register',
        payload: {
          ...base,
          email: user.email,
          password1: 'Abcdef12!',
          password2: 'Abcdef12!',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('accountAlreadyExists');
    });

    it('upgrades an existing non-upgraded (purchase-only) account', async () => {
      const { user } = await createTestUser();
      const res = await app.inject({
        method: 'POST',
        url: '/account/register',
        payload: {
          ...base,
          email: user.email,
          password1: 'Abcdef12!',
          password2: 'Abcdef12!',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('accountUpgraded');
      const upgraded = await prisma().user.findUnique({
        where: { id: user.id },
      });
      expect(upgraded!.upgraded).toBe(true);
      expect(upgraded!.verified).toBe(false); // must re-verify
    });
  });

  describe('password reset flow', () => {
    it('issues a token, accepts the reset, and the new password works', async () => {
      const { user } = await createTestUser({ password: 'OldPass123!' });

      const req = await app.inject({
        method: 'POST',
        url: '/account/reset-password-request',
        payload: { email: user.email, captchaToken: 't' },
      });
      expect(req.statusCode).toBe(200);

      const withToken = await prisma().user.findUnique({
        where: { id: user.id },
      });
      expect(withToken!.passwordResetToken).toBeTruthy();

      const check = await app.inject({
        method: 'GET',
        url: `/account/reset-password-check/${withToken!.passwordResetToken}`,
      });
      expect(check.statusCode).toBe(200);

      const reset = await app.inject({
        method: 'POST',
        url: '/account/reset-password',
        payload: {
          hash: withToken!.passwordResetToken,
          password1: 'NewPass123!',
          password2: 'NewPass123!',
          captchaToken: 't',
        },
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().success).toBe(true);

      const login = await app.inject({
        method: 'POST',
        url: '/validate',
        payload: { email: user.email, password: 'NewPass123!' },
      });
      expect(login.statusCode).toBe(200);
    });

    it('rejects an unknown reset token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/account/reset-password',
        payload: {
          hash: 'bogus',
          password1: 'NewPass123!',
          password2: 'NewPass123!',
          captchaToken: 't',
        },
      });
      expect(res.statusCode).toBe(400);
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
    it('GET /account/overview requires a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/account/overview' });
      expect(res.statusCode).toBe(401);
    });

    it('GET /account/overview returns data for a logged-in user', async () => {
      const { token } = await createTestUser();
      const res = await app.inject({
        method: 'GET',
        url: '/account/overview',
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
    });

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
