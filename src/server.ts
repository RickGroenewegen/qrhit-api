import { FastifyInstance } from 'fastify/types/instance';
import blogRoutes from '../routes/blogRoutes';
import {
  generateToken,
  verifyToken,
  authenticateUser,
  createOrUpdateAdminUser,
  deleteUserById,
  registerAccount,
  verifyUser,
  initiatePasswordReset,
  resetPassword,
} from './auth';
import Fastify from 'fastify';
import replyFrom from '@fastify/reply-from';
import { OrderSearch } from './interfaces/OrderSearch';
import Logger from './logger';
import { color } from 'console-log-colors';
import cluster from 'cluster';
import os from 'os';
import Utils from './utils';
import Spotify from './spotify';
import Mollie from './mollie';
import Qr from './qr';
import path from 'path';
import view from '@fastify/view';
import ejs from 'ejs';
import Data from './data';
import fs from 'fs/promises';
import Order from './order';
import Mail from './mail';
import ipPlugin from './plugins/ipPlugin';
import Formatters from './formatters';
import Translation from './translation';
import Cache from './cache';
import Generator from './generator';
import AnalyticsClient from './analytics';
import { ChatGPT } from './chatgpt';
import Discount from './discount';
import GitChecker from './git';
import { OpenPerplex } from './openperplex';
import Push from './push';
import Review from './review';
import Trustpilot from './trustpilot';
import { Music } from './music';
import Suggestion from './suggestion';
import Designer from './designer';
import Hitlist from './hitlist';
import Vibe from './vibe';
import AudioClient from './audio'; // Import AudioClient
import PrinterInvoiceService from './printerinvoice';
import Account from './account';

interface QueryParameters {
  [key: string]: string | string[];
}

declare module 'fastify' {
  export interface FastifyInstance {
    authenticate: any;
  }
}

class Server {
  private static instance: Server;
  private fastify: FastifyInstance;
  private logger = new Logger();
  private port = 3004;
  private workerId: number = 0;
  private isMainServer: boolean = false;
  private utils = new Utils();
  private spotify = Spotify.getInstance();
  private mollie = new Mollie();
  private qr = new Qr();
  private data = Data.getInstance();
  private order = Order.getInstance();
  private mail = Mail.getInstance();
  private formatters = new Formatters().getFormatters();
  private translation: Translation = new Translation();
  private cache = Cache.getInstance();
  private generator = Generator.getInstance();
  private analytics = AnalyticsClient.getInstance();
  private openai = new ChatGPT();
  private discount = new Discount();
  private openperplex = new OpenPerplex();
  private push = Push.getInstance();
  private review = Review.getInstance();
  private trustpilot = Trustpilot.getInstance();
  private music = new Music();
  private suggestion = Suggestion.getInstance();
  private designer = Designer.getInstance();
  private hitlist = Hitlist.getInstance();
  private vibe = Vibe.getInstance();
  private printerInvoice = PrinterInvoiceService.getInstance();
  private audio = AudioClient.getInstance(); // Instantiate AudioClient
  private account = Account.getInstance();
  private whiteLabels = [
    {
      domain: 'k7.com',
      template: 'k7',
    },
  ];
  private useSpotifyRemote: boolean = true;

  private version: string = '1.0.0';

  private constructor() {
    this.fastify = Fastify({
      logger: false,
      bodyLimit: 1024 * 1024 * 100, // 100 MB, adjust as needed
    });
  }

  // Static method to get the instance of the class
  public static getInstance(): Server {
    if (!Server.instance) {
      Server.instance = new Server();
    }
    return Server.instance;
  }

