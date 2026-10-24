import { FastifyInstance } from 'fastify';
import {
  authenticateUser,
  hashPassword,
  generateSalt,
  verifyPassword,
  generateToken,
} from '../auth';
import Mail from '../mail';
import PrismaInstance from '../prisma';
import crypto from 'crypto';
import LoginRateLimiter, { RateLimitFlow } from '../loginRateLimiter';
import Cache from '../cache';
import { setAuthCookie, clearAuthCookie } from '../cookieAuth';
import { APP_DESIGN_PRICE } from '../config/constants';
import { CARD_DESIGN_SELECT, pickCardDesign } from '../cardDesigns';
import Data from '../data';
import Designer from '../designer';
import Generator from '../generator';
import GiftVouchers, { normalizeGiftCode } from '../gift';
import { ownsLine } from '../lineOwner';

const prisma = PrismaInstance.getInstance();
const rateLimiter = LoginRateLimiter.getInstance();
const cache = Cache.getInstance();

/** Wrong pincodes per e-mail address before the pincode is voided. */
const MAX_PINCODE_FAILURES = 5;

function pincodeFailuresKey(email: string): string {
  return `pincode-failures:${email}`;
}

/** A six-digit pincode from a cryptographic source. */
function newPincode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * The account of someone redeeming a gift who has none yet, made the way an
 * order makes one (data/users.ts storeUser): the e-mail as userId, a random
 * hash for mailed links. Named after the voucher's "for", which the giver
 * typed; they can change it in their account.
 */
async function createGiftRecipient(email: string, recipientName: string, locale: unknown) {
  const data = {
    email,
    displayName: recipientName || email.split('@')[0],
    locale: typeof locale === 'string' ? locale.slice(0, 5) : 'en',
    hash: crypto.randomBytes(8).toString('hex'),
    sync: true,
  };
  try {
    return await prisma.user.create({ data: { ...data, userId: email } });
  } catch (error: any) {
    // A userId already taken by an account whose e-mail changed since
    if (error?.code !== 'P2002' || !String(error?.meta?.target || '').includes('userId')) throw error;
    return prisma.user.create({ data: { ...data, userId: crypto.randomUUID() } });
  }
}

/** Replies 429 and returns true when the limiter refuses this attempt. */
async function refuseWhenLimited(
  reply: any,
  clientIp: string,
  email: string,
  flow: RateLimitFlow
): Promise<boolean> {
  const check = await rateLimiter.checkRateLimit(clientIp, email, flow);
  if (check.allowed) {
    return false;
  }
  reply
    .status(429)
    .header('Retry-After', check.retryAfter?.toString() || '900')
    .send({
      success: false,
      error: 'tooManyAttempts',
      retryAfter: check.retryAfter,
    });
  return true;
}

/** The card type the customer chose: sheets are stored as physical with subType 'sheets'. */
function orderLineType(php: { type: string; subType: string | null }): 'digital' | 'physical' | 'sheets' {
  if (php.subType === 'sheets') return 'sheets';
  return php.type === 'physical' ? 'physical' : 'digital';
}

/**
 * A digital card line whose PDF has been made can get a new card design from
 * the account: the PDF is made again and mailed. Printed cards cannot.
 */
function canChangeDesign(php: {
  type: string;
  filenameDigital: string | null;
  playlist: { type: string };
}): boolean {
  return php.type === 'digital' && !!php.filenameDigital && php.playlist.type !== 'giftcard';
}

/** Design saves (each a new PDF and a mail) per line per hour. */
const MAX_REDESIGNS_PER_HOUR = 10;

