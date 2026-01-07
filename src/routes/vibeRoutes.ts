import { FastifyInstance } from 'fastify';
import { verifyToken } from '../auth';
import Vibe from '../vibe';
import Mollie from '../mollie';

export default async function vibeRoutes(
  fastify: FastifyInstance,
  verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const vibe = Vibe.getInstance();
  const mollie = new Mollie();

  // Get all companies
  fastify.get(
    '/vibe/companies',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const result = await vibe.getAllCompanies();

        if (!result.success) {
          reply.status(500).send({ error: result.error });
          return;
        }

        reply.send(result.data);
      } catch (error) {
        console.error('Error retrieving all companies:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Update company list
  fastify.put(
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

        const result = await vibe.updateCompanyList(companyId, listId, request);

        if (!result || !result.success) {
          let statusCode = 500;
          if (result.error === 'Company list not found') {
            statusCode = 404;
          } else if (result.error === 'List does not belong to this company') {
            statusCode = 403;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send(result.data);
      } catch (error) {
        console.error('Error updating company list:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get users by company
  fastify.get(
    '/vibe/users/:companyId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const result = await vibe.getUsersByCompany(companyId);

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

  // Update company
  fastify.put(
    '/vibe/companies/:companyId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const {
        name,
        test,
        address,
        housenumber,
        city,
        zipcode,
        countrycode,
        contact,
        contactemail,
        contactphone,
      } = request.body;

      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }
      if (!name) {
        reply.status(400).send({ error: 'Missing required field: name' });
        return;
      }

      const result = await vibe.updateCompany(companyId, {
        name,
        test,
        address,
        housenumber,
        city,
        zipcode,
        countrycode,
        contact,
        contactemail,
        contactphone,
      });

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

  // Update company calculation
  fastify.put(
    '/vibe/companies/:companyId/calculation',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const { calculation } = request.body;

      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
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

      const result = await vibe.updateCompany(companyId, { calculation });

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

  // Update company Tromp calculation
  fastify.put(
    '/vibe/companies/:companyId/calculation-tromp',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      const companyId = parseInt(request.params.companyId);
      const { calculationTromp } = request.body;

      if (isNaN(companyId)) {
        reply.status(400).send({ error: 'Invalid company ID' });
        return;
      }

      const result = await vibe.updateCompany(companyId, { calculationTromp });

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

  // Quotation HTML View (for PDF generation)
  fastify.get(
    '/vibe/quotation/:type/:companyId/:quotationNumber',
    async (request: any, reply: any) => {
      try {
        const type = request.params.type; // 'onzevibe' or 'qrsong'
        const companyId = parseInt(request.params.companyId);
        const quotationNumber = request.params.quotationNumber;

        // Get company data directly from database
        const companiesResult = await vibe.getAllCompanies();
        const companies = companiesResult.data.companies;
        const company = companies.find((c: any) => c.id === companyId);

        if (!company) {
          reply.status(404).send({ error: 'Company not found' });
          return;
        }

        let calculation: any = {};
        let calculationResult: any = {};

        if (type === 'qrsong') {
          // Tromp calculation
          calculation = {
            quantity: 100,
            includeStansmestekening: false,
            includeStansvorm: false,
            profitMargin: 0,
          };

          if (company.calculationTromp) {
            try {
              const storedCalc = JSON.parse(company.calculationTromp);
              calculation = storedCalc;
            } catch (e) {
              console.error('Error parsing company Tromp calculation:', e);
            }
          }

          // Use the Vibe calculateTrompPricing method
          const pricingResult = await vibe.calculateTrompPricing({
            quantity: calculation.quantity || 100,
            includeStansmestekening: calculation.includeStansmestekening || false,
            includeStansvorm: calculation.includeStansvorm || false,
            includeCustomApp: calculation.includeCustomApp || false,
            profitMargin: calculation.profitMargin || 0,
          });

          if (pricingResult.success) {
            calculationResult = pricingResult.calculation;
          }
        } else {
          // OnzeVibe calculation
          calculation = {
            quantity: 100,
            includePersonalization: true,
            shipmentOnLocation: false,
            soldBy: 'onzevibe',
            isReseller: false,
            manualDiscount: 0,
            fluidMode: false,
          };

          if (company.calculation) {
            try {
              const storedCalc = JSON.parse(company.calculation);
              calculation = storedCalc;
            } catch (e) {
              console.error('Error parsing company calculation:', e);
            }
          }

          // Use the Vibe calculatePricing method
          const pricingResult = await vibe.calculatePricing({
            quantity: calculation.quantity || 100,
            includePersonalization:
              calculation.includePersonalization !== undefined
                ? calculation.includePersonalization
                : true,
            shipmentOnLocation: calculation.shipmentOnLocation || false,
            soldBy: calculation.soldBy || 'onzevibe',
            isReseller: calculation.isReseller || false,
            manualDiscount: calculation.manualDiscount || 0,
            fluidMode: calculation.fluidMode || false,
            includeCustomApp: calculation.includeCustomApp || false,
          });

          if (pricingResult.success) {
            calculationResult = pricingResult.calculation;
          }
        }

        // Date formatting functions
        const formatDate = (date: Date) => {
          const options: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          };
          return date.toLocaleDateString('nl-NL', options);
        };

        const formatCurrency = (value: number) => {
          return new Intl.NumberFormat('nl-NL', {
            style: 'currency',
            currency: 'EUR',
          }).format(value);
        };

        const today = new Date();
        const validUntil = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

        // Use the appropriate template
        const template = type === 'qrsong' ? 'tromp_quotation.ejs' : 'vibe_quotation.ejs';

        await reply.view(template, {
          company,
          calculation,
          calculationResult,
          quotationNumber,
          validUntil,
          formatCurrency,
          formatDate,
          baseUrl,
        });
      } catch (error) {
        console.error('Error rendering quotation view:', error);
        reply.status(500).send({ error: 'Failed to render quotation' });
      }
    }
  );

  // Generate quotation PDF
  fastify.post(
    '/vibe/quotation/:companyId',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
        const { type } = request.body; // 'onzevibe' or 'qrsong'

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        // Call the business logic in Vibe class
        const result = await vibe.generateQuotationPDF(
          companyId,
          request.user.userId,
          request.user.userGroups,
          request.user.companyId,
          type || 'onzevibe'
        );

        if (!result.success) {
          const statusCode = result.error?.includes('Forbidden')
            ? 403
            : result.error?.includes('not found')
            ? 404
            : 500;
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        // Set response headers for PDF download
        reply.header('Content-Type', 'application/pdf');
        reply.header(
          'Content-Disposition',
          `attachment; filename="${result.filename}"`
        );

        reply.send(result.data);
      } catch (error) {
        console.error('Error generating quotation:', error);
        reply.status(500).send({ error: 'Failed to generate quotation' });
      }
    }
  );

  // Technical Instructions HTML View (for PDF generation)
  fastify.get(
    '/vibe/technical-instructions/:companyId',
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        // Get company data
        const companiesResult = await vibe.getAllCompanies();
        const companies = companiesResult.data.companies;
        const company = companies.find((c: any) => c.id === companyId);

        if (!company) {
          reply.status(404).send({ error: 'Company not found' });
          return;
        }

        // Date formatting function
        const formatDate = (date: Date) => {
          const options: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          };
          return date.toLocaleDateString('nl-NL', options);
        };

        // Get base URL for assets
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

        // Render the EJS template (matches quotation route pattern)
        await reply.view('technical_instructions.ejs', {
          company,
          baseUrl,
          formatDate,
        });
      } catch (error) {
        console.error('Error rendering technical instructions:', error);
        reply.status(500).send({ error: 'Failed to render technical instructions: ' + error });
      }
    }
  );

  // Generate Technical Instructions PDF
  fastify.post(
    '/vibe/technical-instructions/:companyId',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        // Get company data
        const companiesResult = await vibe.getAllCompanies();
        const companies = companiesResult.data.companies;
        const company = companies.find((c: any) => c.id === companyId);

        if (!company) {
          reply.status(404).send({ error: 'Company not found' });
          return;
        }

        // Generate PDF using Lambda
        const PDF = require('../pdf').default;
        const pdfManager = new PDF();

        // Prepare file path
        const path = require('path');
        const tempDir = '/tmp';
        const fileName = `technical_instructions_${companyId}_${Date.now()}.pdf`;
        const filePath = path.join(tempDir, fileName);

        // Create the URL for the HTML rendering
        const baseUrl = process.env['API_URI'] || 'http://localhost:3004';
        const htmlUrl = `${baseUrl}/vibe/technical-instructions/${companyId}`;

        // Generate PDF
        await pdfManager.generateFromUrl(htmlUrl, filePath, {
          format: 'a4',
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
        });

        // Read the generated PDF
        const fs = require('fs').promises;
        const pdfBuffer = await fs.readFile(filePath);

        // Clean up
        await fs.unlink(filePath).catch(() => {});

        // Generate filename for download
        const downloadFilename = `Technische_Instructies_${company.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;

        // Set response headers for PDF download
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${downloadFilename}"`);

        reply.send(pdfBuffer);
      } catch (error) {
        console.error('Error generating technical instructions PDF:', error);
        reply.status(500).send({ error: 'Failed to generate technical instructions PDF' });
      }
    }
  );

  // Delete company
  fastify.delete(
    '/vibe/companies/:companyId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);

        if (isNaN(companyId)) {
          reply.status(400).send({ error: 'Invalid company ID' });
          return;
        }

        const result = await vibe.deleteCompany(companyId);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Company not found') {
            statusCode = 404;
          } else if (
            result.error ===
            'Company cannot be deleted because it has associated lists'
          ) {
            statusCode = 409;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send({ success: true });
      } catch (error) {
        console.error('Error deleting company:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Replace track in submissions
  fastify.post(
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

        const result = await vibe.replaceTrackInSubmissions(
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

  // Delete submission
  fastify.delete(
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
          const belongs = await vibe.submissionBelongsToCompany(
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

        const result = await vibe.deleteSubmission(submissionId);

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

  // Create company list
  fastify.post(
    '/vibe/companies/:companyId/lists',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const companyId = parseInt(request.params.companyId);
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
          numberOfCards: parseInt(numberOfCards),
          numberOfTracks: parseInt(numberOfTracks),
          playlistSource,
          playlistUrl,
        };

        const result = await vibe.createCompanyList(companyId, listData);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Bedrijf niet gevonden') {
            statusCode = 404;
          } else if (
            result.error === 'Slug bestaat al. Kies een unieke slug.'
          ) {
            statusCode = 409;
          } else if (
            result.error === 'Ongeldig bedrijfs-ID opgegeven' ||
            result.error ===
              'Verplichte velden voor de bedrijfslijst ontbreken' ||
            result.error === 'Ongeldig aantal voor kaarten of nummers'
          ) {
            statusCode = 400;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        const responseData = {
          listId: result.data.list.id,
          list: result.data.list,
        };
        reply.status(201).send(responseData);
      } catch (error) {
        console.error('Error creating company list:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Delete company list
  fastify.delete(
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

        const result = await vibe.deleteCompanyList(companyId, listId);

        if (!result.success) {
          let statusCode = 500;
          if (result.error === 'Company list not found') {
            statusCode = 404;
          } else if (result.error === 'List does not belong to this company') {
            statusCode = 403;
          } else if (result.error.includes('status is not "new"')) {
            statusCode = 409;
          }
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.send({ success: true });
      } catch (error) {
        console.error('Error deleting company list:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Create company
  fastify.post(
    '/vibe/companies',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const {
          name,
          test,
          address,
          housenumber,
          city,
          zipcode,
          countrycode,
          contact,
          contactemail,
          contactphone,
        } = request.body;

        if (!name) {
          reply.status(400).send({ error: 'Missing required field: name' });
          return;
        }

        const result = await vibe.createCompany({
          name,
          test,
          address,
          housenumber,
          city,
          zipcode,
          countrycode,
          contact,
          contactemail,
          contactphone,
        });

        if (!result.success) {
          const statusCode =
            result.error === 'Company with this name already exists'
              ? 409
              : 500;
          reply.status(statusCode).send({ error: result.error });
          return;
        }

        reply.status(201).send(result.data);
      } catch (error) {
        console.error('Error creating company:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Finalize company list
  fastify.post(
    '/vibe/finalize',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply) => {
      const { companyListId } = request.body;

      if (!companyListId) {
        return { success: false, error: 'Missing company list ID' };
      }

      return await vibe.finalizeList(parseInt(companyListId));
    }
  );

  // Get company list state
  fastify.get(
    '/vibe/state/:listId',
    getAuthHandler(['admin', 'vibeadmin', 'companyadmin', 'qrvoteadmin']),
    async (request: any, reply: any) => {
      try {
        const token = request.headers.authorization?.split(' ')[1];
        const decoded = verifyToken(token || '');
        const listId = parseInt(request.params.listId);

        const result = await vibe.getState(listId);

        if (!result.success) {
          reply.status(404).send({ error: result.error });
          return;
        }

        reply.send(result.data);
      } catch (error) {
        console.error('Error retrieving company state:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get company lists
  fastify.get(
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
        const result = await vibe.getCompanyLists(
          parseInt(request.params.companyId)
        );

        if (!result.success) {
          reply.status(404).send({ error: result.error });
          return;
        }

        reply.send(result.data);
      } catch (error) {
        console.error('Error retrieving company lists:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Generate PDF
  fastify.post(
    '/vibe/generate/:listId',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const listId = parseInt(request.params.listId);

        if (isNaN(listId)) {
          reply.status(400).send({ error: 'Invalid list ID' });
          return;
        }

        const result = await vibe.generatePDF(listId, mollie, request.clientIp);

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

  // Update submission
  fastify.put(
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
          const belongs = await vibe.submissionBelongsToCompany(
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

        const result = await vibe.updateSubmission(submissionId, { cardName });
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

  // Verify submission
  fastify.put(
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
          const belongs = await vibe.submissionBelongsToCompany(
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

        const result = await vibe.verifySubmission(submissionId);
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

  // Create company list (public endpoint)
  fastify.post('/vibe/companylist/create', async (request: any, reply: any) => {
    const result = await vibe.handleCompanyListCreate(
      request.body,
      request.clientIp
    );
    if (!result.success) {
      reply.status(result.statusCode || 400).send(result);
    } else {
      reply.send(result);
    }
  });

  // Calculate pricing (admin and vibeadmin only)
  fastify.post(
    '/vibe/calculate',
    getAuthHandler(['admin', 'vibeadmin']),
    async (request: any, reply: any) => {
      try {
        const result = await vibe.calculatePricing(request.body);

        if (!result.success) {
          reply.status(400).send({ error: result.error });
          return;
        }

        reply.send(result);
      } catch (error) {
        console.error('Error calculating pricing:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Calculate Tromp pricing (admin only)
  fastify.post(
    '/vibe/calculate-tromp',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const result = await vibe.calculateTrompPricing(request.body);

        if (!result.success) {
          reply.status(400).send({ error: result.error });
          return;
        }

        reply.send(result);
      } catch (error) {
        console.error('Error calculating Tromp pricing:', error);
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Vibe poster
  fastify.get('/vibe/poster/:posterId', async (request: any, reply: any) => {
    const posterId = request.params.posterId;
    const qrUrl = `${process.env['APP_DOMAIN']}/vibe/post/${posterId}`;
    await reply.view('poster_vibe.ejs', {
      posterId,
      qrUrl,
      brandColor: '#5FBFFF',
      brandSecondary: '#3F6FAF',
      brandAccent: '#E56581',
      appDomain: process.env['APP_DOMAIN'],
    });
  });
}
