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

const prisma = new PrismaClient();

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

  // QRSong activation code request
  fastify.post(
    '/api/account/request-activation',
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
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const codeData = JSON.stringify({
          userHash: payment.user.hash,
          email: email.toLowerCase(),
          expiresAt,
        });

        // Store in AppSetting with a unique key
        const codeKey = `activation_code_${activationCode}`;

        await prisma.appSetting.upsert({
          where: { key: codeKey },
          update: { value: codeData },
          create: { key: codeKey, value: codeData },
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

  // Validate activation code
  fastify.post(
    '/api/account/validate-activation',
    async (request: any, reply: any) => {
      const { code } = request.body;

      if (!code || code.length !== 6) {
        reply.status(400).send({
          success: false,
          error: 'invalidCode',
        });
        return;
      }

      try {
        const codeKey = `activation_code_${code}`;
        const setting = await prisma.appSetting.findUnique({
          where: { key: codeKey },
        });

        if (!setting) {
          reply.status(400).send({
            success: false,
            error: 'invalidCode',
          });
          return;
        }

        const codeData = JSON.parse(setting.value);

        // Check if code is expired
        if (new Date(codeData.expiresAt) < new Date()) {
          // Delete expired code
          await prisma.appSetting.delete({
            where: { key: codeKey },
          });

          reply.status(400).send({
            success: false,
            error: 'codeExpired',
          });
          return;
        }

        // Delete the code after successful validation
        await prisma.appSetting.delete({
          where: { key: codeKey },
        });

        reply.send({
          success: true,
          userHash: codeData.userHash,
        });
      } catch (error) {
        reply.status(500).send({
          success: false,
          error: 'validationFailed',
        });
      }
    }
  );
}
