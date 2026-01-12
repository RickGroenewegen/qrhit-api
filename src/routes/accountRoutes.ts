import { FastifyInstance } from 'fastify';
import {
  registerAccount,
  verifyUser,
  initiatePasswordReset,
  resetPassword,
  checkPasswordResetToken,
  authenticateUser,
} from '../auth';
import Account from '../account';
import Mail from '../mail';
import { PrismaClient } from '@prisma/client';
import PrismaInstance from '../prisma';

const prisma = PrismaInstance.getInstance();

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

    // First try DB authentication
    const authResult = await authenticateUser(loginEmail, password);

    if (authResult) {
      reply.send({
        token: authResult.token,
        userId: authResult.userId,
        userGroups: authResult.userGroups,
        companyId: authResult.companyId,
      });
      return;
    } else {
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

    if (result.success) {
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
}
