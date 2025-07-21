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

export default async function accountRoutes(
  fastify: FastifyInstance,
  verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const account = Account.getInstance();

  // User login/validation
  fastify.post('/validate', async (request: any, reply: any) => {
    const { email, password } = request.body as {
      email: string;
      password: string;
    };

    console.log(111, email, password);

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
        console.error('Error in /account/overview route:', error);
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
        console.error('Error in /account/voting-portal PUT route:', error);
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
        console.error('Error in /account/voting-portal DELETE route:', error);
        reply.status(500).send({
          success: false,
          error: 'Internal server error',
        });
      }
    }
  );
}
