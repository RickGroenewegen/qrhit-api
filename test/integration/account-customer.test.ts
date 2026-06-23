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
 * Customer self-service account flows: register-by-purchase (pincode),
 * password set/login/change, profile, purchases, last-order, logout,
 * forgot-password, login rate limiting and /account/overview.
 */
describe('customer account routes', () => {
  let app: FastifyInstance;
  const shopperEmail = 'shopper@test.qrsong.io';
  const password = 'Sup3rSecret!';
  let shopperId: number;
  let shopperToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    // A customer that bought something but never created an account.
    const shopper = await prisma().user.create({
      data: {
        userId: 'shopper-user-id',
        email: shopperEmail,
        displayName: 'Sandra Shopper',
        hash: 'shopper-hash',
        verified: false,
      },
    });
    shopperId = shopper.id;

    const orderType = await prisma().orderType.create({
      data: {
        name: 'digital',
        description: 'Digital order',
        amount: 5,
        digital: true,
      },
    });
    const playlist = await prisma().playlist.create({
      data: {
        playlistId: 'shopper-playlist',
        name: 'Shopper Mix',
        slug: 'shopper-mix',
        image: 'img.png',
      },
    });
    const payment = await prisma().payment.create({
      data: {
        userId: shopperId,
        paymentId: 'tr_shopper_1',
        orderId: 'QR123456',
        status: 'paid',
        fullname: 'Sandra Shopper',
        email: shopperEmail,
        totalPrice: 25,
        productPriceWithoutTax: 20,
        shippingPriceWithoutTax: 0,
        productVATPrice: 5,
        shippingVATPrice: 0,
        totalVATPrice: 5,
        address: 'Teststraat 1',
        housenumber: '1',
        city: 'Leiden',
        zipcode: '2311GJ',
        countrycode: 'NL',
      },
    });
    await prisma().paymentHasPlaylist.create({
      data: {
        paymentId: payment.id,
        playlistId: playlist.id,
        amount: 1,
        numberOfTracks: 42,
        orderTypeId: orderType.id,
        type: 'digital',
        filenameDigital: 'digital.pdf',
        price: 25,
        priceWithoutVAT: 20,
        priceVAT: 5,
      },
    });
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('registration with purchase pincode', () => {
    let pincode: string;
    let verificationToken: string;

    it('rejects an invalid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-register-request',
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidEmail');
    });

    it('404s when the email has no paid order', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-register-request',
        payload: { email: 'nobody@test.qrsong.io' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('noPurchaseFound');
    });

    it('sends a pincode for a paying customer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-register-request',
        payload: { email: shopperEmail.toUpperCase(), locale: 'nl' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('customerPincodeEmailSent');

      const user = await prisma().user.findUnique({ where: { id: shopperId } });
      expect(user!.gamesActivationCode).toMatch(/^\d{6}$/);
      pincode = user!.gamesActivationCode!;
    });

    it('rejects a wrong pincode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-verify-pincode',
        payload: { email: shopperEmail, pincode: '000000' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidPincode');
    });

    it('rejects an expired pincode and clears it', async () => {
      await prisma().user.update({
        where: { id: shopperId },
        data: { gamesActivationCodeExpiry: new Date(Date.now() - 1000) },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-verify-pincode',
        payload: { email: shopperEmail, pincode },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('pincodeExpired');
      const user = await prisma().user.findUnique({ where: { id: shopperId } });
      expect(user!.gamesActivationCode).toBeNull();
    });

    it('verifies a fresh pincode and returns a verification token', async () => {
      // request a new pincode after the expiry test consumed the old one
      await app.inject({
        method: 'POST',
        url: '/api/account/customer-register-request',
        payload: { email: shopperEmail },
      });
      const user = await prisma().user.findUnique({ where: { id: shopperId } });
      pincode = user!.gamesActivationCode!;

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-verify-pincode',
        payload: { email: shopperEmail, pincode },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.displayName).toBe('Sandra Shopper');
      verificationToken = body.verificationToken;
      expect(verificationToken).toHaveLength(64);
    });

    it('rejects mismatching passwords', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-set-password',
        payload: {
          verificationToken,
          password1: password,
          password2: 'Other1234!',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('passwordsDoNotMatch');
    });

    it('enforces password strength', async () => {
      const cases: Array<[string, string]> = [
        ['short1!', 'passwordTooShort'],
        ['alllower1!', 'passwordNeedsUppercase'],
        ['ALLUPPER1!', 'passwordNeedsLowercase'],
        ['NoNumbers!', 'passwordNeedsNumber'],
        ['NoSpecial123', 'passwordNeedsSpecialCharacter'],
      ];
      for (const [pw, error] of cases) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/account/customer-set-password',
          payload: { verificationToken, password1: pw, password2: pw },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe(error);
      }
    });

    it('sets the password, verifies the user and sets the auth cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-set-password',
        payload: {
          verificationToken,
          password1: password,
          password2: password,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.userGroups).toContain('users');
      expect(res.headers['set-cookie']).toBeTruthy();

      const user = await prisma().user.findUnique({ where: { id: shopperId } });
      expect(user!.verified).toBe(true);
      expect(user!.passwordIterations).toBe(600000);
    });

    it('rejects a reused verification token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-set-password',
        payload: {
          verificationToken,
          password1: password,
          password2: password,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalidOrExpiredToken');
    });

    it('refuses a second registration for an existing account', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-register-request',
        payload: { email: shopperEmail },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('accountAlreadyExists');
    });
  });

  describe('customer login', () => {
    it('requires email and password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-login',
        payload: { email: shopperEmail },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects wrong credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-login',
        payload: { email: shopperEmail, password: 'Wrong1234!' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalidCredentials');
    });

    it('rejects an unverified account', async () => {
      const { user, password: pw } = await createTestUser({
        email: 'unverified@test.qrsong.io',
      });
      await prisma().user.update({
        where: { id: user.id },
        data: { verified: false },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-login',
        payload: { email: 'unverified@test.qrsong.io', password: pw },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('accountNotVerified');
    });

    it('logs in with correct credentials and sets the cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-login',
        payload: { email: shopperEmail, password },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.userId).toBe('shopper-user-id');
      shopperToken = body.token;
      expect(res.headers['set-cookie']).toBeTruthy();
    });

    it('locks the account after 10 failed attempts', async () => {
      const email = 'lockout@test.qrsong.io';
      await createTestUser({ email });
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/account/customer-login',
          payload: { email, password: 'Wrong1234!' },
        });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/account/customer-login',
        payload: { email, password: 'Wrong1234!' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe('tooManyAttempts');
      expect(blocked.headers['retry-after']).toBeTruthy();
    });
  });

  describe('profile, purchases and last order', () => {
    it('requires authentication for the profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/account/customer-profile',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns the profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/account/customer-profile',
        headers: authHeader(shopperToken),
      });
      expect(res.statusCode).toBe(200);
      const { user } = res.json();
      expect(user.email).toBe(shopperEmail);
      expect(user.displayName).toBe('Sandra Shopper');
    });

    it('lists purchases with playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/account/customer-purchases',
        headers: authHeader(shopperToken),
      });
      expect(res.statusCode).toBe(200);
      const { purchases } = res.json();
      expect(purchases).toHaveLength(1);
      const p = purchases[0];
      expect(p.orderId).toBe('QR123456');
      expect(p.type).toBe('digital');
      expect(p.downloadAvailable).toBe(true);
      expect(p.playlists[0].name).toBe('Shopper Mix');
      expect(p.playlists[0].canDownload).toBe(true);
    });

    it('returns last-order info for prefilling checkout', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/account/customer-last-order',
        headers: authHeader(shopperToken),
      });
      expect(res.statusCode).toBe(200);
      const { orderInfo } = res.json();
      expect(orderInfo.fullname).toBe('Sandra Shopper');
      expect(orderInfo.city).toBe('Leiden');
      expect(orderInfo.countrycode).toBe('NL');
    });

    it('falls back to any order when preferPhysical finds none', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/account/customer-last-order?preferPhysical=true',
        headers: authHeader(shopperToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().orderInfo.fullname).toBe('Sandra Shopper');
    });

    it('returns basic info for a user without orders', async () => {
      const { user, token } = await createTestUser({
        email: 'no-orders@test.qrsong.io',
        displayName: 'No Orders',
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/account/customer-last-order',
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      const { orderInfo } = res.json();
      expect(orderInfo.fullname).toBe('No Orders');
      expect(orderInfo.email).toBe(user.email);
    });

    it('serves the account overview', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/account/overview',
        headers: authHeader(shopperToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.user.email).toBe(shopperEmail);
      expect(body.data.playlists).toHaveLength(1);
      expect(body.data.playlists[0].name).toBe('Shopper Mix');
    });
  });

  describe('change password', () => {
    it('rejects a wrong current password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-change-password',
        headers: authHeader(shopperToken),
        payload: {
          currentPassword: 'Wrong1234!',
          newPassword1: 'NewSecret1!',
          newPassword2: 'NewSecret1!',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('currentPasswordIncorrect');
    });

    it('rejects a weak new password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-change-password',
        headers: authHeader(shopperToken),
        payload: {
          currentPassword: password,
          newPassword1: 'weak',
          newPassword2: 'weak',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('passwordTooShort');
    });

    // BUG (documented, not fixed here): customer-change-password verifies the
    // current password with verifyPassword(currentPassword, hash, salt) and no
    // iteration count, so it defaults to LEGACY_ITERATIONS (10k). Accounts whose
    // password was stored with 600k iterations (everything created through
    // customer-set-password) can therefore NEVER change their password: the
    // correct current password is rejected with currentPasswordIncorrect.
    it('currently rejects the CORRECT current password for 600k-iteration accounts (iteration-count bug)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-change-password',
        headers: authHeader(shopperToken),
        payload: {
          currentPassword: password,
          newPassword1: 'NewSecret1!',
          newPassword2: 'NewSecret1!',
        },
      });
      // When the bug is fixed this should become 200 + a successful re-login
      // with the new password.
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('currentPasswordIncorrect');
    });

    it('changes the password for a legacy 10k-iteration account', async () => {
      // Seed a user whose hash matches the legacy iteration count the
      // verification path actually uses.
      const { hashPassword, generateSalt, generateToken } = await import(
        '../../src/auth'
      );
      const salt = generateSalt();
      const legacy = await prisma().user.create({
        data: {
          userId: 'legacy-user-id',
          email: 'legacy@test.qrsong.io',
          displayName: 'Legacy User',
          hash: 'legacy-hash',
          verified: true,
          verifiedAt: new Date(),
          password: hashPassword(password, salt, 10000),
          salt,
          passwordIterations: 10000,
        },
      });
      const usersGroup = await prisma().userGroup.findFirst({
        where: { name: 'users' },
      });
      await prisma().userInGroup.create({
        data: { userId: legacy.id, groupId: usersGroup!.id },
      });
      const token = generateToken(legacy.userId, ['users'], undefined, legacy.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/customer-change-password',
        headers: authHeader(token),
        payload: {
          currentPassword: password,
          newPassword1: 'NewSecret1!',
          newPassword2: 'NewSecret1!',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // BUG (second half of the same issue): the new hash is written with the
      // current 600k iterations but passwordIterations stays 10000, so login
      // verifies with 10k and the fresh password does NOT work.
      const relogin = await app.inject({
        method: 'POST',
        url: '/api/account/customer-login',
        payload: { email: 'legacy@test.qrsong.io', password: 'NewSecret1!' },
      });
      expect(relogin.statusCode).toBe(401);
    });
  });

  describe('forgot password and logout', () => {
    it('rejects an invalid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/forgot-password-request',
        payload: { email: 42 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('claims success for unknown emails (no enumeration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/forgot-password-request',
        payload: { email: 'ghost@test.qrsong.io' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('forgotPasswordEmailSent');
    });

    it('stores a pincode for a known account', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/forgot-password-request',
        payload: { email: shopperEmail },
      });
      expect(res.statusCode).toBe(200);
      const user = await prisma().user.findUnique({ where: { id: shopperId } });
      expect(user!.gamesActivationCode).toMatch(/^\d{6}$/);
    });

    it('clears the auth cookie on logout', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/logout',
      });
      expect(res.statusCode).toBe(200);
      const cookies = ([] as string[]).concat(res.headers['set-cookie'] as any);
      expect(cookies.some((c) => c.includes('='))).toBe(true);
    });
  });
});