export default async function accountRoutes(
  fastify: FastifyInstance,
  verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const mail = Mail.getInstance();

  // User login/validation
  fastify.post('/validate', async (request: any, reply: any) => {
    const { email, password } = request.body as {
      email: string;
      password: string;
    };

    // For backward compatibility, check if using old username field
    const username = request.body.username;
    const loginEmail = email || username;
    const clientIp = request.clientIp || request.ip || '0.0.0.0';

    // Check rate limit
    const rateLimitCheck = await rateLimiter.checkRateLimit(clientIp, loginEmail, 'login');
    if (!rateLimitCheck.allowed) {
      reply
        .status(429)
        .header('Retry-After', rateLimitCheck.retryAfter?.toString() || '600')
        .send({
          error: 'Too many login attempts. Please try again later.',
          retryAfter: rateLimitCheck.retryAfter,
        });
      return;
    }

    // First try DB authentication
    const authResult = await authenticateUser(loginEmail, password);

    if (authResult) {
      // Clear rate limit counters on successful login
      await rateLimiter.recordSuccessfulLogin(clientIp, loginEmail, 'login');

      // Set HttpOnly cookie
      setAuthCookie(reply, authResult.token);

      reply.send({
        token: authResult.token,
        userId: authResult.userId,
        userGroups: authResult.userGroups,
        companyId: authResult.companyId,
      });
      return;
    } else {
      // Record failed attempt
      await rateLimiter.recordFailedAttempt(clientIp, loginEmail, 'login');
      reply.status(401).send({ error: 'Invalid credentials' });
    }
  });

  // ==========================================
  // CUSTOMER ACCOUNT ENDPOINTS
  // ==========================================

  // Customer registration request - send pincode to email if they have orders
  fastify.post(
    '/api/account/customer-register-request',
    async (request: any, reply: any) => {
      const { email, locale } = request.body;

      // Validate email
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        reply.status(400).send({
          success: false,
          error: 'invalidEmail',
        });
        return;
      }

      const clientIp = request.clientIp || request.ip || '0.0.0.0';
      const normalizedEmail = email.toLowerCase().trim();

      // Every request sends a mail and tells whether the address has ordered,
      // so each one counts towards the limit.
      if (await refuseWhenLimited(reply, clientIp, normalizedEmail, 'pincode-request')) {
        return;
      }
      await rateLimiter.recordFailedAttempt(clientIp, normalizedEmail, 'pincode-request');

      try {
        // Check if this email has any paid orders
        const payment = await prisma.payment.findFirst({
          where: {
            email: normalizedEmail,
            status: 'paid',
          },
          include: {
            user: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

        // Someone redeeming a gift (src/gift.ts) may never have ordered: an
        // open voucher's code stands in for the purchase. A wrong code gets
        // the same answer as no code, so this never confirms a code.
        let account = payment?.user ?? null;
        let greetingName = payment?.fullname || payment?.user?.displayName || '';
        const giftCode = normalizeGiftCode(request.body?.giftCode);
        if (!account && giftCode) {
          const voucher = await prisma.giftVoucher.findUnique({
            where: { code: giftCode },
            select: { status: true, recipientName: true },
          });
          if (voucher?.status === 'open') {
            account =
              (await prisma.user.findUnique({ where: { email: normalizedEmail } })) ??
              (await createGiftRecipient(normalizedEmail, voucher.recipientName, locale));
            greetingName = account.displayName;
          }
        }

        // No paid order for this email — tell the user explicitly so they
        // know a purchase is required before creating an account.
        if (!account) {
          reply.status(404).send({
            success: false,
            error: 'noPurchaseFound',
          });
          return;
        }

        // Check if user already has a password set (already registered)
        if (account.password && account.salt && account.verified) {
          reply.status(400).send({
            success: false,
            error: 'accountAlreadyExists',
          });
          return;
        }

        // Generate a 6-digit pincode
        const pincode = newPincode();

        // Store the pincode with 15 minute expiry (reusing gamesActivationCode fields)
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await prisma.user.update({
          where: { id: account.id },
          data: {
            gamesActivationCode: pincode,
            gamesActivationCodeExpiry: expiresAt,
          },
        });
        await cache.del(pincodeFailuresKey(normalizedEmail));

        // Send pincode email
        const userLocale = locale || payment?.locale || account.locale || 'en';
        await mail.sendCustomerRegistrationPincode(
          normalizedEmail,
          greetingName || account.displayName,
          pincode,
          userLocale
        );

        reply.send({
          success: true,
          message: 'customerPincodeEmailSent',
        });
      } catch (error) {
        console.error('Error in customer register request:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // Forgot password request - send pincode to email for password reset
  fastify.post(
    '/api/account/forgot-password-request',
    async (request: any, reply: any) => {
      const { email, locale } = request.body;

      // Validate email
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        reply.status(400).send({
          success: false,
          error: 'invalidEmail',
        });
        return;
      }

      const clientIp = request.clientIp || request.ip || '0.0.0.0';
      const normalizedEmail = email.toLowerCase().trim();

      // Check rate limit. Every request sends a mail, so each one counts
      // (the limit was checked here but never counted, so it never applied).
      if (await refuseWhenLimited(reply, clientIp, normalizedEmail, 'password-reset')) {
        return;
      }
      await rateLimiter.recordFailedAttempt(clientIp, normalizedEmail, 'password-reset');

      try {

        // Find user with password set (existing account)
        const user = await prisma.user.findFirst({
          where: {
            email: normalizedEmail,
            password: { not: null },
          },
        });

        // Always return success to prevent email enumeration
        if (!user) {
          reply.send({
            success: true,
            message: 'forgotPasswordEmailSent',
          });
          return;
        }

        // Generate a 6-digit pincode
        const pincode = newPincode();

        // Store the pincode with 15 minute expiry (reusing gamesActivationCode fields)
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await prisma.user.update({
          where: { id: user.id },
          data: {
            gamesActivationCode: pincode,
            gamesActivationCodeExpiry: expiresAt,
          },
        });
        await cache.del(pincodeFailuresKey(normalizedEmail));

        // Send pincode email
        const userLocale = locale || user.locale || 'en';
        await mail.sendForgotPasswordPincode(
          normalizedEmail,
          user.displayName || normalizedEmail,
          pincode,
          userLocale
        );

        reply.send({
          success: true,
          message: 'forgotPasswordEmailSent',
        });
      } catch (error) {
        console.error('Error in forgot password request:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // Verify customer pincode and return verification token
  fastify.post(
    '/api/account/customer-verify-pincode',
    async (request: any, reply: any) => {
      const { email, pincode } = request.body;

      if (
        !email ||
        typeof email !== 'string' ||
        typeof pincode !== 'string' ||
        !/^\d{6}$/.test(pincode)
      ) {
        reply.status(400).send({
          success: false,
          error: 'invalidPincode',
        });
        return;
      }

      const clientIp = request.clientIp || request.ip || '0.0.0.0';
      const normalizedEmail = email.toLowerCase().trim();

      if (await refuseWhenLimited(reply, clientIp, normalizedEmail, 'pincode')) {
        return;
      }

      try {
        // Find user with this email and pincode
        const user = await prisma.user.findFirst({
          where: {
            email: normalizedEmail,
            gamesActivationCode: pincode,
          },
        });

        if (!user) {
          await rateLimiter.recordFailedAttempt(clientIp, normalizedEmail, 'pincode');

          // A pincode is a million guesses wide: after a few wrong ones it is
          // voided, so guessing from many addresses gains nothing either.
          const failures = await cache.increment(pincodeFailuresKey(normalizedEmail), 15 * 60);
          if (failures >= MAX_PINCODE_FAILURES) {
            await prisma.user.updateMany({
              where: { email: normalizedEmail, gamesActivationCode: { not: null } },
              data: { gamesActivationCode: null, gamesActivationCodeExpiry: null },
            });
            await cache.del(pincodeFailuresKey(normalizedEmail));
            reply.status(400).send({
              success: false,
              error: 'pincodeExpired',
            });
            return;
          }

          reply.status(400).send({
            success: false,
            error: 'invalidPincode',
          });
          return;
        }

        // Check if pincode is expired
        if (!user.gamesActivationCodeExpiry || user.gamesActivationCodeExpiry < new Date()) {
          // Clear expired pincode
          await prisma.user.update({
            where: { id: user.id },
            data: {
              gamesActivationCode: null,
              gamesActivationCodeExpiry: null,
            },
          });

          reply.status(400).send({
            success: false,
            error: 'pincodeExpired',
          });
          return;
        }

        await cache.del(pincodeFailuresKey(normalizedEmail));
        await rateLimiter.recordSuccessfulLogin(clientIp, normalizedEmail, 'pincode');

        // Generate a verification token for setting password
        const verificationToken = crypto.randomBytes(32).toString('hex');

        // Store verification token temporarily (reuse passwordResetToken fields)
        const tokenExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

        await prisma.user.update({
          where: { id: user.id },
          data: {
            passwordResetToken: verificationToken,
            passwordResetExpiry: tokenExpiry,
            gamesActivationCode: null,
            gamesActivationCodeExpiry: null,
          },
        });

        reply.send({
          success: true,
          verificationToken,
          displayName: user.displayName,
        });
      } catch (error) {
        console.error('Error in customer verify pincode:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // Set customer password using verification token
  fastify.post(
    '/api/account/customer-set-password',
    async (request: any, reply: any) => {
      const { verificationToken, password1, password2 } = request.body;

      if (!verificationToken || !password1 || !password2) {
        reply.status(400).send({
          success: false,
          error: 'missingRequiredFields',
        });
        return;
      }

      if (password1 !== password2) {
        reply.status(400).send({
          success: false,
          error: 'passwordsDoNotMatch',
        });
        return;
      }

      // Validate password strength
      if (password1.length < 8) {
        reply.status(400).send({ success: false, error: 'passwordTooShort' });
        return;
      }
      if (!/[A-Z]/.test(password1)) {
        reply.status(400).send({ success: false, error: 'passwordNeedsUppercase' });
        return;
      }
      if (!/[a-z]/.test(password1)) {
        reply.status(400).send({ success: false, error: 'passwordNeedsLowercase' });
        return;
      }
      if (!/[0-9]/.test(password1)) {
        reply.status(400).send({ success: false, error: 'passwordNeedsNumber' });
        return;
      }
      if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password1)) {
        reply.status(400).send({ success: false, error: 'passwordNeedsSpecialCharacter' });
        return;
      }

      try {
        // Find user with this verification token
        const user = await prisma.user.findFirst({
          where: {
            passwordResetToken: verificationToken,
          },
          include: {
            UserGroupUser: {
              include: {
                UserGroup: true,
              },
            },
          },
        });

        if (!user) {
          reply.status(400).send({
            success: false,
            error: 'invalidOrExpiredToken',
          });
          return;
        }

        // Check if token is expired
        if (!user.passwordResetExpiry || user.passwordResetExpiry < new Date()) {
          reply.status(400).send({
            success: false,
            error: 'invalidOrExpiredToken',
          });
          return;
        }

        // Hash password and update user
        const salt = generateSalt();
        const hashedPassword = hashPassword(password1, salt);

        await prisma.user.update({
          where: { id: user.id },
          data: {
            password: hashedPassword,
            salt,
            passwordIterations: 600000,
            verified: true,
            verifiedAt: new Date(),
            upgraded: true,
            passwordResetToken: null,
            passwordResetExpiry: null,
          },
        });

        // Ensure user is in 'users' group
        let usersGroup = await prisma.userGroup.findUnique({
          where: { name: 'users' },
        });

        if (!usersGroup) {
          usersGroup = await prisma.userGroup.create({
            data: { name: 'users' },
          });
        }

        const existingGroupConnection = await prisma.userInGroup.findFirst({
          where: {
            userId: user.id,
            groupId: usersGroup.id,
          },
        });

        if (!existingGroupConnection) {
          await prisma.userInGroup.create({
            data: {
              userId: user.id,
              groupId: usersGroup.id,
            },
          });
        }

        // Generate auth token
        const userGroups = [...user.UserGroupUser.map((ugu) => ugu.UserGroup.name), 'users'];
        const uniqueGroups = [...new Set(userGroups)];

        const token = generateToken(
          user.userId,
          uniqueGroups,
          user.companyId || undefined,
          user.id,
          user.displayName || undefined
        );

        // Set HttpOnly cookie
        setAuthCookie(reply, token);

        reply.send({
          success: true,
          token,
          userId: user.userId,
          userGroups: uniqueGroups,
          displayName: user.displayName,
        });
      } catch (error) {
        console.error('Error in customer set password:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // Customer login (for regular users, not admins)
  fastify.post(
    '/api/account/customer-login',
    async (request: any, reply: any) => {
      const { email, password } = request.body;

      if (!email || !password) {
        reply.status(400).send({
          success: false,
          error: 'missingRequiredFields',
        });
        return;
      }

      const clientIp = request.clientIp || request.ip || '0.0.0.0';
      const normalizedEmail = email.toLowerCase().trim();

      // Check rate limit
      const rateLimitCheck = await rateLimiter.checkRateLimit(
        clientIp,
        normalizedEmail,
        'login'
      );
      if (!rateLimitCheck.allowed) {
        reply
          .status(429)
          .header('Retry-After', rateLimitCheck.retryAfter?.toString() || '600')
          .send({
            success: false,
            error: 'tooManyAttempts',
            retryAfter: rateLimitCheck.retryAfter,
          });
        return;
      }

      try {
        const user = await prisma.user.findUnique({
          where: { email: normalizedEmail },
          include: {
            UserGroupUser: {
              include: {
                UserGroup: true,
              },
            },
          },
        });

        if (!user || !user.password || !user.salt) {
          await rateLimiter.recordFailedAttempt(clientIp, normalizedEmail, 'login');
          reply.status(401).send({
            success: false,
            error: 'invalidCredentials',
          });
          return;
        }

        if (!user.verified) {
          reply.status(401).send({
            success: false,
            error: 'accountNotVerified',
          });
          return;
        }

        // Get stored iteration count (default to legacy for old passwords)
        const storedIterations = user.passwordIterations || 10000;
        const isValid = verifyPassword(
          password,
          user.password,
          user.salt,
          storedIterations
        );

        if (!isValid) {
          await rateLimiter.recordFailedAttempt(clientIp, normalizedEmail, 'login');
          reply.status(401).send({
            success: false,
            error: 'invalidCredentials',
          });
          return;
        }

        // Lazy rehashing: upgrade to current iterations if using legacy
        if (storedIterations < 600000) {
          try {
            const newSalt = generateSalt();
            const newHash = hashPassword(password, newSalt, 600000);
            await prisma.user.update({
              where: { id: user.id },
              data: {
                password: newHash,
                salt: newSalt,
                passwordIterations: 600000,
              },
            });
          } catch (rehashError) {
            console.error('Failed to rehash password:', rehashError);
          }
        }

        // Clear rate limit counters on successful login
        await rateLimiter.recordSuccessfulLogin(clientIp, normalizedEmail, 'login');

        const userGroups = user.UserGroupUser.map((ugu) => ugu.UserGroup.name);

        const token = generateToken(
          user.userId,
          userGroups,
          user.companyId || undefined,
          user.id,
          user.displayName || undefined
        );

        // Set HttpOnly cookie
        setAuthCookie(reply, token);

        reply.send({
          success: true,
          token,
          userId: user.userId,
          userGroups,
          displayName: user.displayName,
        });
      } catch (error) {
        console.error('Error in customer login:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // Change password (protected - for logged in users)
  fastify.post(
    '/api/account/customer-change-password',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      const { currentPassword, newPassword1, newPassword2 } = request.body;

      if (!currentPassword || !newPassword1 || !newPassword2) {
        reply.status(400).send({
          success: false,
          error: 'missingRequiredFields',
        });
        return;
      }

      if (newPassword1 !== newPassword2) {
        reply.status(400).send({
          success: false,
          error: 'passwordsDoNotMatch',
        });
        return;
      }

      // Validate password strength
      if (newPassword1.length < 8) {
        reply.status(400).send({ success: false, error: 'passwordTooShort' });
        return;
      }
      if (!/[A-Z]/.test(newPassword1)) {
        reply.status(400).send({ success: false, error: 'passwordNeedsUppercase' });
        return;
      }
      if (!/[a-z]/.test(newPassword1)) {
        reply.status(400).send({ success: false, error: 'passwordNeedsLowercase' });
        return;
      }
      if (!/[0-9]/.test(newPassword1)) {
        reply.status(400).send({ success: false, error: 'passwordNeedsNumber' });
        return;
      }
      if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword1)) {
        reply.status(400).send({ success: false, error: 'passwordNeedsSpecialCharacter' });
        return;
      }

      try {
        const user = await prisma.user.findUnique({
          where: { userId: request.user.userId },
        });

        if (!user || !user.password || !user.salt) {
          reply.status(400).send({
            success: false,
            error: 'invalidCredentials',
          });
          return;
        }

        // Verify current password
        const isValid = verifyPassword(currentPassword, user.password, user.salt);
        if (!isValid) {
          reply.status(400).send({
            success: false,
            error: 'currentPasswordIncorrect',
          });
          return;
        }

        // Hash and save new password
        const salt = generateSalt();
        const hashedPassword = hashPassword(newPassword1, salt);

        await prisma.user.update({
          where: { id: user.id },
          data: {
            password: hashedPassword,
            salt,
          },
        });

        reply.send({
          success: true,
        });
      } catch (error) {
        console.error('Error in change password:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // Get customer profile (protected)
  fastify.get(
    '/api/account/customer-profile',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const user = await prisma.user.findUnique({
          where: { userId: request.user.userId },
          select: {
            id: true,
            email: true,
            displayName: true,
            locale: true,
            createdAt: true,
          },
        });

        if (!user) {
          reply.status(404).send({
            success: false,
            error: 'userNotFound',
          });
          return;
        }

        // Earn-discount programme: the customer's promotional code with what
        // it has earned in total and what is left to spend, so the account
        // page can show both. Same arithmetic as promotional.ts.
        const discountCode = await prisma.discountCode.findFirst({
          where: { promotional: true, promotionalUserId: user.id },
          select: { code: true, amount: true },
        });
        let promotionalCode: { code: string; earned: number; balance: number } | null = null;
        if (discountCode) {
          const totalUsed = await prisma.discountCodedUses.aggregate({
            where: { discountCode: { promotional: true, promotionalUserId: user.id } },
            _sum: { amount: true },
          });
          promotionalCode = {
            code: discountCode.code,
            earned: discountCode.amount,
            balance: Math.max(0, discountCode.amount - (totalUsed._sum.amount || 0)),
          };
        }

        reply.send({
          success: true,
          user: { ...user, promotionalCode },
        });
      } catch (error) {
        console.error('Error in customer profile:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // Get customer purchase history (protected)
  fastify.get(
    '/api/account/customer-purchases',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const user = await prisma.user.findUnique({
          where: { userId: request.user.userId },
        });

        if (!user) {
          reply.status(404).send({
            success: false,
            error: 'userNotFound',
          });
          return;
        }

        const lineInclude = {
          playlist: {
            select: {
              playlistId: true,
              name: true,
              image: true,
              type: true,
            },
          },
          extraDesigns: { select: CARD_DESIGN_SELECT, orderBy: { position: 'asc' as const } },
          bingoFiles: {
            orderBy: {
              createdAt: 'desc' as const,
            },
          },
        };

        // Get all paid orders for this user with their playlists
        const payments = await prisma.payment.findMany({
          where: {
            userId: user.id,
            status: 'paid',
          },
          include: {
            PaymentHasPlaylist: {
              include: lineInclude,
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

        // Sets other people gave this user (src/gift.ts): theirs to use, on
        // someone else's order, so nothing of that order is sent along
        const receivedLines = await prisma.paymentHasPlaylist.findMany({
          where: { ownerUserId: user.id, payment: { status: 'paid' } },
          include: {
            ...lineInclude,
            payment: { select: { paymentId: true, finalized: true } },
          },
          orderBy: { id: 'desc' },
        });

        const apiUri = process.env['API_URI'] || 'http://localhost:3004';
        const gifts = GiftVouchers.getInstance();
        const [giverState, receivedState] = await Promise.all([
          gifts.giverState(payments.map((payment) => payment.id)),
          gifts.receivedState(user.id),
        ]);

        // App Designer is on the account: whether it is owned, and what each
        // playlist shows (its override mode, `default` when it has none).
        const [appDesignPurchases, appDesignRows] = await Promise.all([
          prisma.appDesignPurchase.count({ where: { userId: user.id } }),
          prisma.appDesign.findMany({
            where: { userId: user.id },
            select: { paymentHasPlaylistId: true, mode: true, keepActive: true },
          }),
        ]);
        const lineAppDesigns = appDesignRows.filter((row) => row.paymentHasPlaylistId !== null);
        const appDesignModeByLine = new Map(
          lineAppDesigns.map((row) => [row.paymentHasPlaylistId as number, row.mode])
        );
        // Designs that came along with a gift and stay on those cards
        const keptAppDesigns = new Set(
          lineAppDesigns.filter((row) => row.keepActive).map((row) => row.paymentHasPlaylistId as number)
        );

        // One set as the account page shows it. `finalized` is its order's.
        const mapLine = (php: (typeof receivedLines)[number] | (typeof payments)[number]['PaymentHasPlaylist'][number], finalized: boolean) => ({
          paymentHasPlaylistId: php.id, // Needed for bingo upgrade payment
          playlistId: php.playlist.playlistId,
          name: php.playlist.name,
          image: php.playlist.image,
          numberOfTracks: php.numberOfTracks,
          type: php.type,
          // What the customer chose: sheets are stored as physical + subType.
          orderType: orderLineType(php),
          // Gift cards cannot be ordered again from the account: they are
          // not a card set built in the order flow.
          canOrderAgain: php.playlist.type !== 'giftcard',
          // Individual playlist download availability
          canDownload: php.type === 'digital'
            ? !!php.filenameDigital
            : finalized && !!php.filenameDigital,
          canChangeDesign: canChangeDesign(php),
          // The card design, for the preview in the list. A gift card has none.
          design: php.playlist.type === 'giftcard' ? null : pickCardDesign(php),
          extraDesigns: php.extraDesigns.map(pickCardDesign),
          eco: php.eco,
          doubleSided: php.doubleSided,
          // Whether bingo is enabled for this playlist
          gamesEnabled: php.gamesEnabled,
          boxEnabled: php.boxEnabled,
          appDesignMode: appDesignModeByLine.get(php.id) || 'default',
          appDesignKept: keptAppDesigns.has(php.id),
          // Bingo files for this playlist
          bingoFiles: php.bingoFiles.map((bf: any) => ({
            filename: bf.filename,
            contestants: bf.contestants,
            rounds: bf.rounds,
            trackCount: bf.trackCount,
            createdAt: bf.createdAt,
            downloadUrl: `${apiUri}/public/bingo/${bf.filename}`,
          })),
        });

        const purchases = payments.map((payment) => {
          // Determine if downloads are available
          // For digital orders: available when filenameDigital exists
          // For physical orders: available when finalized (they receive digital copy)
          const isPhysicalOrder = payment.PaymentHasPlaylist.some((php) => php.type === 'physical' || php.type === 'sheets');

          return {
            orderId: payment.orderId,
            paymentId: payment.paymentId,
            userHash: user.hash,
            createdAt: payment.createdAt,
            amount: payment.totalPrice,
            // Currency the customer actually paid in, plus the amount they saw
            // on the Mollie page. Fall back to EUR for historical rows that
            // predate multi-currency support.
            currency: payment.currency || 'EUR',
            amountPresentment:
              payment.totalPricePresentment ?? payment.totalPrice,
            status: payment.status,
            type: payment.PaymentHasPlaylist.length > 0 ? payment.PaymentHasPlaylist[0].type : 'digital',
            // For physical orders, download is available after finalized
            // For digital orders, download is available when filenameDigital exists
            downloadAvailable: isPhysicalOrder
              ? payment.finalized === true
              : payment.PaymentHasPlaylist.some((php) => !!php.filenameDigital),
            playlists: payment.PaymentHasPlaylist.map((php) => {
              const gift = giverState.get(php.id);
              const line = {
                ...mapLine(php, payment.finalized === true),
                // Giving it away: whether it can go on a voucher now (and
                // why not), the open voucher, or to whom it went
                giftable: gift?.giftable ?? false,
                giftBlockedReason: gift?.giftBlockedReason ?? null,
                giftVoucher: gift?.voucher ?? null,
                given: gift?.given ?? null,
              };
              // A set given away is the recipient's: the giver keeps the
              // order and the invoice, nothing to download, design or play
              if (line.given) {
                return {
                  ...line,
                  canOrderAgain: false,
                  canDownload: false,
                  canChangeDesign: false,
                  gamesEnabled: false,
                  bingoFiles: [],
                };
              }
              return line;
            }),
          };
        });

        // Received gifts: the holder's own links (paymentId + their hash),
        // and no price, order number or invoice
        const received = receivedLines.map((php) => {
          const gift = receivedState.get(php.id);
          return {
            paymentId: php.payment.paymentId,
            userHash: user.hash,
            fromName: gift?.fromName ?? '',
            message: gift?.message ?? null,
            claimedAt: gift?.claimedAt ?? null,
            playlist: mapLine(php, php.payment.finalized === true),
          };
        });

        reply.send({
          success: true,
          purchases,
          received,
          appDesign: {
            entitled: appDesignPurchases > 0,
            price: APP_DESIGN_PRICE,
            hasDefault: appDesignRows.some((row) => row.paymentHasPlaylistId === null),
          },
        });
      } catch (error) {
        console.error('Error in customer purchases:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // "Order again" from the account: one past order line as the order flow
  // needs it to start over on the card overview with the same card and box
  // design. Images are bare filenames in shared folders, so the new order
  // reuses the same files.
  fastify.get(
    '/api/account/order-again/:paymentHasPlaylistId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const phpId = parseInt(request.params.paymentHasPlaylistId, 10);
        if (!Number.isInteger(phpId)) {
          reply.status(400).send({ success: false, error: 'invalidId' });
          return;
        }
        const user = await prisma.user.findUnique({
          where: { userId: request.user.userId },
          select: { id: true },
        });
        const php = await prisma.paymentHasPlaylist.findUnique({
          where: { id: phpId },
          include: {
            payment: { select: { userId: true, status: true } },
            playlist: {
              select: { playlistId: true, serviceType: true, type: true, name: true, image: true },
            },
            extraDesigns: { select: CARD_DESIGN_SELECT, orderBy: { position: 'asc' } },
          },
        });
        // Whoever holds the set (src/lineOwner.ts): a received gift can be
        // ordered again in its design, a set given away no longer
        if (!user || !php || !ownsLine(php, user.id) || php.payment.status !== 'paid') {
          reply.status(404).send({ success: false, error: 'orderNotFound' });
          return;
        }
        if (php.playlist.type === 'giftcard') {
          reply.status(400).send({ success: false, error: 'notReorderable' });
          return;
        }

        const type = orderLineType(php);
        reply.send({
          success: true,
          order: {
            paymentHasPlaylistId: php.id,
            playlistId: php.playlist.playlistId,
            serviceType: php.playlist.serviceType || 'spotify',
            name: php.playlist.name,
            image: php.playlist.image,
            type,
            eco: php.eco,
            doubleSided: php.doubleSided,
            allowDuplicates: php.allowDuplicates,
            gamesEnabled: php.gamesEnabled,
            design: pickCardDesign(php),
            extraDesigns: php.extraDesigns.map(pickCardDesign),
            // Boxes come with physical cards only.
            box:
              type === 'physical' && php.boxEnabled
                ? {
                    boxFrontBackgroundType: php.boxFrontBackgroundType,
                    boxFrontBackground: php.boxFrontBackground,
                    boxFrontBackgroundColor: php.boxFrontBackgroundColor,
                    boxFrontLogo: php.boxFrontLogo,
                    boxFrontLogoScale: php.boxFrontLogoScale,
                    boxFrontLogoPositionX: php.boxFrontLogoPositionX,
                    boxFrontLogoPositionY: php.boxFrontLogoPositionY,
                    boxFrontEmoji: php.boxFrontEmoji,
                    boxBackBackgroundType: php.boxBackBackgroundType,
                    boxBackBackground: php.boxBackBackground,
                    boxBackBackgroundColor: php.boxBackBackgroundColor,
                    boxBackFontColor: php.boxBackFontColor,
                    boxBackUseGradient: php.boxBackUseGradient,
                    boxBackGradientColor: php.boxBackGradientColor,
                    boxBackGradientDegrees: php.boxBackGradientDegrees,
                    boxBackGradientPosition: php.boxBackGradientPosition,
                    boxBackOpacity: php.boxBackOpacity,
                    boxBackText: php.boxBackText,
                    boxBackSelectedFont: php.boxBackSelectedFont,
                    boxBackSelectedFontSize: php.boxBackSelectedFontSize,
                  }
                : null,
          },
        });
      } catch (error) {
        console.error('Error in order again:', error);
        reply.status(500).send({ success: false, error: 'internalServerError' });
      }
    }
  );

  /**
   * The paid card line `paymentHasPlaylistId` (not a gift card) the signed-in
   * customer holds (a set they bought or received as a gift), with what the
   * designer and the card previews need.
   */
  async function ownCardLine(userId: string, paymentHasPlaylistId: unknown) {
    const phpId = parseInt(String(paymentHasPlaylistId), 10);
    if (!Number.isInteger(phpId)) return null;
    const user = await prisma.user.findUnique({
      where: { userId },
      select: { id: true, hash: true },
    });
    const php = await prisma.paymentHasPlaylist.findUnique({
      where: { id: phpId },
      include: {
        payment: { select: { paymentId: true, userId: true, status: true } },
        playlist: { select: { playlistId: true, serviceType: true, type: true, name: true } },
        extraDesigns: { select: CARD_DESIGN_SELECT, orderBy: { position: 'asc' } },
      },
    });
    if (
      !user ||
      !php ||
      !ownsLine(php, user.id) ||
      php.payment.status !== 'paid' ||
      php.playlist.type === 'giftcard'
    ) {
      return null;
    }
    return { user, php };
  }

  // A line's card design and its cards in print order: for the designer
  // ("Change design", digital lines) and the larger view of the cards
  fastify.get(
    '/api/account/card-design/:paymentHasPlaylistId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const found = await ownCardLine(
          request.user.userId,
          request.params.paymentHasPlaylistId
        );
        if (!found) {
          reply.status(404).send({ success: false, error: 'orderNotFound' });
          return;
        }
        const { php } = found;
        const order = await Data.getInstance().getPlaylistTrackOrder(php.id);
        const tracks = (order.tracks ?? []).slice(0, php.numberOfTracks).map((track) => ({
          trackId: track.trackId,
          name: track.name,
          artist: track.artist,
          year: track.year,
        }));
        reply.send({
          success: true,
          line: {
            paymentHasPlaylistId: php.id,
            playlistId: php.playlist.playlistId,
            serviceType: php.playlist.serviceType || 'spotify',
            name: php.playlist.name,
            numberOfTracks: php.numberOfTracks,
            type: php.type,
            subType: php.subType,
            eco: php.eco,
            doubleSided: php.doubleSided,
            design: pickCardDesign(php),
            extraDesigns: php.extraDesigns.map(pickCardDesign),
            canChangeDesign: canChangeDesign(php),
          },
          tracks,
        });
      } catch (error) {
        console.error('Error in get card design:', error);
        reply.status(500).send({ success: false, error: 'internalServerError' });
      }
    }
  );

  // Save the new design, then make the PDF again and mail it (queued, so the
  // customer is told it arrives within a few minutes)
  fastify.post(
    '/api/account/card-design/:paymentHasPlaylistId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const found = await ownCardLine(
          request.user.userId,
          request.params.paymentHasPlaylistId
        );
        if (!found || !canChangeDesign(found.php)) {
          reply.status(404).send({ success: false, error: 'orderNotFound' });
          return;
        }
        const { user, php } = found;

        const saves = await cache.increment(`card-redesign:${php.id}`, 3600);
        if (saves > MAX_REDESIGNS_PER_HOUR) {
          reply.status(429).send({ success: false, error: 'tooManyRedesigns' });
          return;
        }

        const saved = await Designer.getInstance().updateCardDesign(
          php.payment.paymentId,
          user.hash,
          php.playlist.playlistId,
          php.type,
          php.subType ?? 'none',
          request.body ?? {}
        );
        if (!saved) {
          reply.status(500).send({ success: false, error: 'internalServerError' });
          return;
        }

        await Generator.getInstance().queueDigitalRedesign(php.payment.paymentId, php.id);
        reply.send({ success: true });
      } catch (error) {
        console.error('Error in save card design:', error);
        reply.status(500).send({ success: false, error: 'internalServerError' });
      }
    }
  );

  // Get last order info for pre-filling checkout form (protected)
  // Query param: ?preferPhysical=true - when ordering physical products, prefer a physical order with full address
  fastify.get(
    '/api/account/customer-last-order',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const preferPhysical = request.query.preferPhysical === 'true';

        const user = await prisma.user.findUnique({
          where: { userId: request.user.userId },
        });

        if (!user) {
          reply.status(404).send({
            success: false,
            error: 'userNotFound',
          });
          return;
        }

        const selectFields = {
          fullname: true,
          email: true,
          isBusinessOrder: true,
          companyName: true,
          vatId: true,
          address: true,
          housenumber: true,
          city: true,
          zipcode: true,
          countrycode: true,
        };

        let lastPayment = null;

        if (preferPhysical) {
          // For physical orders: first try to find a physical order with address
          lastPayment = await prisma.payment.findFirst({
            where: {
              userId: user.id,
              status: 'paid',
              address: { not: '' },
              PaymentHasPlaylist: {
                some: {
                  type: 'physical',
                },
              },
            },
            orderBy: {
              createdAt: 'desc',
            },
            select: selectFields,
          });

          // If no physical order with address, fall back to any order for name+email+country
          if (!lastPayment) {
            lastPayment = await prisma.payment.findFirst({
              where: {
                userId: user.id,
                status: 'paid',
              },
              orderBy: {
                createdAt: 'desc',
              },
              select: selectFields,
            });
          }
        } else {
          // For digital orders: just get the most recent order
          lastPayment = await prisma.payment.findFirst({
            where: {
              userId: user.id,
              status: 'paid',
            },
            orderBy: {
              createdAt: 'desc',
            },
            select: selectFields,
          });
        }

        if (!lastPayment) {
          // No previous orders, return user's basic info
          reply.send({
            success: true,
            orderInfo: {
              fullname: user.displayName || '',
              email: user.email,
            },
          });
          return;
        }

        reply.send({
          success: true,
          orderInfo: {
            fullname: lastPayment.fullname || '',
            email: lastPayment.email || user.email,
            isBusinessOrder: lastPayment.isBusinessOrder || false,
            companyName: lastPayment.companyName || '',
            vatId: lastPayment.vatId || '',
            address: lastPayment.address || '',
            housenumber: lastPayment.housenumber || '',
            city: lastPayment.city || '',
            zipcode: lastPayment.zipcode || '',
            countrycode: lastPayment.countrycode || '',
          },
        });
      } catch (error) {
        console.error('Error in customer last order:', error);
        reply.status(500).send({
          success: false,
          error: 'internalServerError',
        });
      }
    }
  );

  // Logout endpoint - clears the HttpOnly auth cookie
  fastify.post('/api/account/logout', async (request: any, reply: any) => {
    clearAuthCookie(reply);
    reply.send({ success: true });
  });
}