  private addAuthRoutes = async () => {
    // Middleware for token verification
    const verifyTokenMiddleware = async (
      request: any,
      reply: any,
      allowedGroups: string[] = []
    ) => {
      const token = request.headers.authorization?.split(' ')[1];
      const decoded = verifyToken(token || '');

      if (!decoded) {
        reply.status(401).send({ error: 'Unauthorized' });
        return false;
      }

      // Attach decoded token to request for later use
      request.user = decoded;

      // Check if user has any of the allowed groups
      if (allowedGroups.length > 0) {
        const userGroups = decoded.userGroups || [];
        const hasAllowedGroup = userGroups.some((group: string) =>
          allowedGroups.includes(group)
        );

        if (!hasAllowedGroup) {
          reply
            .status(403)
            .send({ error: 'Forbidden: Insufficient permissions' });
          return false;
        }
      }

      return true;
    };

    const getAuthHandler = (allowedGroups: string[]) => {
      return {
        // Conditionally apply preHandler based on environment
        preHandler: (request: any, reply: any) =>
          verifyTokenMiddleware(request, reply, allowedGroups),
      };
    };

    this.fastify.post(
      '/create_order',
      getAuthHandler(['admin']),
      async (request: any, _reply) => {
        return await this.generator.sendToPrinter(
          request.body.paymentId,
          request.clientIp
        );
      }
    );

    this.fastify.get(
      '/vibe/companies',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        try {
          // Use the Vibe class to get all companies
          const result = await this.vibe.getAllCompanies();

          if (!result.success) {
            reply.status(500).send({ error: result.error });
            return;
          }

          // Return the list of companies
          reply.send(result.data);
        } catch (error) {
          console.error('Error retrieving all companies:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    this.fastify.put(
      '/vibe/companies/:companyId/lists/:listId',
      getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
      async (request: any, reply: any) => {
        try {
          const companyId = parseInt(request.params.companyId);
          const listId = parseInt(request.params.listId);

          if (isNaN(companyId) || isNaN(listId)) {
            reply.status(400).send({ error: 'Invalid company or list ID' });
            return;
          }

          // If user is companyadmin, only allow editing their own company
          if (
            request.user.userGroups.includes('companyadmin') &&
            request.user.companyId !== companyId
          ) {
            reply
              .status(403)
              .send({ error: 'Forbidden: You can only edit your own company' });
            return;
          }

          // Pass the request object to the Vibe class to handle multipart data
          const result = await this.vibe.updateCompanyList(
            companyId,
            listId,
            request // Pass the full request object
          );

          if (!result || !result.success) {
            let statusCode = 500;
            if (result.error === 'Company list not found') {
              statusCode = 404;
            } else if (
              result.error === 'List does not belong to this company'
            ) {
              statusCode = 403; // Forbidden
            }
            reply.status(statusCode).send({ error: result.error });
            return;
          }

          // Return the updated list
          reply.send(result.data);
        } catch (error) {
          console.error('Error updating company list:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    // Protected route to get all users for a specific company
    this.fastify.get(
      '/vibe/users/:companyId',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        try {
          const companyId = parseInt(request.params.companyId);

          if (isNaN(companyId)) {
            reply.status(400).send({ error: 'Invalid company ID' });
            return;
          }

          const result = await this.vibe.getUsersByCompany(companyId);

          if (!result.success) {
            let statusCode = 500;
            if (result.error === 'Company not found') {
              statusCode = 404;
            }
            reply.status(statusCode).send({ error: result.error });
            return;
          }

          reply.send({ success: true, users: result.users });
        } catch (error) {
          console.error('Error retrieving users for company:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    this.fastify.put(
      '/vibe/companies/:companyId',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        const companyId = parseInt(request.params.companyId);
        const { name, test } = request.body;

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }
        if (!name) {
          reply.status(400).send({ error: 'Missing required field: name' });
          return;
        }

        const result = await this.vibe.updateCompany(companyId, { name, test });

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Company not found') {
            statusCode = 404;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send({ success: true, company: result.data.company });
      }
    );

    this.fastify.delete(
      '/vibe/companies/:companyId',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        try {
          const companyId = parseInt(request.params.companyId);

          if (isNaN(companyId)) {
            reply.status(400).send({ error: 'Invalid company ID' });
            return;
          }

          // Use the Vibe class to delete the company
          const result = await this.vibe.deleteCompany(companyId);

          if (!result.success) {
            let statusCode = 500;
            if (result.error === 'Company not found') {
              statusCode = 404;
            } else if (
              result.error ===
              'Company cannot be deleted because it has associated lists'
            ) {
              statusCode = 409; // Conflict
            }
            reply.status(statusCode).send({ error: result.error });
            return;
          }

          // Return success
          reply.send({ success: true });
        } catch (error) {
          console.error('Error deleting company:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    // Route to replace trackId in CompanyListSubmissionTrack for a given list
    this.fastify.post(
      '/vibe/lists/:companyListId/replace-track',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        try {
          const companyListId = parseInt(request.params.companyListId);
          const { sourceTrackId, destinationTrackId } = request.body;

          if (
            isNaN(companyListId) ||
            !sourceTrackId ||
            !destinationTrackId ||
            isNaN(Number(sourceTrackId)) ||
            isNaN(Number(destinationTrackId))
          ) {
            reply.status(400).send({ error: 'Invalid parameters' });
            return;
          }

          const result = await this.vibe.replaceTrackInSubmissions(
            companyListId,
            Number(sourceTrackId),
            Number(destinationTrackId)
          );

          if (!result.success) {
            reply.status(500).send({ error: result.error });
            return;
          }

          reply.send({ success: true, updatedCount: result.updatedCount });
        } catch (error) {
          console.error('Error replacing track in submissions:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    // Route to delete a submission by its ID
    this.fastify.delete(
      '/vibe/submissions/:submissionId',
      getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
      async (request: any, reply: any) => {
        try {
          const submissionId = parseInt(request.params.submissionId);

          if (isNaN(submissionId)) {
            reply.status(400).send({ error: 'Invalid submission ID' });
            return;
          }

          // If user is companyadmin, check that the submission belongs to their company
          if (request.user.userGroups.includes('companyadmin')) {
            const belongs = await this.vibe.submissionBelongsToCompany(
              submissionId,
              request.user.companyId
            );
            if (!belongs) {
              reply.status(403).send({
                error: 'Forbidden: Submission does not belong to your company',
              });
              return;
            }
          }

          const result = await this.vibe.deleteSubmission(submissionId);

          if (!result.success) {
            let statusCode = 500;
            if (result.error === 'Submission not found') {
              statusCode = 404;
            }
            reply.status(statusCode).send({ error: result.error });
            return;
          }

          reply.send({ success: true });
        } catch (error) {
          console.error('Error deleting submission:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    this.fastify.post(
      '/vibe/companies/:companyId/lists',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        try {
          const companyId = parseInt(request.params.companyId);
          // Extract all expected fields from the body
          const {
            name,
            description,
            slug,
            numberOfCards,
            numberOfTracks,
            playlistSource,
            playlistUrl,
          } = request.body;

          if (request.user.userGroups.includes('companyadmin')) {
            reply.status(403).send({
              error: 'Forbidden',
            });
            return;
          }

          if (isNaN(companyId)) {
            reply.status(400).send({ error: 'Invalid company ID' });
            return;
          }

          // Basic body validation
          if (
            !name ||
            !description ||
            !slug ||
            numberOfCards === undefined ||
            numberOfTracks === undefined
          ) {
            reply.status(400).send({
              error:
                'Missing required fields: name, description, slug, numberOfCards, numberOfTracks',
            });
            return;
          }

          const listData = {
            name,
            description,
            slug,
            numberOfCards: parseInt(numberOfCards), // Ensure numbers are parsed
            numberOfTracks: parseInt(numberOfTracks),
            playlistSource, // Pass playlistSource
            playlistUrl, // Pass playlistUrl
          };

          // Use the Vibe class to create the list
          const result = await this.vibe.createCompanyList(companyId, listData);

          if (!result.success) {
            let statusCode = 500;
            if (result.error === 'Bedrijf niet gevonden') {
              statusCode = 404;
            } else if (
              result.error === 'Slug bestaat al. Kies een unieke slug.'
            ) {
              statusCode = 409; // Conflict
            } else if (
              result.error === 'Ongeldig bedrijfs-ID opgegeven' ||
              result.error ===
                'Verplichte velden voor de bedrijfslijst ontbreken' ||
              result.error === 'Ongeldig aantal voor kaarten of nummers'
            ) {
              statusCode = 400; // Bad Request
            }
            reply.status(statusCode).send({ error: result.error });
            return;
          }

          // Return the newly created list with 201 Created status
          // Construct response data including the listId and the list object
          const responseData = {
            listId: result.data.list.id, // Extract the ID
            list: result.data.list, // Include the full list object
          };
          reply.status(201).send(responseData);
        } catch (error) {
          console.error('Error creating company list:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    this.fastify.delete(
      '/vibe/companies/:companyId/lists/:listId',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        try {
          const companyId = parseInt(request.params.companyId);
          const listId = parseInt(request.params.listId);

          if (isNaN(companyId) || isNaN(listId)) {
            reply.status(400).send({ error: 'Invalid company or list ID' });
            return;
          }

          if (request.user.userGroups.includes('companyadmin')) {
            reply.status(403).send({
              error: 'Forbidden',
            });
            return;
          }

          // Use the Vibe class to delete the list
          const result = await this.vibe.deleteCompanyList(companyId, listId);

          if (!result.success) {
            let statusCode = 500;
            if (result.error === 'Company list not found') {
              statusCode = 404;
            } else if (
              result.error === 'List does not belong to this company'
            ) {
              statusCode = 403; // Forbidden
            } else if (result.error.includes('status is not "new"')) {
              statusCode = 409; // Conflict
            }
            reply.status(statusCode).send({ error: result.error });
            return;
          }

          // Return success
          reply.send({ success: true });
        } catch (error) {
          console.error('Error deleting company list:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    this.fastify.post(
      '/vibe/companies',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        try {
          const { name, test } = request.body;

          if (!name) {
            reply.status(400).send({ error: 'Missing required field: name' });
            return;
          }

          // Use the Vibe class to create the company, pass test property if present
          const result = await this.vibe.createCompany(name, test);

          if (!result.success) {
            // Use 409 Conflict if company already exists, otherwise 500
            const statusCode =
              result.error === 'Company with this name already exists'
                ? 409
                : 500;
            reply.status(statusCode).send({ error: result.error });
            return;
          }

          // Return the newly created company with 201 Created status
          reply.status(201).send(result.data);
        } catch (error) {
          console.error('Error creating company:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    // API endpoint for finalizing a company list (creating a top 10)
    this.fastify.post(
      '/vibe/finalize',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply) => {
        const { companyListId } = request.body;

        if (!companyListId) {
          return { success: false, error: 'Missing company list ID' };
        }

        return await this.vibe.finalizeList(parseInt(companyListId));
      }
    );

    this.fastify.post(
      '/admin/create',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        const { email, password, displayName, companyId, userGroup, id } =
          request.body;

        if (!email || !displayName) {
          reply.status(400).send({ error: 'Missing required fields' });
          return;
        }

        try {
          const user = await createOrUpdateAdminUser(
            email,
            password,
            displayName,
            companyId,
            userGroup,
            id,
            request.user?.userGroups // Pass current user's groups for permission check
          );
          reply.send({
            success: true,
            message: 'User created/updated successfully',
            userId: user.userId,
          });
        } catch (error) {
          console.error('Error creating admin user:', error);
          reply.status(500).send({ error: 'Failed to create admin user' });
        }
      }
    );

    // Protected admin route to delete a user by id
    this.fastify.delete(
      '/admin/user/:id',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const id = parseInt(request.params.id);
        if (isNaN(id)) {
          reply.status(400).send({ success: false, error: 'Invalid user id' });
          return;
        }
        const result = await deleteUserById(id);
        if (result.success) {
          reply.send({ success: true });
        } else {
          reply.status(500).send({ success: false, error: result.error });
        }
      }
    );

    this.fastify.post('/validate', async (request: any, reply: any) => {
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

    this.fastify.post('/account/register', async (request: any, reply: any) => {
      const { displayName, email, password1, password2, captchaToken, locale } = request.body;

      const result = await registerAccount(displayName, email, password1, password2, captchaToken, locale);

      if (result.success) {
        reply.send(result);
      } else {
        const statusCode = result.error === 'accountAlreadyExists' ? 409 : 400;
        reply.status(statusCode).send(result);
      }
    });

    this.fastify.post('/account/verify', async (request: any, reply: any) => {
      const { verificationHash } = request.body;

      const result = await verifyUser(verificationHash);

      if (result.success) {
        reply.send(result);
      } else {
        const statusCode = result.error === 'invalidHash' || result.error === 'alreadyVerified' ? 400 : 500;
        reply.status(statusCode).send(result);
      }
    });

    this.fastify.post('/account/reset-password-request', async (request: any, reply: any) => {
      const { email, captchaToken } = request.body;

      const result = await initiatePasswordReset(email, captchaToken);

      if (result.success) {
        reply.send(result);
      } else {
        const statusCode = result.error === 'missingRequiredFields' || result.error === 'invalidEmailFormat' || result.error === 'captchaVerificationFailed' ? 400 : 500;
        reply.status(statusCode).send(result);
      }
    });

    this.fastify.post('/account/reset-password', async (request: any, reply: any) => {
      const { hash, password1, password2, captchaToken } = request.body;

      const result = await resetPassword(hash, password1, password2, captchaToken);

      if (result.success) {
        reply.send(result);
      } else {
        const statusCode = result.error === 'missingRequiredFields' || result.error === 'passwordsDoNotMatch' || result.error === 'captchaVerificationFailed' || result.error === 'invalidOrExpiredToken' || result.error?.startsWith('password') ? 400 : 500;
        reply.status(statusCode).send(result);
      }
    });

    this.fastify.get(
      '/account/overview',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const result = await this.account.getUserData(request.user.userId);

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
            error: 'Internal server error' 
          });
        }
      }
    );

    this.fastify.get(
      '/verify/:paymentId',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        this.data.verifyPayment(request.params.paymentId);
        reply.send({ success: true });
      }
    );

    this.fastify.post(
      '/openperplex',
      getAuthHandler(['admin']),
      async (request: any, _reply) => {
        const year = await this.openperplex.ask(
          request.body.artist,
          request.body.title
        );
        return { success: true, year };
      }
    );

    this.fastify.get('/spotify/auth-url', async (_request, reply) => {
      const authUrl = this.spotify.getAuthorizationUrl();
      console.log(111, authUrl);
      reply.send({ success: true });
    });

    this.fastify.get(
      '/reviews/:locale/:amount/:landingPage',
      async (request: any, _reply) => {
        const amount = parseInt(request.params.amount) || 0;
        return await this.trustpilot.getReviews(
          true,
          amount,
          request.params.locale,
          this.utils.parseBoolean(request.params.landingPage)
        );
      }
    );

    this.fastify.get('/reviews_details', async (_request: any, _reply) => {
      return await this.trustpilot.getCompanyDetails();
    });

    this.fastify.get('/review/:paymentId', async (request: any, _reply) => {
      return await this.review.checkReview(request.params.paymentId);
    });

    this.fastify.post('/review/:paymentId', async (request: any, _reply) => {
      const { rating, review } = request.body;
      return await this.review.createReview(
        request.params.paymentId,
        rating,
        review
      );
    });

    this.fastify.get(
      '/lastplays',
      getAuthHandler(['admin']),
      async (_request: any, reply: any) => {
        const lastPlays = await this.data.getLastPlays();
        reply.send({ success: true, data: lastPlays });
      }
    );

    this.fastify.post(
      '/push/broadcast',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const { title, message, test, dry } = request.body;
        await this.push.broadcastNotification(
          title,
          message,
          this.utils.parseBoolean(test),
          this.utils.parseBoolean(dry)
        );
        reply.send({ success: true });
      }
    );

    this.fastify.get(
      '/push/messages',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        return await this.push.getMessages();
      }
    );

    this.fastify.get(
      '/regenerate/:paymentId/:email',
      getAuthHandler(['admin']),
      async (request: any, _reply) => {
        await this.mollie.clearPDFs(request.params.paymentId);
        this.generator.generate(
          request.params.paymentId,
          request.clientIp,
          '',
          this.mollie,
          true, // Force finalize
          !this.utils.parseBoolean(request.params.email) // Skip main mail
        );
        return { success: true };
      }
    );

    this.fastify.post(
      '/orders',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const search = {
          ...request.body,
          page: request.body.page || 1,
          itemsPerPage: request.body.itemsPerPage || 10,
        };

        const { payments, totalItems } = await this.mollie.getPaymentList(
          search
        );

        reply.send({
          data: payments,
          totalItems,
          currentPage: search.page,
          itemsPerPage: search.itemsPerPage,
        });
      }
    );

    this.fastify.post(
      '/discount/:code/:digital',
      async (request: any, reply: any) => {
        const result = await this.discount.checkDiscount(
          request.params.code,
          request.body.token,
          this.utils.parseBoolean(request.params.digital)
        );
        reply.send(result);
      }
    );

    // Protected admin route to create a discount code
    this.fastify.post(
      '/admin/discount/create',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const result = await this.discount.createAdminDiscountCode(
          request.body
        );
        if (result.success) {
          reply.send({ success: true, code: result.code });
        } else {
          reply.status(400).send({ success: false, error: result.error });
        }
      }
    );

    // Protected admin route to get all discount codes
    this.fastify.get(
      '/admin/discount/all',
      getAuthHandler(['admin']),
      async (_request: any, reply: any) => {
        const result = await this.discount.getAllDiscounts();
        if (result.success) {
          reply.send({ success: true, discounts: result.discounts });
        } else {
          reply.status(500).send({ success: false, error: result.error });
        }
      }
    );

    // Admin route: Get all PrinterInvoices
    this.fastify.get(
      '/admin/printerinvoices',
      getAuthHandler(['admin']),
      async (_request: any, reply: any) => {
        try {
          const invoices = await this.printerInvoice.getAllPrinterInvoices();
          reply.send({ success: true, invoices });
        } catch (error) {
          reply.status(500).send({
            success: false,
            error: 'Failed to fetch printer invoices',
          });
        }
      }
    );

    // Admin route: Create a new PrinterInvoice
    this.fastify.post(
      '/admin/printerinvoices',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const {
          invoiceNumber,
          description,
          totalPriceExclVat,
          totalPriceInclVat,
        } = request.body;
        if (
          !invoiceNumber ||
          typeof invoiceNumber !== 'string' ||
          typeof description !== 'string' ||
          typeof totalPriceExclVat !== 'number' ||
          typeof totalPriceInclVat !== 'number'
        ) {
          reply
            .status(400)
            .send({ success: false, error: 'Invalid or missing fields' });
          return;
        }
        try {
          const result = await this.printerInvoice.createPrinterInvoice({
            invoiceNumber,
            description,
            totalPriceExclVat,
            totalPriceInclVat,
          });
          if (result.success) {
            reply.send({ success: true, invoice: result.invoice });
          } else {
            reply.status(400).send({ success: false, error: result.error });
          }
        } catch (error) {
          reply.status(500).send({
            success: false,
            error: 'Failed to create printer invoice',
          });
        }
      }
    );

    // Admin route: Update a PrinterInvoice
    this.fastify.put(
      '/admin/printerinvoices/:id',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const id = parseInt(request.params.id);
        if (isNaN(id)) {
          reply.status(400).send({ success: false, error: 'Invalid id' });
          return;
        }
        const {
          invoiceNumber,
          description,
          totalPriceExclVat,
          totalPriceInclVat,
        } = request.body;
        const result = await this.printerInvoice.updatePrinterInvoice(id, {
          invoiceNumber,
          description,
          totalPriceExclVat,
          totalPriceInclVat,
        });
        if (result.success) {
          reply.send({ success: true, invoice: result.invoice });
        } else {
          reply.status(400).send({ success: false, error: result.error });
        }
      }
    );

    // Admin route: Process a PrinterInvoice (custom logic to be implemented)
    this.fastify.post(
      '/admin/printerinvoices/:id/process',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const id = parseInt(request.params.id);
        if (isNaN(id)) {
          reply.status(400).send({ success: false, error: 'Invalid id' });
          return;
        }
        // Call the processInvoiceData method and output the body for now
        const result = await this.printerInvoice.processInvoiceData(
          id,
          request.body
        );
        reply.send(result);
      }
    );

    // Admin route: Delete a PrinterInvoice (only if no payments refer to it)
    this.fastify.delete(
      '/admin/printerinvoices/:id',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const id = parseInt(request.params.id);
        if (isNaN(id)) {
          reply.status(400).send({ success: false, error: 'Invalid id' });
          return;
        }
        const result = await this.printerInvoice.deletePrinterInvoice(id);
        if (result.success) {
          reply.send({ success: true });
        } else {
          reply.status(400).send({ success: false, error: result.error });
        }
      }
    );

    // Protected admin route to update all payments with printApiOrderId
    this.fastify.post(
      '/admin/printenbind/update-payments',
      getAuthHandler(['admin']),
      async (_request: any, reply: any) => {
        const PrintEnBind = (await import('./printers/printenbind')).default;
        const printEnBind = PrintEnBind.getInstance();
        printEnBind.updateAllPaymentsWithPrintApiOrderId();
        reply.send({
          success: true,
          message: 'Updated all payments with printApiOrderId',
        });
      }
    );

    // Protected admin route to delete a discount code by id
    this.fastify.delete(
      '/admin/discount/:id',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const id = parseInt(request.params.id);
        if (isNaN(id)) {
          reply.status(400).send({ success: false, error: 'Invalid id' });
          return;
        }
        const result = await this.discount.deleteDiscountCode(id);
        if (result.success) {
          reply.send({ success: true });
        } else {
          reply.status(500).send({ success: false, error: result.error });
        }
      }
    );

    // Protected admin route to update a discount code by id
    this.fastify.put(
      '/admin/discount/:id',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const id = parseInt(request.params.id);
        if (isNaN(id)) {
          reply.status(400).send({ success: false, error: 'Invalid id' });
          return;
        }
        const result = await this.discount.updateDiscountCode(id, request.body);
        if (result.success) {
          reply.send({ success: true, code: result.code });
        } else {
          reply.status(400).send({ success: false, error: result.error });
        }
      }
    );

    this.fastify.post('/push/register', async (request: any, reply: any) => {
      const { token, type } = request.body;
      if (!token || !type) {
        reply.status(400).send({ error: 'Invalid request' });
        return;
      }

      await this.push.addToken(token, type);
      reply.send({ success: true });
    });

    this.fastify.get(
      '/analytics',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const analytics = await this.analytics.getAllCounters();
        reply.send({ success: true, data: analytics });
      }
    );

    this.fastify.post(
      '/tracks/search',
      getAuthHandler(['admin']),
      async (request: any, _reply) => {
        const { searchTerm = '', missingYouTubeLink } = request.body;
        const tracks = await this.data.searchTracks(
          searchTerm,
          this.utils.parseBoolean(missingYouTubeLink)
        );
        return { success: true, data: tracks };
      }
    );

    this.fastify.post(
      '/tracks/update',
      getAuthHandler(['admin']),
      async (request: any, _reply) => {
        const { id, artist, name, year, spotifyLink, youtubeLink } =
          request.body;

        if (!id || !artist || !name || !year || !spotifyLink || !youtubeLink) {
          return { success: false, error: 'Missing required fields' };
        }
        const success = await this.data.updateTrack(
          id,
          artist,
          name,
          year,
          spotifyLink,
          youtubeLink,
          request.clientIp
        );
        return { success };
      }
    );

    this.fastify.get(
      '/yearcheck',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const result = await this.data.getFirstUncheckedTrack();
        reply.send({
          success: true,
          track: result.track,
          totalUnchecked: result.totalUnchecked,
        });
      }
    );

    this.fastify.post(
      '/yearcheck',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const result = await this.data.updateTrackCheck(
          request.body.trackId,
          request.body.year
        );
        if (result.success && result.checkedPaymentIds!.length > 0) {
          for (const paymentId of result.checkedPaymentIds!) {
            this.generator.finalizeOrder(paymentId, this.mollie);
          }
        }
        reply.send({ success: true });
      }
    );

    this.fastify.get(
      '/check_unfinalized',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        this.data.checkUnfinalizedPayments();
        reply.send({ success: true });
      }
    );

    this.fastify.get(
      '/month_report/:yearMonth',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const { yearMonth } = request.params;
        const year = parseInt(yearMonth.substring(0, 4));
        const month = parseInt(yearMonth.substring(4, 6));

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);

        const report = await this.mollie.getPaymentsByMonth(startDate, endDate);

        reply.send({
          success: true,
          data: report,
        });
      }
    );

    this.fastify.get(
      '/add_spotify',
      getAuthHandler(['admin']),
      async (_request: any, reply) => {
        const result = this.data.addSpotifyLinks();
        return { success: true, processed: result };
      }
    );

    this.fastify.get(
      '/tax_report/:yearMonth',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const { yearMonth } = request.params;
        const year = parseInt(yearMonth.substring(0, 4));
        const month = parseInt(yearMonth.substring(4, 6));

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);

        const report = await this.mollie.getPaymentsByTaxRate(
          startDate,
          endDate
        );

        reply.send({
          success: true,
          data: report,
        });
      }
    );

    this.fastify.get(
      '/day_report',
      getAuthHandler(['admin']),
      async (_request: any, reply: any) => {
        const report = await this.mollie.getPaymentsByDay();
        reply.send({
          success: true,
          data: report,
        });
      }
    );

    this.fastify.get(
      '/corrections',
      getAuthHandler(['admin']),
      async (_request: any, reply) => {
        const corrections = await this.suggestion.getCorrections();
        return { success: true, data: corrections };
      }
    );

    this.fastify.post(
      '/correction/:paymentId/:userHash/:playlistId/:andSend',
      getAuthHandler(['admin']),
      async (request: any, reply) => {
        const { artistOnlyForMe, titleOnlyForMe, yearOnlyForMe } = request.body;
        this.suggestion.processCorrections(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId,
          artistOnlyForMe,
          titleOnlyForMe,
          yearOnlyForMe,
          this.utils.parseBoolean(request.params.andSend),
          request.clientIp
        );
        return { success: true };
      }
    );

    this.fastify.post(
      '/finalize',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        this.generator.finalizeOrder(request.body.paymentId, this.mollie);
        reply.send({ success: true });
      }
    );

    this.fastify.get(
      '/vibe/state/:listId',
      getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
      async (request: any, reply: any) => {
        try {
          // Get the token from the request
          const token = request.headers.authorization?.split(' ')[1];
          const decoded = verifyToken(token || '');
          const listId = parseInt(request.params.listId);

          // Use the Vibe class to get the state
          const result = await this.vibe.getState(listId);

          if (!result.success) {
            reply.status(404).send({ error: result.error });
            return;
          }

          // Return the state object
          reply.send(result.data);
        } catch (error) {
          console.error('Error retrieving company state:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    this.fastify.get(
      '/vibe/company/:companyId',
      getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
      async (request: any, reply: any) => {
        if (
          request.user.userGroups.includes('companyadmin') &&
          request.user.companyId !== parseInt(request.params.companyId)
        ) {
          reply
            .status(403)
            .send({ error: 'Forbidden: Access to this company is restricted' });
          return;
        }

        try {
          // Use the Vibe class to get company lists
          const result = await this.vibe.getCompanyLists(
            parseInt(request.params.companyId)
          );

          if (!result.success) {
            reply.status(404).send({ error: result.error });
            return;
          }

          // Return the company lists
          reply.send(result.data);
        } catch (error) {
          console.error('Error retrieving company lists:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    this.fastify.post(
      '/vibe/generate/:listId',
      getAuthHandler(['admin', 'vibeadmin']),
      async (request: any, reply: any) => {
        try {
          const listId = parseInt(request.params.listId);

          if (isNaN(listId)) {
            reply.status(400).send({ error: 'Invalid list ID' });
            return;
          }

          // Call the generatePDF method from the Vibe instance
          // Note: The current generatePDF method in vibe.ts doesn't seem to do much yet.
          // We'll call it and return a success message for now.
          const result = await this.vibe.generatePDF(
            listId,
            this.mollie,
            request.clientIp
          );

          // Assuming generatePDF will eventually return success/failure or data
          // For now, just send a success response if no error occurs
          reply.send({
            success: true,
            message: 'PDF generation initiated (placeholder)',
          });
        } catch (error) {
          console.error('Error calling generatePDF:', error);
          reply
            .status(500)
            .send({ error: 'Internal server error during PDF generation' });
        }
      }
    );

    // Protected route to update a list submission (currently only cardName is editable)
    this.fastify.put(
      '/vibe/submissions/:submissionId',
      getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
      async (request: any, reply: any) => {
        try {
          const submissionId = parseInt(request.params.submissionId);
          if (isNaN(submissionId)) {
            reply.status(400).send({ error: 'Invalid submission ID' });
            return;
          }
          const { cardName } = request.body;
          if (typeof cardName !== 'string' || cardName.trim() === '') {
            reply.status(400).send({
              error: 'cardName is required and must be a non-empty string',
            });
            return;
          }

          // If user is companyadmin, check that the submission belongs to their company
          if (request.user.userGroups.includes('companyadmin')) {
            const belongs = await this.vibe.submissionBelongsToCompany(
              submissionId,
              request.user.companyId
            );
            if (!belongs) {
              reply.status(403).send({
                error: 'Forbidden: Submission does not belong to your company',
              });
              return;
            }
          }

          const result = await this.vibe.updateSubmission(submissionId, {
            cardName,
          });
          if (!result.success) {
            let statusCode = 500;
            if (result.error === 'Submission not found') {
              statusCode = 404;
            }
            reply.status(statusCode).send({ error: result.error });
            return;
          }
          reply.send({ success: true, data: result.data });
        } catch (error) {
          console.error('Error updating submission:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    // Protected route to verify a playlist submission
    this.fastify.put(
      '/vibe/submissions/:submissionId/verify',
      getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
      async (request: any, reply: any) => {
        try {
          const submissionId = parseInt(request.params.submissionId);
          if (isNaN(submissionId)) {
            reply.status(400).send({ error: 'Invalid submission ID' });
            return;
          }

          // If user is companyadmin, check that the submission belongs to their company
          if (request.user.userGroups.includes('companyadmin')) {
            const belongs = await this.vibe.submissionBelongsToCompany(
              submissionId,
              request.user.companyId
            );
            if (!belongs) {
              reply.status(403).send({
                error: 'Forbidden: Submission does not belong to your company',
              });
              return;
            }
          }

          const result = await this.vibe.verifySubmission(submissionId);
          if (!result.success) {
            let statusCode = 500;
            if (result.error === 'Submission not found') {
              statusCode = 404;
            }
            reply.status(statusCode).send({ error: result.error });
            return;
          }
          reply.send({ success: true, data: result.data });
        } catch (error) {
          console.error('Error verifying submission:', error);
          reply.status(500).send({ error: 'Internal server error' });
        }
      }
    );

    this.fastify.get(
      '/download_invoice/:invoiceId',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        const { invoiceId } = request.params;
        const orderInstance = this.order;

        try {
          const invoicePath = await orderInstance.getInvoice(invoiceId);
          // Ensure the file exists and is readable
          try {
            await fs.access(invoicePath, fs.constants.R_OK);
          } catch (error) {
            reply.code(404).send('File not found.');
            return;
          }

          // Serve the file for download
          reply.header(
            'Content-Disposition',
            'attachment; filename=' + path.basename(invoicePath)
          );
          reply.type('application/pdf');

          // Read the file into memory and send it as a buffer
          try {
            const fileContent = await fs.readFile(invoicePath);
            reply.send(fileContent);
          } catch (error) {
            reply.code(500).send('Error reading file.');
          }
        } catch (error) {
          console.log(error);
          reply.status(500).send({ error: 'Failed to download invoice' });
        }
      }
    );

    // New route: /vibe/poster/:posterId
    this.fastify.get(
      '/vibe/poster/:posterId',
      async (request: any, reply: any) => {
        // You can fetch poster data here if needed, for now just pass posterId and env vars
        const posterId = request.params.posterId;
        // Optionally, generate a QR code URL for the poster
        // For now, let's use a generic QR code that links to a submission page for the posterId
        const qrUrl = `${process.env['APP_DOMAIN']}/vibe/post/${posterId}`;
        await reply.view('poster_vibe.ejs', {
          posterId,
          qrUrl,
          // Hardcoded brand colors for poster as per brand guide
          brandColor: '#5FBFFF',
          brandSecondary: '#3F6FAF',
          brandAccent: '#E56581',
          appDomain: process.env['APP_DOMAIN'],
        });
      }
    );

    this.fastify.post(
      '/php/:paymentHasPlaylistId',
      getAuthHandler(['admin']),
      async (request: any, reply: any) => {
        try {
          const paymentHasPlaylistId = parseInt(
            request.params.paymentHasPlaylistId
          );
          const { eco, doubleSided } = request.body;

          if (isNaN(paymentHasPlaylistId)) {
            reply
              .status(400)
              .send({ success: false, error: 'Invalid paymentHasPlaylistId' });
            return;
          }

          if (typeof eco !== 'boolean' || typeof doubleSided !== 'boolean') {
            reply.status(400).send({
              success: false,
              error: 'Invalid eco or doubleSided value. Must be boolean.',
            });
            return;
          }

          const result = await this.data.updatePaymentHasPlaylist(
            paymentHasPlaylistId,
            eco,
            doubleSided
          );

          if (!result.success) {
            reply.status(500).send(result);
            return;
          }

          reply.send({ success: true });
        } catch (error) {
          this.logger.log(
            `Error in /php/:paymentHasPlaylistId route: ${
              (error as Error).message
            }`
          );
          reply
            .status(500)
            .send({ success: false, error: 'Internal server error' });
        }
      }
    );
  };

  public init = async () => {
    this.isMainServer = this.utils.parseBoolean(process.env['MAIN_SERVER']!);
    await this.setVersion();
    await this.createDirs();
    await this.registerPlugins();
    await this.addAuthRoutes();
    await this.addRoutes();
    await this.startCluster();
  };

  private async setVersion() {
    this.version = JSON.parse(
      await fs.readFile('package.json', 'utf-8')
    ).version;
  }

  private async createDirs() {
    const publicDir = process.env['PUBLIC_DIR']!;
    const privateDir = process.env['PRIVATE_DIR']!;
    await this.utils.createDir(`${publicDir}/qr`);
    await this.utils.createDir(`${publicDir}/pdf`);
    await this.utils.createDir(`${privateDir}/invoice`);
  }

  public getWorkerId() {
    return this.workerId;
  }

  private async startCluster() {
    if (cluster.isPrimary) {
      this.logger.log(
        color.blue.bold(
          `Master ${color.bold.white(process.pid)} is starting...`
        )
      );

      const numCPUs = os.cpus().length;
      for (let i = 0; i < numCPUs; i++) {
        cluster.fork({
          WORKER_ID: `${i}`,
        });
      }
      cluster.on('exit', (worker, code, signal) => {
        this.logger.log(
          color.red.bold(
            `Worker ${color.white.bold(worker.process.pid)} died. Restarting...`
          )
        );
        cluster.fork({
          WORKER_ID: `${parseInt(process.env['WORKER_ID'] as string)}`,
        });
      });
    } else {
      this.workerId = parseInt(process.env['WORKER_ID'] as string);
      this.startServer();
    }
  }

  public async startServer(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.fastify.listen({ port: this.port, host: '0.0.0.0' });
        this.logger.log(
          color.green.bold('Fastify running on port: ') +
            color.white.bold(this.port) +
            color.green.bold(' on worker ') +
            color.white.bold(this.workerId)
        );
        resolve();
      } catch (err) {
        this.fastify.log.error(err);
        reject(err);
      }
    });
  }

  public getPort(): number {
    return this.port;
  }

  public async registerPlugins() {
    await this.fastify.register(require('@fastify/multipart'), {
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB limit for file uploads
      },
    });
    await this.fastify.register(require('@fastify/formbody'));
    await this.fastify.register(ipPlugin);
    await this.fastify.register(replyFrom);
    await this.fastify.register(require('@fastify/cors'), {
      origin: '*',
      methods: 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
      allowedHeaders:
        'Origin, X-Requested-With, Content-Type, Accept, sentry-trace, baggage, Authorization',
      credentials: true,
    });

    // Add security headers
    this.fastify.addHook('onSend', (_request, reply, _payload, done) => {
      reply.header('X-Frame-Options', 'DENY');
      done();
    });

    await this.fastify.register((instance, opts, done) => {
      instance.register(require('@fastify/static'), {
        root: process.env['PUBLIC_DIR'] as string,
        prefix: '/public/',
      });
      done();
    });

    await this.fastify.register((instance, opts, done) => {
      instance.register(require('@fastify/static'), {
        root: process.env['ASSETS_DIR'] as string,
        prefix: '/assets/',
      });
      done();
    });

    await this.fastify.register((instance, opts, done) => {
      instance.register(require('@fastify/static'), {
        root: path.join(process.cwd(), 'app'),
        prefix: '/',
      });
      done();
    });

    await this.fastify.setErrorHandler((error, request, reply) => {
      console.error(error);
      reply.status(500).send({ error: 'Internal Server Error' });
    });

    // Register the view plugin with EJS
    await this.fastify.register(view, {
      engine: { ejs: ejs },
      root: `${process.env['APP_ROOT']}/views`, // Ensure this is the correct path to your EJS templates
      includeViewExtension: true,
    });
  }

  public async addRoutes() {
    // Register blog routes
    await blogRoutes(this.fastify);

    // Unprotected endpoint to create a company and company list (moved to Vibe)
    this.fastify.post(
      '/vibe/companylist/create',
      async (request: any, reply: any) => {
        const result = await this.vibe.handleCompanyListCreate(
          request.body,
          request.clientIp
        );
        if (!result.success) {
          reply.status(result.statusCode || 400).send(result);
        } else {
          reply.send(result);
        }
      }
    );

    this.fastify.get(
      '/.well-known/apple-app-site-association',
      async (_request, reply) => {
        const filePath = path.join(
          process.env['APP_ROOT'] as string,
          '..',
          'apple-app-site-association'
        );
        try {
          const fileContent = await fs.readFile(filePath, 'utf-8');
          reply.header('Content-Type', 'application/json').send(fileContent);
        } catch (error) {
          reply.status(404).send({ error: 'File not found' });
        }
      }
    );

    this.fastify.get('/robots.txt', async (_request, reply) => {
      reply
        .header('Content-Type', 'text/plain')
        .send('User-agent: *\nDisallow: /');
    });

    this.fastify.post(
      '/spotify/playlists/tracks',
      async (request: any, _reply) => {
        return await this.spotify.getTracks(
          request.body.playlistId,
          this.utils.parseBoolean(request.body.cache),
          request.body.captchaToken,
          true,
          this.utils.parseBoolean(request.body.slug)
        );
      }
    );

    this.fastify.post(
      '/spotify/playlists',

      async (request: any, _reply) => {
        return await this.spotify.getPlaylist(
          request.body.playlistId,
          this.utils.parseBoolean(request.body.cache),
          request.body.captchaToken,
          true,
          this.utils.parseBoolean(request.body.featured),
          this.utils.parseBoolean(request.body.slug),
          request.body.locale
        );
      }
    );

    this.fastify.post('/mollie/check', async (request: any, _reply) => {
      return await this.mollie.checkPaymentStatus(request.body.paymentId);
    });

    this.fastify.post('/mollie/payment', async (request: any, _reply) => {
      return await this.mollie.getPaymentUri(request.body, request.clientIp);
    });

    this.fastify.post('/mollie/webhook', async (request: any, _reply) => {
      return await this.mollie.processWebhook(request.body);
    });

    this.fastify.post('/contact', async (request: any, _reply) => {
      return await this.mail.sendContactForm(request.body, request.clientIp);
    });

    this.fastify.get('/ip', async (request, reply) => {
      return { ip: request.ip, clientIp: request.clientIp };
    });

    this.fastify.get(
      '/progress/:playlistId/:paymentId',
      async (request: any, _reply) => {
        const data = await this.data.getPayment(
          request.params.paymentId,
          request.params.playlistId
        );
        return {
          success: true,
          data,
        };
      }
    );

    this.fastify.get('/qr/:trackId', async (request: any, reply) => {
      // Get the 'Accept-Language' header from the request
      const locale = this.utils.parseAcceptLanguage(
        request.headers['accept-language']
      );
      const translations = await this.translation.getTranslationsByPrefix(
        locale,
        'countdown'
      );
      let useVersion = this.version;
      if (process.env['ENVIRONMENT'] === 'development') {
        useVersion = new Date().getTime().toString();
      }
      await reply.view(`countdown.ejs`, {
        translations,
        version: useVersion,
        domain: process.env['FRONTEND_URI'],
      });
    });

    this.fastify.get('/qr2/:trackId/:php', async (request: any, reply) => {
      // Get the 'Accept-Language' header from the request

      console.log(111, request.params.trackId, request.params.php);

      const locale = this.utils.parseAcceptLanguage(
        request.headers['accept-language']
      );
      const translations = await this.translation.getTranslationsByPrefix(
        locale,
        'countdown'
      );
      let useVersion = this.version;
      if (process.env['ENVIRONMENT'] === 'development') {
        useVersion = new Date().getTime().toString();
      }
      await reply.view(`countdown.ejs`, {
        translations,
        version: useVersion,
        domain: process.env['FRONTEND_URI'],
      });
    });

    this.fastify.get('/qrvibe/:trackId', async (request: any, reply) => {
      // Get the 'Accept-Language' header from the request
      const locale = this.utils.parseAcceptLanguage(
        request.headers['accept-language']
      );
      const translations = await this.translation.getTranslationsByPrefix(
        locale,
        'countdown_onzevibe'
      );
      let useVersion = this.version;
      if (process.env['ENVIRONMENT'] === 'development') {
        useVersion = new Date().getTime().toString();
      }
      await reply.view(`countdown_vibe.ejs`, {
        translations,
        version: useVersion,
        domain: process.env['FRONTEND_URI'],
      });
    });

    this.fastify.get('/qrlink/:trackId', async (request: any, reply) => {
      // Get the request headers
      const headers = request.headers;
      const userAgent = headers['user-agent'] || '';

      const result = await this.data.getLink(
        request.params.trackId,
        request.clientIp,
        true,
        userAgent
      );
      let link = '';
      let yt = '';
      if (result.success) {
        link = result.data.link;
        yt = result.data.youtubeLink;
      }
      return { link: link, yt: yt, r: this.useSpotifyRemote };
    });

    this.fastify.get('/qrlink2/:trackId/:php', async (request: any, reply) => {
      // Get the request headers
      const headers = request.headers;
      const userAgent = headers['user-agent'] || '';
      const result = await this.data.getLink(
        request.params.trackId,
        request.clientIp,
        true,
        userAgent
      );
      let link = '';
      let yt = '';
      if (result.success) {
        link = result.data.link;
        yt = result.data.youtubeLink;
      }
      return { link: link, yt: yt, r: this.useSpotifyRemote };
    });

    // New endpoint: POST /qrlink_unknown
    this.fastify.post('/qrlink_unknown', async (request: any, reply: any) => {
      const { url } = request.body;
      if (!url || typeof url !== 'string') {
        reply
          .status(400)
          .send({ success: false, error: 'Missing or invalid url parameter' });
        return;
      }
      try {
        const result = await this.spotify.resolveSpotifyUrl(url);

        // Log the unknown link scan, indicate if cached
        this.logger.log(
          color.blue.bold(
            `Unknown link scanned${result.cached ? ' (CACHED)' : ''}: ` +
              color.white.bold(`url="${url}"`) +
              color.blue.bold(', result=') +
              color.white.bold(
                JSON.stringify({
                  success: result.success,
                  spotifyUri: result.spotifyUri,
                  error: result.error,
                })
              )
          )
        );
        if (result.success) {
          reply.send({ success: true, spotifyUri: result.spotifyUri });
        } else {
          reply.status(404).send({
            success: false,
            error: result.error || 'No Spotify URI found',
          });
        }
      } catch (e: any) {
        this.logger.log(
          `Error scanning unknown link: url="${url}", error=${e.message || e}`
        );
        reply
          .status(500)
          .send({ success: false, error: e.message || 'Internal error' });
      }
    });

    this.fastify.get(
      '/qr/pdf/:playlistId/:paymentId/:template/:startIndex/:endIndex/:subdir/:eco/:emptyPages',
      async (request: any, reply) => {
        const valid = await this.mollie.canDownloadPDF(
          request.params.playlistId,
          request.params.paymentId
        );
        if (!valid) {
          reply.status(403).send({ error: 'Forbidden' });
          return;
        }

        const payment = await this.mollie.getPayment(request.params.paymentId);

        const user = await this.data.getUser(payment.userId);
        const playlist = await this.data.getPlaylist(request.params.playlistId);
        const php = await this.data.getPlaylistsByPaymentId(
          request.params.paymentId,
          request.params.playlistId
        );
        let tracks = await this.data.getTracks(playlist.id, user.id);

        // Slice the tracks based on the start and end index which is 0-based
        const startIndex = parseInt(request.params.startIndex);
        const endIndex = parseInt(request.params.endIndex);
        const eco = this.utils.parseBoolean(request.params.eco);
        const emptyPages = parseInt(request.params.emptyPages);
        const subdir = request.params.subdir;
        tracks = tracks.slice(startIndex, endIndex + 1);

        // Extract domain from email and check if it's in the whitelist
        const emailDomain = payment.email ? payment.email.split('@')[1] : '';
        const whitelabel = this.whiteLabels.find(
          (wl) => wl.domain === emailDomain
        );

        if (payment.email) {
          const template =
            whitelabel && request.params.template.indexOf('digital_double') > -1
              ? `${request.params.template}_${whitelabel.template}`
              : request.params.template;

          await reply.view(`pdf_${template}.ejs`, {
            subdir,
            payment,
            playlist,
            php: php[0],
            tracks,
            user,
            eco,
            emptyPages,
          });
        }
      }
    );

    this.fastify.get('/invoice/:paymentId', async (request: any, reply) => {
      const payment = await this.mollie.getPayment(request.params.paymentId);
      if (!payment) {
        reply.status(404).send({ error: 'Payment not found' });
        return;
      }
      const playlists = await this.data.getPlaylistsByPaymentId(
        payment.paymentId
      );

      let orderType = 'digital';
      for (const playlist of playlists) {
        if (playlist.orderType !== 'digital') {
          orderType = 'physical';
          break;
        }
      }

      await reply.view(`invoice.ejs`, {
        payment,
        playlists,
        orderType,
        ...this.formatters,
        translations: await this.translation.getTranslationsByPrefix(
          payment.locale,
          'invoice'
        ),
        countries: await this.translation.getTranslationsByPrefix(
          payment.locale,
          'countries'
        ),
      });
    });

    this.fastify.get('/test', async (request: any, _reply) => {
      this.analytics.increaseCounter('testCategory', 'testAction');

      const interfaces = os.networkInterfaces();
      let localIp = 'Not found';
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
          if (iface.family === 'IPv4' && !iface.internal) {
            localIp = iface.address;
            break;
          }
        }
      }

      return { success: true, localIp, version: this.version };
    });

    this.fastify.get('/featured/:locale', async (request: any, _reply) => {
      const playlists = await this.data.getFeaturedPlaylists(
        request.params.locale
      );
      return { success: true, data: playlists };
    });

    this.fastify.get(
      '/ordertype/:numberOfTracks/:digital/:subType/:playlistId',
      async (request: any, _reply) => {
        const orderType = await this.order.getOrderType(
          parseInt(request.params.numberOfTracks),
          this.utils.parseBoolean(request.params.digital),
          'cards',
          request.params.playlistId,
          request.params.subType
        );
        if (orderType) {
          return {
            success: true,
            data: {
              id: orderType.id,
              amount: orderType.amount,
              maxCards: orderType.digital ? 3000 : 1000,
              alternatives: orderType.alternatives || {},
              available: true,
            },
          };
        } else {
          return {
            success: true,
            data: {
              id: 0,
              amount: 0,
              alternatives: {},
              available: false,
            },
          };
        }
      }
    );

    this.fastify.get('/ordertypes', async (request: any, _reply) => {
      const orderTypes = await this.order.getOrderTypes();
      if (orderTypes && orderTypes.length > 0) {
        return orderTypes;
      } else {
        return { success: false, error: 'Order type not found' };
      }
    });

    this.fastify.get(
      '/download/:paymentId/:userHash/:playlistId/:type',
      async (request: any, reply) => {
        const pdfFile = await this.data.getPDFFilepath(
          request.clientIp,
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId,
          request.params.type
        );
        if (pdfFile && pdfFile.filePath) {
          try {
            await fs.access(pdfFile.filePath, fs.constants.R_OK);
            reply.header(
              'Content-Disposition',
              'attachment; filename=' + pdfFile.fileName
            );
            reply.type('application/pdf');
            const fileContent = await fs.readFile(pdfFile.filePath);

            this.logger.log(
              color.blue.bold(
                `User downloaded file: ${color.white.bold(pdfFile.filePath)}`
              )
            );

            reply.send(fileContent);
          } catch (error) {
            reply.code(404).send('PDF not found');
          }
        } else {
          reply.code(404).send('PDF not found');
        }
      }
    );

    this.fastify.post('/order/calculate', async (request: any, _reply) => {
      try {
        const result = await this.order.calculateOrder(request.body);
        return result;
      } catch (e) {
        return { success: false };
      }
    });

    this.fastify.get('/cache', async (request: any, _reply) => {
      this.order.updateFeaturedPlaylists();
      return { success: true };
    });

    this.fastify.post('/printapi/webhook', async (request: any, _reply) => {
      await this.order.processPrintApiWebhook(request.body.orderId);
      return { success: true };
    });

    this.fastify.get('/upload_contacts', async (request: any, _reply) => {
      const result = await this.mail.uploadContacts();
      return { success: true };
    });

    this.fastify.post('/newsletter_subscribe', async (request: any, reply) => {
      const { email, captchaToken } = request.body;
      if (!email || !this.utils.isValidEmail(email)) {
        reply
          .status(400)
          .send({ success: false, error: 'Invalid email address' });
        return;
      }

      const result = await this.mail.subscribeToNewsletter(email, captchaToken);
      return { success: result };
    });

    this.fastify.get('/unsubscribe/:hash', async (request: any, reply) => {
      const result = await this.mail.unsubscribe(request.params.hash);
      if (result) {
        reply.send({ success: true, message: 'Successfully unsubscribed' });
      } else {
        reply
          .status(400)
          .send({ success: false, message: 'Invalid unsubscribe link' });
      }
    });

    this.fastify.get('/unsent_reviews', async (request: any, _reply) => {
      return await this.review.processReviewEmails();
    });

    this.fastify.get(
      '/usersuggestions/:paymentId/:userHash/:playlistId',
      async (request: any, reply) => {
        const suggestions = await this.suggestion.getUserSuggestions(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId
        );
        return { success: true, data: suggestions };
      }
    );

    this.fastify.post(
      '/usersuggestions/:paymentId/:userHash/:playlistId',
      async (request: any, reply) => {
        const {
          trackId,
          name,
          artist,
          year,
          extraNameAttribute,
          extraArtistAttribute,
        } = request.body;

        if (!trackId || !name || !artist || !year) {
          reply
            .status(400)
            .send({ success: false, error: 'Missing required fields' });
          return;
        }

        const success = await this.suggestion.saveUserSuggestion(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId,
          trackId,
          {
            name,
            artist,
            year,
            extraNameAttribute,
            extraArtistAttribute,
          }
        );

        return { success };
      }
    );

    this.fastify.post(
      '/usersuggestions/:paymentId/:userHash/:playlistId/submit',
      async (request: any, reply) => {
        const success = await this.suggestion.submitUserSuggestions(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId,
          request.clientIp
        );
        return { success };
      }
    );

    this.fastify.post(
      '/usersuggestions/:paymentId/:userHash/:playlistId/extend',
      async (request: any, reply) => {
        const success = await this.suggestion.extendPrinterDeadline(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId
        );
        return { success };
      }
    );

    this.fastify.post('/designer/upload/:type', async (request: any, reply) => {
      const { image, filename } = request.body;
      const { type } = request.params;

      if (!image) {
        reply.status(400).send({ success: false, error: 'No image provided' });
        return;
      }

      let result = { success: false };

      if (type == 'background') {
        result = await this.designer.uploadBackgroundImage(image, filename);
      } else if (type == 'logo') {
        result = await this.designer.uploadLogoImage(image, filename);
      }
      return result;
    });

    this.fastify.delete(
      '/usersuggestions/:paymentId/:userHash/:playlistId/:trackId',
      async (request: any, reply) => {
        const success = await this.suggestion.deleteUserSuggestion(
          request.params.paymentId,
          request.params.userHash,
          request.params.playlistId,
          parseInt(request.params.trackId)
        );
        return { success };
      }
    );

    if (process.env['ENVIRONMENT'] == 'development') {
      // Add a test route for audio generation (POST)
      this.fastify.post('/test_audio', async (request: any, reply: any) => {
        try {
          const { prompt, instructions } = request.body as {
            prompt?: string;
            instructions?: string;
          };

          if (!prompt) {
            reply.status(400).send({
              success: false,
              error: 'Missing required field: prompt',
            });
            return;
          }

          // Call generateAudio with only prompt and optional instructions
          const filePath = await this.audio.generateAudio(prompt, instructions);
          reply.send({
            success: true,
            message: `Audio generated successfully at ${filePath}`,
          });
        } catch (error) {
          this.logger.log(
            `Error in /test_audio route: ${(error as Error).message}`
          );
          reply
            .status(500)
            .send({ success: false, error: 'Failed to generate audio' });
        }
      });

      this.fastify.get(
        '/generate_invoice/:paymentId',
        async (request: any, _reply) => {
          const payment = await this.mollie.getPayment(
            request.params.paymentId
          );
          if (payment) {
            const pdfPath = await this.order.createInvoice(payment);
            this.mail.sendTrackingEmail(
              payment,
              payment.printApiTrackingLink!,
              pdfPath
            );
            return { success: true };
          } else {
            return { success: false };
          }
        }
      );

      this.fastify.get(
        '/youtube/:artist/:title',
        async (request: any, reply: any) => {
          const result = await this.data.getYouTubeLink(
            request.params.artist,
            request.params.title
          );
          reply.send({
            success: true,
            youtubeLink: result,
          });
        }
      );

      this.fastify.post('/push', async (request: any, reply: any) => {
        const { token, title, message } = request.body;
        await this.push.sendPushNotification(token, title, message);
        reply.send({ success: true });
      });

      this.fastify.post('/qrtest', async (request: any, _reply) => {
        const result = await this.qr.generateQR(
          `${request.body.url}`,
          `/mnt/efs/qrsong/${request.body.filename}`
        );
        return { success: true };
      });

      this.fastify.get('/testorder', async (request: any, _reply) => {
        await this.order.testOrder();
        return { success: true };
      });

      this.fastify.get('/calculate_shipping', async (request: any, _reply) => {
        this.order.calculateShippingCosts();
        return { success: true };
      });

      this.fastify.get('/generate/:paymentId', async (request: any, _reply) => {
        await this.generator.generate(
          request.params.paymentId,
          request.clientIp,
          '',
          this.mollie
        );
        return { success: true };
      });

      this.fastify.get('/mail/:paymentId', async (request: any, _reply) => {
        const payment = await this.mollie.getPayment(request.params.paymentId);
        const playlist = await this.data.getPlaylist(
          payment.playlist.playlistId
        );
        await this.mail.sendEmail(
          'digital',
          payment,
          playlist,
          payment.filename,
          payment.filenameDigital
        );
        return { success: true };
      });

      this.fastify.get('/release/:query', async (request: any, _reply) => {
        const year = await this.openai.ask(request.params.query);
        return { success: true, year };
      });

      this.fastify.get(
        '/yearv2/:id/:isrc/:artist/:title/:spotifyReleaseYear',
        async (request: any, _reply) => {
          const result = await this.music.getReleaseDate(
            parseInt(request.params.id),
            request.params.isrc,
            request.params.artist,
            request.params.title,
            parseInt(request.params.spotifyReleaseYear)
          );
          return { success: true, data: result };
        }
      );

      this.fastify.get(
        '/dev/translate_genres',
        async (_request: any, reply: any) => {
          try {
            this.data.translateGenres();
            reply.send({
              success: true,
              message: 'Genre translation process started.',
            });
          } catch (error) {
            this.logger.log(
              `Error in /dev/translate_genres route: ${
                (error as Error).message
              }`
            );
            reply
              .status(500)
              .send({ success: false, error: 'Failed to translate genres' });
          }
        }
      );
    }

    this.fastify.get(
      '/discount/voucher/:type/:code/:paymentId',
      async (request: any, reply: any) => {
        const { type, code, paymentId } = request.params;
        const discount = await this.discount.getDiscountDetails(code);
        const payment = await this.mollie.getPayment(paymentId);
        if (discount) {
          try {
            const translations = await this.translation.getTranslationsByPrefix(
              payment.locale,
              'voucher'
            );
            await reply.view(`voucher_${type}.ejs`, {
              discount,
              translations,
            });
          } catch (error) {
            reply.status(500).send({ error: 'Internal Server Error' });
          }
        } else {
          reply.status(404).send({ error: 'Code not found' });
        }
      }
    );

    // Hitlist routes
    this.fastify.post('/hitlist', async (request: any, _reply) => {
      return await this.hitlist.getCompanyListByDomain(
        request.body.domain,
        request.body.hash,
        request.body.slug
      );
    });

    this.fastify.post('/hitlist/search', async (request: any, _reply) => {
      const { searchString, limit = 10, offset = 0 } = request.body;

      // Use the hitlist search method instead of directly calling spotify
      return await this.spotify.searchTracks(searchString);
    });

    this.fastify.post('/hitlist/tracks', async (request: any, _reply) => {
      const { trackIds } = request.body;

      if (!trackIds || !Array.isArray(trackIds) || trackIds.length === 0) {
        return { success: false, error: 'Invalid track IDs' };
      }

      return await this.spotify.getTracksByIds(trackIds);
    });

    this.fastify.post('/hitlist/submit', async (request: any, reply) => {
      const {
        hitlist,
        companyListId,
        submissionHash,
        firstname,
        lastname,
        locale,
        email,
        agreeToUseName, // Added agreeToUseName
      } = request.body;

      // Add companyListId, submissionHash, firstname, lastname, email and agreeToUseName to each track
      const enrichedHitlist = hitlist.map((track: any) => ({
        ...track,
        companyListId,
        submissionHash,
        firstname,
        lastname,
        email,
        locale,
        agreeToUseName, // Added agreeToUseName
      }));

      const result = await this.hitlist.submit(enrichedHitlist);
      if (!result.success) {
        return result; // Return error if submission failed
      }

      return {
        success: true,
        message: email
          ? 'Please check your email to verify your submission'
          : 'Submission received',
      };
    });

    // API endpoint for verifying submissions via POST request
    this.fastify.post('/hitlist/verify', async (request: any, reply) => {
      const { hash } = request.body;

      if (!hash) {
        return { success: false, error: 'Missing verification hash' };
      }

      const success = await this.hitlist.verifySubmission(hash);

      return {
        success: success,
        message: success
          ? 'Verificatie succesvol. Je wordt nu terug gestuurd naar je lijst ...'
          : 'Verificatie mislukt',
      };
    });

    // API endpoint for completing Spotify authorization with the code
    this.fastify.post(
      '/hitlist/spotify-auth-complete',
      async (request: any, reply) => {
        const { code } = request.body;

        if (!code) {
          return { success: false, error: 'Missing authorization code' };
        }

        // Exchange the code for tokens using the public method on the Spotify instance
        const token = await this.spotify.getTokensFromAuthCode(code);

        if (token) {
          this.logger.log(
            color.green.bold(
              'Spotify authorization successful via POST. Token stored.'
            )
          );
          // Playlist creation is handled separately. Return success.
          return {
            success: true,
            message: 'Spotify authorization successful.',
          };
        } else {
          this.logger.log(
            color.red.bold('Failed to exchange Spotify auth code via POST.')
          );
          return {
            success: false,
            error: 'Failed to complete Spotify authorization.',
          };
        }
      }
    );

    // API endpoint for handling Spotify authorization callback (this will be hit by the browser)
    this.fastify.get('/spotify_callback', async (request: any, reply) => {
      // Removed state from query parameters
      const { code } = request.query;

      if (!code) {
        reply.type('text/html').send(`
          <html>
            <head><title>Spotify Authorization Failed</title></head>
            <body>
              <h1>Authorization Failed</h1>
              <p>No authorization code was received from Spotify.</p>
            </body>
          </html>
        `);
        return;
      }

      // Exchange the code for tokens using the public method on the Spotify instance
      const tokenResult = await this.spotify.getTokensFromAuthCode(code);

      if (tokenResult) {
        // Check if token exchange was successful (returned new access token)
        this.logger.log(
          color.green.bold(
            'Spotify authorization successful via callback. Token stored.'
          )
        );
        // Playlist creation is handled separately now (e.g., by finalizeList)
        // Just show a success message.
        reply.type('text/html').send(`
          <html>
            <head><title>Spotify Authorization Complete</title></head>
            <body>
              <h1>Authorization Complete</h1>
              <p>Your Spotify account has been successfully linked.</p>
              <!-- Optionally redirect or provide further instructions -->
            </body>
          </html>
        `);
      } else {
        this.logger.log(
          color.red.bold(
            'Failed to exchange Spotify auth code during callback.'
          )
        );
        reply.type('text/html').send(`
          <html>
            <head><title>Spotify Authorization Error</title></head>
            <body>
              <h1>Authorization Error</h1>
              <p>There was an error completing the Spotify authorization. Please try again.</p>
            </body>
          </html>
        `);
      }
    });
  }
}

export default Server;
