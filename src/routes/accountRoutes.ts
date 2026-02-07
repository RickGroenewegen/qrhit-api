import { FastifyInstance } from 'fastify';
import {
  registerAccount,
  verifyUser,
  initiatePasswordReset,
  resetPassword,
  checkPasswordResetToken,
  authenticateUser,
  hashPassword,
  generateSalt,
  verifyPassword,
  generateToken,
} from '../auth';
import Account from '../account';
import Mail from '../mail';
import { PrismaClient } from '@prisma/client';
import PrismaInstance from '../prisma';
import crypto from 'crypto';
import LoginRateLimiter from '../loginRateLimiter';
import { setAuthCookie, clearAuthCookie } from '../cookieAuth';

const prisma = PrismaInstance.getInstance();
const rateLimiter = LoginRateLimiter.getInstance();

export default async function accountRoutes(
  fastify: FastifyInstance,
  verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const account = Account.getInstance();
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
    const rateLimitCheck = await rateLimiter.checkRateLimit(clientIp, loginEmail);
    if (!rateLimitCheck.allowed) {
      reply
        .status(429)
        .header('Retry-After', rateLimitCheck.retryAfter?.toString() || '1800')
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
      await rateLimiter.recordSuccessfulLogin(clientIp, loginEmail);

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
      await rateLimiter.recordFailedAttempt(clientIp, loginEmail);
      reply.status(401).send({ error: 'Invalid credentials' });
    }
  });

  // User registration
  fastify.post('/account/register', async (request: any, reply: any) => {
    const { displayName, email, password1, password2, captchaToken, locale } =
      request.body;

    const result = await registerAccount(
      displayName,
      email,
      password1,
      password2,
      captchaToken,
      locale
    );

    if (result.success) {
      reply.send(result);
    } else {
      const statusCode = result.error === 'accountAlreadyExists' ? 409 : 400;
      reply.status(statusCode).send(result);
    }
  });

  // Account verification
  fastify.post('/account/verify', async (request: any, reply: any) => {
    const { verificationHash } = request.body;

    const result = await verifyUser(verificationHash);

    if (result.success && result.token) {
      // Set HttpOnly cookie on successful verification
      setAuthCookie(reply, result.token);
      reply.send(result);
    } else if (result.success) {
      reply.send(result);
    } else {
      const statusCode =
        result.error === 'invalidHash' || result.error === 'alreadyVerified'
          ? 400
          : 500;
      reply.status(statusCode).send(result);
    }
  });

  // Password reset request
  fastify.post(
    '/account/reset-password-request',
    async (request: any, reply: any) => {
      const { email, captchaToken } = request.body;
      const clientIp = request.clientIp || request.ip || '0.0.0.0';

      // Check rate limit (use email or 'reset' as identifier)
      const rateLimitCheck = await rateLimiter.checkRateLimit(
        clientIp,
        email || 'password-reset'
      );
      if (!rateLimitCheck.allowed) {
        reply
          .status(429)
          .header('Retry-After', rateLimitCheck.retryAfter?.toString() || '1800')
          .send({
            success: false,
            error: 'tooManyAttempts',
            retryAfter: rateLimitCheck.retryAfter,
          });
        return;
      }

      const result = await initiatePasswordReset(email, captchaToken);

      if (result.success) {
        reply.send(result);
      } else {
        const statusCode =
          result.error === 'missingRequiredFields' ||
          result.error === 'invalidEmailFormat' ||
          result.error === 'captchaVerificationFailed'
            ? 400
            : 500;
        reply.status(statusCode).send(result);
      }
    }
  );

  // Password reset
  fastify.post('/account/reset-password', async (request: any, reply: any) => {
    const { hash, password1, password2, captchaToken } = request.body;

    const result = await resetPassword(
      hash,
      password1,
      password2,
      captchaToken
    );

    if (result.success) {
      reply.send(result);
    } else {
      const statusCode =
        result.error === 'missingRequiredFields' ||
        result.error === 'passwordsDoNotMatch' ||
        result.error === 'captchaVerificationFailed' ||
        result.error === 'invalidOrExpiredToken' ||
        result.error?.startsWith('password')
          ? 400
          : 500;
      reply.status(statusCode).send(result);
    }
  });

  // Password reset token check
  fastify.get(
    '/account/reset-password-check/:hash',
    async (request: any, reply: any) => {
      const { hash } = request.params;

      const result = await checkPasswordResetToken(hash);

      reply.send(result);
    }
  );

  // User overview (protected)
  fastify.get(
    '/account/overview',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const result = await account.getUserData(request.user.userId);

        if (result.success) {
          reply.send(result);
        } else {
          const statusCode = result.error === 'User not found' ? 404 : 500;
          reply.status(statusCode).send(result);
        }
      } catch (error) {
        reply.status(500).send({
          success: false,
          error: 'Internal server error',
        });
      }
    }
  );

  // Update voting portal (protected)
  fastify.put(
    '/account/voting-portal/:id',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const companyListId = parseInt(request.params.id);
        if (isNaN(companyListId)) {
          reply.status(400).send({
            success: false,
            error: 'Invalid company list ID',
          });
          return;
        }

        // Check if it's a multipart request (for image uploads)
        const contentType = request.headers['content-type'];
        if (contentType && contentType.includes('multipart/form-data')) {
          // Handle multipart data for image uploads
          const result = await account.updateCompanyListWithImages(
            request.user.userId,
            companyListId,
            request
          );

          if (result.success) {
            reply.send(result);
          } else {
            const statusCode =
              result.error === 'Access denied'
                ? 403
                : result.error === 'Company list not found'
                ? 404
                : 500;
            reply.status(statusCode).send(result);
          }
          return;
        }

        // Handle regular JSON data
        const result = await account.updateCompanyList(
          request.user.userId,
          companyListId,
          request.body
        );

        if (result.success) {
          reply.send(result);
        } else {
          const statusCode =
            result.error === 'Access denied'
              ? 403
              : result.error === 'Company list not found'
              ? 404
              : 500;
          reply.status(statusCode).send(result);
        }
      } catch (error) {
        reply.status(500).send({
          success: false,
          error: 'Internal server error',
        });
      }
    }
  );

  // Delete voting portal (protected)
  fastify.delete(
    '/account/voting-portal/:id',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const companyListId = parseInt(request.params.id);
        if (isNaN(companyListId)) {
          reply.status(400).send({
            success: false,
            error: 'Invalid company list ID',
          });
          return;
        }

        const result = await account.deleteCompanyList(
          request.user.userId,
          companyListId
        );

        if (result.success) {
          reply.send(result);
        } else {
          const statusCode =
            result.error === 'Access denied'
              ? 403
              : result.error === 'Company list not found'
              ? 404
              : 500;
          reply.status(statusCode).send(result);
        }
      } catch (error) {
        reply.status(500).send({
          success: false,
          error: 'Internal server error',
        });
      }
    }
  );

  // QRSong games activation code request
  fastify.post(
    '/api/account/games-request-activation',
    async (request: any, reply: any) => {
      const { email } = request.body;

      // Validate email
      if (!email || !email.includes('@')) {
        reply.status(400).send({
          success: false,
          error: 'invalidEmail',
        });
        return;
      }

      try {
        // Look for payments with this email
        const payment = await prisma.payment.findFirst({
          where: {
            email: email.toLowerCase(),
            status: 'paid',
          },
          include: {
            user: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

        if (!payment || !payment.user) {
          // Don't reveal whether email exists or not
          reply.send({
            success: true,
            message:
              'If this email is associated with a purchase, an activation code will be sent.',
          });
          return;
        }

        // Generate a 6-digit code
        const activationCode = Math.floor(
          100000 + Math.random() * 900000
        ).toString();

        // Store the code with user hash (expires in 1 hour)
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        // Update the user record with activation code
        await prisma.user.update({
          where: { id: payment.user.id },
          data: {
            gamesActivationCode: activationCode,
            gamesActivationCodeExpiry: expiresAt,
          },
        });

        // Get the user's preferred locale
        const locale = payment.locale || 'en';

        // Send activation email with user's hash and code
        await mail.sendQRSongActivationMail(
          email,
          payment.fullname || payment.user.displayName,
          payment.user.hash,
          locale,
          activationCode
        );

        reply.send({
          success: true,
          message:
            'If this email is associated with a purchase, an activation code will be sent.',
        });
      } catch (error) {
        reply.status(500).send({
          success: false,
          error: 'failedToSendActivationCode',
        });
      }
    }
  );

  // Validate games activation code
  fastify.post(
    '/api/account/games-validate-activation',
    async (request: any, reply: any) => {
      const { code } = request.body;
      const validationId = Math.random().toString(36).substring(7);
      const timestamp = new Date().toISOString();

      console.log(`[${validationId}] Activation validation request received at ${timestamp}`);
      console.log(`[${validationId}] Code provided: ${code?.substring(0, 3)}***`);

      if (!code || code.length !== 6) {
        console.log(`[${validationId}] Invalid code format - Code length: ${code?.length || 0}`);
        reply.status(400).send({
          success: false,
          error: 'invalidCode',
          message: 'Invalid activation code format',
          details: 'Activation code must be exactly 6 digits',
          providedLength: code?.length || 0,
          requiredLength: 6,
        });
        return;
      }

      try {
        console.log(`[${validationId}] Looking up activation code in database...`);

        // Find user with this activation code
        const user = await prisma.user.findFirst({
          where: {
            gamesActivationCode: code,
          },
        });

        if (!user) {
          console.log(`[${validationId}] Activation code not found in database`);
          reply.status(400).send({
            success: false,
            error: 'invalidCode',
            message: 'Invalid or non-existent activation code',
            details: 'The code you entered is incorrect or has already been used',
            suggestions: [
              'Double-check the 6-digit code from your email',
              'Request a new activation code if needed',
              'Ensure you entered all 6 digits correctly'
            ],
          });
          return;
        }

        console.log(`[${validationId}] Activation code found for user`);
        console.log(`[${validationId}] User details - Email: ${user.email?.substring(0, 3)}***, Hash: ${user.hash?.substring(0, 8)}...`);

        // Check if code is expired
        if (!user.gamesActivationCodeExpiry) {
          console.log(`[${validationId}] No expiry date found for activation code`);
          reply.status(400).send({
            success: false,
            error: 'invalidCode',
            message: 'Invalid activation code',
            details: 'This code is not valid',
          });
          return;
        }

        const expiryDate = new Date(user.gamesActivationCodeExpiry);
        const currentDate = new Date();
        const timeRemaining = expiryDate.getTime() - currentDate.getTime();

        if (timeRemaining <= 0) {
          console.log(`[${validationId}] Code expired - Expired at: ${user.gamesActivationCodeExpiry}, Current time: ${currentDate.toISOString()}`);
          console.log(`[${validationId}] Time since expiry: ${Math.abs(timeRemaining / 1000 / 60).toFixed(2)} minutes`);

          // Clear expired code
          await prisma.user.update({
            where: { id: user.id },
            data: {
              gamesActivationCode: null,
              gamesActivationCodeExpiry: null,
            },
          });

          console.log(`[${validationId}] Expired code cleared from user record`);

          reply.status(400).send({
            success: false,
            error: 'codeExpired',
            message: 'Activation code has expired',
            details: 'This code was valid for 1 hour after generation',
            expiredAt: user.gamesActivationCodeExpiry,
            expiredMinutesAgo: Math.floor(Math.abs(timeRemaining / 1000 / 60)),
            suggestion: 'Please request a new activation code',
          });
          return;
        }

        console.log(`[${validationId}] Code is valid - Time remaining: ${Math.floor(timeRemaining / 1000 / 60)} minutes`);
        console.log(`[${validationId}] Validation successful - Returning user hash`);

        // Clear the code after successful validation
        await prisma.user.update({
          where: { id: user.id },
          data: {
            gamesActivationCode: null,
            gamesActivationCodeExpiry: null,
          },
        });

        console.log(`[${validationId}] Activation code cleared after successful validation`);
        console.log(`[${validationId}] User ${user.hash?.substring(0, 8)}... successfully activated`);

        reply.send({
          success: true,
          userHash: user.hash,
          message: 'Activation successful',
          details: 'Your account has been activated and you can now access your purchased content',
          validationId,
          activatedAt: timestamp,
        });
      } catch (error) {
        console.error(`[${validationId}] Error during validation:`, error);
        console.error(`[${validationId}] Error type:`, (error as Error).name);
        console.error(`[${validationId}] Error message:`, (error as Error).message);
        console.error(`[${validationId}] Stack trace:`, (error as Error).stack);

        reply.status(500).send({
          success: false,
          error: 'validationFailed',
          message: 'An error occurred during validation',
          details: 'Please try again or contact support if the issue persists',
          validationId,
          timestamp,
        });
      }
    }
  );

  // ==========================================
  // CUSTOMER ACCOUNT ENDPOINTS
  // ==========================================

  // Customer registration request - send pincode to email if they have orders
  fastify.post(
    '/api/account/customer-register-request',
    async (request: any, reply: any) => {
      const { email, locale } = request.body;

      // Validate email
      if (!email || !email.includes('@')) {
        reply.status(400).send({
          success: false,
          error: 'invalidEmail',
        });
        return;
      }

      try {
        const normalizedEmail = email.toLowerCase().trim();

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

        // Always return success to prevent email enumeration
        if (!payment || !payment.user) {
          reply.send({
            success: true,
            message: 'customerPincodeEmailSent',
          });
          return;
        }

        // Check if user already has a password set (already registered)
        if (payment.user.password && payment.user.salt && payment.user.verified) {
          reply.status(400).send({
            success: false,
            error: 'accountAlreadyExists',
          });
          return;
        }

        // Generate a 6-digit pincode
        const pincode = Math.floor(100000 + Math.random() * 900000).toString();

        // Store the pincode with 15 minute expiry (reusing gamesActivationCode fields)
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await prisma.user.update({
          where: { id: payment.user.id },
          data: {
            gamesActivationCode: pincode,
            gamesActivationCodeExpiry: expiresAt,
          },
        });

        // Send pincode email
        const userLocale = locale || payment.locale || 'en';
        await mail.sendCustomerRegistrationPincode(
          normalizedEmail,
          payment.fullname || payment.user.displayName,
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

      // Check rate limit
      const rateLimitCheck = await rateLimiter.checkRateLimit(
        clientIp,
        normalizedEmail
      );
      if (!rateLimitCheck.allowed) {
        reply
          .status(429)
          .header('Retry-After', rateLimitCheck.retryAfter?.toString() || '1800')
          .send({
            success: false,
            error: 'tooManyAttempts',
            retryAfter: rateLimitCheck.retryAfter,
          });
        return;
      }

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
        const pincode = Math.floor(100000 + Math.random() * 900000).toString();

        // Store the pincode with 15 minute expiry (reusing gamesActivationCode fields)
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await prisma.user.update({
          where: { id: user.id },
          data: {
            gamesActivationCode: pincode,
            gamesActivationCodeExpiry: expiresAt,
          },
        });

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

      if (!email || !pincode || pincode.length !== 6) {
        reply.status(400).send({
          success: false,
          error: 'invalidPincode',
        });
        return;
      }

      try {
        const normalizedEmail = email.toLowerCase().trim();

        // Find user with this email and pincode
        const user = await prisma.user.findFirst({
          where: {
            email: normalizedEmail,
            gamesActivationCode: pincode,
          },
        });

        if (!user) {
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
        normalizedEmail
      );
      if (!rateLimitCheck.allowed) {
        reply
          .status(429)
          .header('Retry-After', rateLimitCheck.retryAfter?.toString() || '1800')
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
          await rateLimiter.recordFailedAttempt(clientIp, normalizedEmail);
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
          await rateLimiter.recordFailedAttempt(clientIp, normalizedEmail);
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
        await rateLimiter.recordSuccessfulLogin(clientIp, normalizedEmail);

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

        reply.send({
          success: true,
          user,
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

        // Get all paid orders for this user with their playlists
        const payments = await prisma.payment.findMany({
          where: {
            userId: user.id,
            status: 'paid',
          },
          include: {
            PaymentHasPlaylist: {
              include: {
                playlist: {
                  select: {
                    playlistId: true,
                    name: true,
                    image: true,
                  },
                },
                bingoFiles: {
                  orderBy: {
                    createdAt: 'desc',
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

        const apiUri = process.env['API_URI'] || 'http://localhost:3004';

        const purchases = payments.map((payment) => {
          // Determine if downloads are available
          // For digital orders: available when filenameDigital exists
          // For physical orders: available when sentToPrinter is true (they receive digital copy)
          const isPhysicalOrder = payment.PaymentHasPlaylist.some((php) => php.type === 'physical' || php.type === 'sheets');

          return {
            orderId: payment.orderId,
            paymentId: payment.paymentId,
            userHash: user.hash,
            createdAt: payment.createdAt,
            amount: payment.totalPrice,
            status: payment.status,
            type: payment.PaymentHasPlaylist.length > 0 ? payment.PaymentHasPlaylist[0].type : 'digital',
            // For physical orders, download is available after sentToPrinter
            // For digital orders, download is available when filenameDigital exists
            downloadAvailable: isPhysicalOrder
              ? payment.sentToPrinter === true
              : payment.PaymentHasPlaylist.some((php) => !!php.filenameDigital),
            playlists: payment.PaymentHasPlaylist.map((php) => ({
              paymentHasPlaylistId: php.id, // Needed for bingo upgrade payment
              playlistId: php.playlist.playlistId,
              name: php.playlist.name,
              image: php.playlist.image,
              numberOfTracks: php.numberOfTracks,
              type: php.type,
              // Individual playlist download availability
              canDownload: php.type === 'digital'
                ? !!php.filenameDigital
                : payment.sentToPrinter === true && !!php.filenameDigital,
              // Whether bingo is enabled for this playlist
              gamesEnabled: php.gamesEnabled,
              // Bingo files for this playlist
              bingoFiles: php.bingoFiles.map((bf: any) => ({
                filename: bf.filename,
                contestants: bf.contestants,
                rounds: bf.rounds,
                trackCount: bf.trackCount,
                createdAt: bf.createdAt,
                downloadUrl: `${apiUri}/public/bingo/${bf.filename}`,
              })),
            })),
          };
        });

        reply.send({
          success: true,
          purchases,
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
