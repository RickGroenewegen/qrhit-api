import { PrismaClient, CompanyList } from '@prisma/client'; // Added CompanyList
import * as auth from './auth';
import Logger from './logger';
import { color } from 'console-log-colors';
import fs from 'fs/promises'; // Added fs
import path from 'path'; // Added path
import Utils from './utils'; // Added Utils
import Mollie from './mollie';
import Discount from './discount';
import Data from './data';
import sharp from 'sharp'; // Import sharp
import Spotify from './spotify';
import Generator from './generator';
import Cache from './cache';
import Translation from './translation';
import Mail from './mail';
import PushoverClient from './pushover';

class Vibe {
  private static instance: Vibe;
  private translation = new Translation();
  public prisma = new PrismaClient();
  private mail = Mail.getInstance();
  private pushover = new PushoverClient();

  /**
   * Get all users that belong to a specific company.
   * @param companyId The company ID to get users for
   * @returns Object with success status and array of users or error
   */
  public async getUsersByCompany(companyId: number): Promise<{
    success: boolean;
    users?: any[];
    error?: string;
    test?: boolean;
  }> {
    try {
      if (!companyId || isNaN(companyId)) {
        return { success: false, error: 'Invalid company ID provided' };
      }

      // Check if company exists
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, test: true }, // Include test property
      });

      if (!company) {
        return { success: false, error: 'Company not found' };
      }

      // Get all users for this company
      const users = await this.prisma.user.findMany({
        where: { companyId },
        orderBy: { displayName: 'asc' },
        select: {
          id: true,
          userId: true,
          email: true,
          displayName: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Optionally, you could return the company test property as well
      return { success: true, users, test: company.test };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error getting users by company: ${error}`)
      );
      return { success: false, error: 'Error retrieving users for company' };
    }
  }

  /**
   * Handle the POST /vibe/companylist/create endpoint logic.
   * Accepts: fullname, company, email, captchaToken
   * - Verifies captcha
   * - Creates company (if not exists)
   * - Creates company list with same name
   * - Sends verification email to the user
   */
  public async handleCompanyListCreate(
    body: any,
    clientIp: string
  ): Promise<any> {
    const { fullname, company, email, captchaToken } = body || {};

    if (!fullname || !company || !email) {
      return {
        success: false,
        error: 'Missing required fields: fullname, company, email',
        statusCode: 400,
      };
    }

    // Captcha check (same as sendContactForm in mail.ts)
    const isHuman = await this.utils.verifyRecaptcha(captchaToken);
    if (!isHuman) {
      return {
        success: false,
        error: 'reCAPTCHA verification failed',
        statusCode: 400,
      };
    }

    try {
      // 1. Create the company (if not exists)
      const companyResult = await this.createCompany(company, false);
      if (!companyResult.success) {
        return {
          success: false,
          error: companyResult.error || 'Failed to create company',
          statusCode: 409,
        };
      }
      const companyId = companyResult.data.company.id;

      // 1b. Create the user for this company (admin)
      // Generate a random password for the user (for demo, use random string)
      const generatedPassword = Math.random().toString(36).slice(-10);

      // Hash the password using the same method as in auth.ts
      // (pbkdf2Sync with 10000 iterations, 64 bytes, sha512)
      const salt = auth.generateSalt();
      const hash = auth.hashPassword(generatedPassword, salt);

      // Find the 'companyadmin' user group (do not create if it doesn't exist)
      const companyAdminGroup = await this.prisma.userGroup.findUnique({
        where: { name: 'companyadmin' },
      });

      // Create the user (if not exists)
      let user = await this.prisma.user.findUnique({
        where: { email },
      });
      if (!user) {
        // Generate a hash for the user (required field)
        const userHash = require('crypto')
          .randomBytes(8)
          .toString('hex')
          .slice(0, 16);
        user = await this.prisma.user.create({
          data: {
            userId: email,
            email,
            displayName: fullname || email.split('@')[0],
            password: hash,
            salt: salt,
            hash: userHash,
            companyId: companyId,
            locale: 'nl',
            marketingEmails: false,
            sync: false,
          },
        });
      }

      // Add user to the companyadmin group (if not already and group exists)
      if (companyAdminGroup) {
        const userInGroup = await this.prisma.userInGroup.findFirst({
          where: {
            userId: user.id,
            groupId: companyAdminGroup.id,
          },
        });

        if (!userInGroup) {
          await this.prisma.userInGroup.create({
            data: {
              userId: user.id,
              groupId: companyAdminGroup.id,
            },
          });
        }
      }

      // 2. Create the company list with the same name
      // Use the company name as the list name and slug (slugify for URL safety)
      const slug = company
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 50);

      const listData = {
        name: company,
        slug,
        numberOfCards: 10,
        numberOfTracks: 10,
        // Optionally add description fields for all locales as empty string
      };

      const listResult = await this.createCompanyList(companyId, listData);

      if (!listResult.success) {
        return {
          success: false,
          error: listResult.error || 'Failed to create company list',
          statusCode: 409,
        };
      }

      // Use 'nl' as default locale for now, or allow override
      const locale = 'nl';

      // Construct the portal URL (example, adjust as needed)
      const portalUrl = `${process.env['FRONTEND_VOTING_URI']}/hitlist/${slug}`;
      const adminUrl = process.env['FRONTEND_VOTING_URI'];

      try {
        await this.mail.sendPortalWelcomeEmail(
          email,
          fullname,
          company,
          portalUrl,
          email, // Use email as username
          generatedPassword,
          locale,
          adminUrl // pass admin URL
        );
      } catch (err) {
        // Log but do not fail the endpoint if email fails
        this.logger.log(
          color.red.bold(
            `Failed to send portal welcome email to ${email}: ${err}`
          )
        );
      }

      // Send pushover notification for new company registration
      try {
        await this.pushover.sendMessage(
          {
            title: 'New company registered',
            message: `Company: ${company}\nContact: ${fullname} <${email}>`,
            sound: 'incoming',
          },
          clientIp
        );
      } catch (pushErr) {
        this.logger.log(
          color.red.bold(
            `Failed to send pushover notification for new company registration: ${pushErr}`
          )
        );
      }

      return {
        success: true,
        company: companyResult.data.company,
        list: listResult.data.list,
        portalWelcomeSent: true,
      };
    } catch (error) {
      return {
        success: false,
        error: 'Internal server error',
        statusCode: 500,
      };
    }
  }

  /**
   * Update all CompanyListSubmissionTrack records for a given listId,
   * changing trackId from sourceTrackId to destinationTrackId.
   * @param listId The company list ID
   * @param sourceTrackId The trackId to replace
   * @param destinationTrackId The new trackId to set
   * @returns Object with success status and count of updated records
   */
  public async replaceTrackInSubmissions(
    companyListId: number,
    sourceTrackId: number,
    destinationTrackId: number
  ): Promise<{ success: boolean; updatedCount?: number; error?: string }> {
    try {
      if (
        !companyListId ||
        isNaN(companyListId) ||
        !sourceTrackId ||
        isNaN(sourceTrackId) ||
        !destinationTrackId ||
        isNaN(destinationTrackId)
      ) {
        return { success: false, error: 'Invalid parameters provided' };
      }

      // Find all submission tracks for this companyListId and sourceTrackId
      const updated = await this.prisma.companyListSubmissionTrack.updateMany({
        where: {
          trackId: sourceTrackId,
          CompanyListSubmission: {
            companyListId: companyListId,
          },
        },
        data: {
          trackId: destinationTrackId,
        },
      });

      // Mark the company list for Spotify reload
      await this.markSpotifyForReload(companyListId);

      this.logger.log(
        color.blue.bold(
          `Corrected ${color.white.bold(
            updated.count
          )} votes for company list ${color.white.bold(
            companyListId
          )}. Moved votes from track ${color.white.bold(
            sourceTrackId
          )} to ${color.white.bold(destinationTrackId)}`
        )
      );

      return { success: true, updatedCount: updated.count };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error replacing track in submissions: ${error}`)
      );
      return { success: false, error: 'Error replacing track in submissions' };
    }
  }

  /**
   * Delete a submission by its ID.
   * @param submissionId The ID of the submission to delete.
   * @returns Object with success status and optional error.
   */
  public async deleteSubmission(
    submissionId: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!submissionId || isNaN(submissionId)) {
        return { success: false, error: 'Invalid submission ID provided' };
      }

      // Check if submission exists
      const submission = await this.prisma.companyListSubmission.findUnique({
        where: { id: submissionId },
      });

      if (!submission) {
        return { success: false, error: 'Submission not found' };
      }

      // Delete the submission
      await this.prisma.companyListSubmission.delete({
        where: { id: submissionId },
      });

      // Mark the company list for Spotify reload
      await this.markSpotifyForReload(submission.companyListId);

      this.logger.log(
        color.blue.bold(`Deleted submission: ${color.white.bold(submissionId)}`)
      );

      return { success: true };
    } catch (error) {
      this.logger.log(color.red.bold(`Error deleting submission: ${error}`));
      return { success: false, error: 'Error deleting submission' };
    }
  }

  /**
   * Helper to check if a submission belongs to a company.
   * @param submissionId The submission ID
   * @param companyId The company ID to check against
   * @returns Promise<boolean>
   */
  public async submissionBelongsToCompany(
    submissionId: number,
    companyId: number
  ): Promise<boolean> {
    if (
      !submissionId ||
      isNaN(submissionId) ||
      !companyId ||
      isNaN(companyId)
    ) {
      return false;
    }
    const submission = await this.prisma.companyListSubmission.findUnique({
      where: { id: submissionId },
      include: {
        CompanyList: {
          select: { companyId: true },
        },
      },
    });
    if (!submission || !submission.CompanyList) return false;
    return submission.CompanyList.companyId === companyId;
  }

  /**
   * Update a submission by its ID. Only cardName is editable for now.
   * @param submissionId The ID of the submission to update.
   * @param data Object with editable fields (currently only cardName).
   * @returns Object with success status and updated submission data or error.
   */
  public async updateSubmission(
    submissionId: number,
    data: { cardName: string }
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      if (!submissionId || isNaN(submissionId)) {
        return { success: false, error: 'Invalid submission ID provided' };
      }
      if (
        !data.cardName ||
        typeof data.cardName !== 'string' ||
        data.cardName.trim() === ''
      ) {
        return {
          success: false,
          error: 'cardName is required and must be a non-empty string',
        };
      }
      // Check if submission exists
      const submission = await this.prisma.companyListSubmission.findUnique({
        where: { id: submissionId },
      });
      if (!submission) {
        return { success: false, error: 'Submission not found' };
      }
      const updated = await this.prisma.companyListSubmission.update({
        where: { id: submissionId },
        data: { cardName: data.cardName },
      });

      // Mark the company list for Spotify reload
      await this.markSpotifyForReload(submission.companyListId);

      return { success: true, data: updated };
    } catch (error) {
      this.logger.log(color.red.bold(`Error updating submission: ${error}`));
      return { success: false, error: 'Error updating submission' };
    }
  }
  /**
   * Verify a playlist submission by its ID.
   * @param submissionId The ID of the submission to verify.
   * @returns Object with success status and updated submission or error.
   */
  public async verifySubmission(
    submissionId: number
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      if (!submissionId || isNaN(submissionId)) {
        return { success: false, error: 'Invalid submission ID provided' };
      }

      // Check if submission exists
      const submission = await this.prisma.companyListSubmission.findUnique({
        where: { id: submissionId },
      });

      if (!submission) {
        return { success: false, error: 'Submission not found' };
      }

      // Update the submission: set verified true, set verifiedAt, optionally update status
      const updated = await this.prisma.companyListSubmission.update({
        where: { id: submissionId },
        data: {
          verified: true,
          verifiedAt: new Date(),
          status: 'submitted', // Optionally set status to 'submitted'
        },
      });

      // Mark the company list for Spotify reload
      await this.markSpotifyForReload(submission.companyListId);

      this.logger.log(
        color.green.bold(
          `Verified submission: ${color.white.bold(submissionId)}`
        )
      );

      return { success: true, data: updated };
    } catch (error) {
      this.logger.log(color.red.bold(`Error verifying submission: ${error}`));
      return { success: false, error: 'Error verifying submission' };
    }
  }
  private logger = new Logger();
  private utils = new Utils();
  private discount = new Discount();
  private data = Data.getInstance();
  private spotify = Spotify.getInstance();
  private mollie = new Mollie();
  private generator = Generator.getInstance();
  private cache = Cache.getInstance();

  private constructor() {}

  public static getInstance(): Vibe {
    if (!Vibe.instance) {
      Vibe.instance = new Vibe();
    }
    return Vibe.instance;
  }

  /**
   * Get the state for a company
   * @param companyId The company ID to get state for
   * @param listId Optional company list ID to get specific list info
   * @returns Object containing company information and list questions
   */
  public async getState(listId?: number): Promise<any> {
    try {
      // Get questions and ranking for the list if listId is provided
      let questions: any[] = [];
      let companyList: any = null; // Use 'any' or a more specific type if defined
      let ranking: any[] = []; // Initialize ranking array
      let submissions: any[] = []; // New: submissions array

      // Import Translation here to avoid circular dependencies
      // eslint-disable-next-line @typescript-eslint/no-var-requires

      if (listId) {
        // Get all available locales from translationInstance
        const availableLocales = this.translation.allLocales;
        // Build the select object dynamically to include all description fields
        const selectObj: Record<string, boolean | object> = {
          id: true,
          companyId: true,
          name: true,
          slug: true,
          showNames: true,
          background: true,
          background2: true,
          spotifyRefreshRequired: true,
          playlistSource: true,
          totalSpotifyTracks: true,
          numberOfUncheckedTracks: true,
          playlistUrl: true,
          playlistUrlFull: true,
          qrColor: true,
          textColor: true,
          status: true,
          numberOfTracks: true,
          minimumNumberOfTracks: true,
          numberOfCards: true,
          startAt: true,
          endAt: true,
          votingBackground: true,
          votingLogo: true,
          Company: true,
          downloadLink: true,
          reviewLink: true,
          hideCircle: true,
          languages: true,
        };
        // Add all description fields for each locale
        for (const locale of availableLocales) {
          selectObj[`description_${locale}`] = true;
        }

        // Check if company list exists
        companyList = await this.prisma.companyList.findUnique({
          where: { id: listId },
          select: selectObj,
        });
        if (companyList) {
          // Get all questions for this list with their options
          const questionsWithOptions =
            await this.prisma.companyListQuestion.findMany({
              where: { companyListId: listId },
              orderBy: { createdAt: 'asc' },
              include: {
                CompanyListQuestionOptions: true,
              },
            });

          // Transform the questions to rename CompanyListQuestionOptions to options
          questions = questionsWithOptions.map((q) => ({
            ...q,
            options: q.CompanyListQuestionOptions,
            CompanyListQuestionOptions: undefined,
          }));

          // Get the ranking for this list
          const rankingResult = await this.getRanking(listId);
          if (rankingResult.success && rankingResult.data) {
            ranking = rankingResult.data.ranking; // Extract the ranking array
          } else {
            this.logger.log(
              color.yellow.bold(
                `Could not retrieve ranking for list ${color.white.bold(
                  companyList.name
                )}: ${rankingResult.error || 'No ranking data found'}`
              )
            );
            // Keep ranking as empty array if retrieval fails
          }

          // Parse languages property into array if present
          if (companyList.languages) {
            companyList.languages = companyList.languages
              .split(',')
              .map((lang: string) => lang.trim())
              .filter((lang: string) => !!lang);
          } else {
            companyList.languages = [];
          }

          // New: Get submissions for this list, including count of votes casted
          submissions = await this.prisma.companyListSubmission.findMany({
            where: { companyListId: listId },
            select: {
              id: true,
              firstname: true,
              lastname: true,
              cardName: true,
              email: true,
              status: true,
              verified: true,
              verifiedAt: true,
              locale: true,
              agreeToUseName: true,
              createdAt: true,
              _count: {
                select: { CompanyListSubmissionTrack: true },
              },
            },
            orderBy: { createdAt: 'desc' },
          });

          // Add a 'voteCount' property to each submission and remove _count
          submissions = submissions.map((submission: any) => {
            const { _count, ...rest } = submission;
            return {
              ...rest,
              voteCount: _count?.CompanyListSubmissionTrack || 0,
            };
          });
        } else {
          // If companyList is not found, return error early
          return { success: false, error: 'Company list not found' };
        }
      }

      // Return the state object with list info, questions, ranking, availableLocales, and submissions
      return {
        success: true,
        data: {
          questions,
          list: companyList, // companyList now includes numberOfUncheckedTracks and languages as array and all description_* fields
          ranking,
          availableLocales: this.translation.allLocales,
          submissions,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting vibe state: ${error}`));
      return { success: false, error: 'Error retrieving company state' };
    }
  }

  /**
   * Processes and saves an uploaded image file from a multipart request.
   * @param fileData The file data object from Fastify multipart (`request.parts()`).
   * @param listId The ID of the company list.
   * @param type The type of image ('background', 'background2', 'votingBackground', 'votingLogo').
   * @returns The generated filename or null if an error occurred or no file provided.
   */
  private async processAndSaveImage(
    fileData: any, // Expecting a file part object
    listId: number,
    type: 'background' | 'background2' | 'votingBackground' | 'votingLogo'
  ): Promise<string | null> {
    // Check if fileData exists and has a filename (indicating a file was uploaded)
    if (!fileData || !fileData.filename) {
      this.logger.log(color.yellow.bold(`No file provided for ${type}`));
      return null; // No file uploaded for this field
    }

    try {
      const backgroundsDir = path.join(
        process.env['PUBLIC_DIR'] as string,
        'companydata',
        'backgrounds'
      );
      await fs.mkdir(backgroundsDir, { recursive: true }); // Ensure directory exists

      // Determine file extension from the uploaded file's name
      const fileExtension =
        path.extname(fileData.filename).toLowerCase() || '.png'; // Default to png if no extension

      // Generate unique filename using utils.generateRandomString
      const uniqueId = this.utils.generateRandomString(32);
      // Ensure filename includes listId and type for clarity
      const actualFilename = `card_${type}_${listId}_${uniqueId}${fileExtension}`;
      const filePath = path.join(backgroundsDir, actualFilename);

      // Get file buffer from the file part
      const buffer = await fileData.toBuffer();

      // Write the file
      await fs.writeFile(filePath, buffer);

      this.logger.log(
        color.green.bold(
          `Card image saved successfully: ${color.white.bold(filePath)}`
        )
      );

      // Return only the filename for storage in DB
      return actualFilename;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error processing/saving card image ${type} for list ${listId}: ${color.white.bold(
            error
          )}`
        )
      );
      return null; // Indicate error
    }
  }

  /**
   * Get the list status progression order
   * @returns Array of status values in correct progression order
   */
  private getStatusProgression(): string[] {
    return [
      'new',
      'company',
      'questions',
      'box',
      'card',
      'playlist',
      'personalize',
    ];
  }

  /**
   * Update the list status based on progression
   * @param currentStatus Current status of the list
   * @param newStatus Desired new status
   * @returns The appropriate status to set
   */
  private getUpdatedStatus(currentStatus: string, newStatus: string): string {
    const progression = this.getStatusProgression();
    const currentIndex = progression.indexOf(currentStatus);
    const newIndex = progression.indexOf(newStatus);

    // If current status is not in progression, default to new status
    if (currentIndex === -1) return newStatus;

    // If new status is not in progression, keep current status
    if (newIndex === -1) return currentStatus;

    // Only move forward in progression, never backward
    return newIndex > currentIndex ? newStatus : currentStatus;
  }

  /**
   * Update company information
   * @param companyId The company ID to update
   * @param companyData The updated company data
   * @returns Object with success status and updated company data
   */
  public async updateCompany(
    companyId: number,
    companyData: any
  ): Promise<any> {
    try {
      if (!companyId) {
        return { success: false, error: 'No company ID provided' };
      }

      // Check if company exists
      const existingCompany = await this.prisma.company.findUnique({
        where: { id: companyId },
      });

      if (!existingCompany) {
        return { success: false, error: 'Company not found' };
      }

      // Validate the data
      const validFields = [
        'name',
        'address',
        'zipcode',
        'city',
        'contactphone',
        'contactemail',
        'test', // Allow updating the test property
      ];

      // Filter out invalid fields
      const validData: any = {};
      for (const key of Object.keys(companyData)) {
        if (validFields.includes(key)) {
          validData[key] = companyData[key];
        }
      }

      // Update the company
      const updatedCompany = await this.prisma.company.update({
        where: { id: companyId },
        data: validData,
      });

      // Update all company lists to 'company' status if they're in 'new' status
      await this.prisma.companyList.updateMany({
        where: {
          companyId: companyId,
          status: 'new',
        },
        data: {
          status: 'company',
        },
      });

      this.logger.log(
        color.green.bold(
          `Updated company ${color.white.bold(updatedCompany.name)}`
        )
      );

      return {
        success: true,
        data: {
          company: updatedCompany,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error updating company: ${error}`));
      return { success: false, error: 'Error updating company' };
    }
  }

  /**
   * Get all company lists for a specific company
   * @param companyId The company ID to get lists for
   * @returns Object containing company lists
   */
  public async getCompanyLists(companyId: number): Promise<any> {
    try {
      if (!companyId) {
        return { success: false, error: 'No company ID provided' };
      }

      // Check if company exists
      const existingCompany = await this.prisma.company.findUnique({
        where: { id: companyId },
      });

      if (!existingCompany) {
        return { success: false, error: 'Company not found' };
      }

      // Get all company lists for this company
      const companyLists = await this.prisma.companyList.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
      });

      return {
        success: true,
        data: {
          companyLists,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting company lists: ${error}`));
      return { success: false, error: 'Error retrieving company lists' };
    }
  }

  /**
   * Get all companies
   * @returns Object with success status and array of companies
   */
  public async getAllCompanies(): Promise<any> {
    try {
      // Fetch companies and include a count of their lists and the "test" property
      // Order: test=false first, then by name
      const companiesWithListCount = await this.prisma.company.findMany({
        orderBy: [
          { test: 'asc' }, // false (0) first, then true (1)
          { name: 'asc' },
        ],
        include: {
          _count: {
            select: { CompanyList: true },
          },
        },
      });

      // Map the result to add the numberOfLists property and ensure "test" is present
      const companies = companiesWithListCount.map((company) => ({
        ...company,
        numberOfLists: company._count.CompanyList, // Use the actual count
        test: company.test, // Ensure test property is present
        _count: undefined, // Remove the internal _count object
      }));

      return {
        success: true,
        data: {
          companies,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting all companies: ${error}`));
      return { success: false, error: 'Error retrieving companies' };
    }
  }

  /**
   * Create a new company
   * @param name The name of the company to create
   * @returns Object with success status and the newly created company
   */
  public async createCompany(
    name: string,
    test: boolean = false
  ): Promise<any> {
    try {
      if (!name || name.trim() === '') {
        return { success: false, error: 'Company name cannot be empty' };
      }

      // Check if company with the same name already exists (case-sensitive check is default for MySQL unless collation is CI)
      const existingCompany = await this.prisma.company.findFirst({
        where: { name: { equals: name.trim() } }, // Removed mode: 'insensitive', added trim()
      });

      if (existingCompany) {
        return {
          success: false,
          error: 'Company with this name already exists',
        };
      }

      const newCompany = await this.prisma.company.create({
        data: {
          name: name.trim(), // Trim whitespace
          test: test, // Store the test property
        },
      });

      this.logger.log(
        color.green.bold(
          `Created new company: ${color.white.bold(newCompany.name)} (ID: ${
            newCompany.id
          })`
        )
      );

      return {
        success: true,
        data: {
          company: newCompany,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error creating company: ${error}`));
      return { success: false, error: 'Error creating company' };
    }
  }

  /**
   * Delete a company if it has no associated lists
   * @param companyId The ID of the company to delete
   * @returns Object with success status
   */
  public async deleteCompany(companyId: number): Promise<any> {
    try {
      if (!companyId || isNaN(companyId)) {
        return { success: false, error: 'Invalid company ID provided' };
      }

      // Check if company exists and if it has any lists
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        include: {
          _count: {
            select: { CompanyList: true },
          },
        },
      });

      if (!company) {
        return { success: false, error: 'Company not found' };
      }

      if (company._count.CompanyList > 0) {
        return {
          success: false,
          error: 'Company cannot be deleted because it has associated lists',
        };
      }

      // Delete the company
      await this.prisma.company.delete({
        where: { id: companyId },
      });

      this.logger.log(
        color.red.bold(
          `Deleted company: ${color.white.bold(
            company.name
          )} (ID: ${companyId})`
        )
      );

      return { success: true };
    } catch (error) {
      this.logger.log(color.red.bold(`Error deleting company: ${error}`));
      return { success: false, error: 'Error deleting company' };
    }
  }

  /**
   * Create a new company list for a specific company
   * @param companyId The ID of the company to associate the list with
   * @param listData Object containing name, description, slug, numberOfCards, numberOfTracks
   * @returns Object with success status and the newly created list
   */
  public async createCompanyList(
    companyId: number,
    listData: {
      name: string;
      description_nl?: string;
      description_en?: string;
      description_de?: string;
      description_fr?: string;
      description_es?: string;
      description_it?: string;
      description_pt?: string;
      description_pl?: string;
      description_hin?: string;
      description_jp?: string;
      description_cn?: string;
      description_ru?: string;
      slug: string;
      numberOfCards: number;
      numberOfTracks: number;
      playlistSource?: string; // Added optional playlistSource
      playlistUrl?: string; // Added optional playlistUrl
    }
  ): Promise<any> {
    try {
      const {
        name,
        slug,
        numberOfCards,
        numberOfTracks,
        playlistSource,
        playlistUrl,
        // Remove hardcoded descriptions, will handle below
      } = listData;

      // Basic validation
      if (!companyId || isNaN(companyId)) {
        return { success: false, error: 'Ongeldig bedrijfs-ID opgegeven' };
      }
      if (
        !name ||
        !slug ||
        numberOfCards === undefined ||
        numberOfTracks === undefined
      ) {
        return {
          success: false,
          error: 'Verplichte velden voor de bedrijfslijst ontbreken',
        };
      }
      if (
        isNaN(numberOfCards) ||
        isNaN(numberOfTracks) ||
        numberOfCards < 0 ||
        numberOfTracks < 0
      ) {
        return {
          success: false,
          error: 'Ongeldig aantal voor kaarten of nummers',
        };
      }

      // Check if company exists
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
      });
      if (!company) {
        return { success: false, error: 'Bedrijf niet gevonden' };
      }

      // Check if slug is unique across all company lists
      const existingListWithSlug = await this.prisma.companyList.findFirst({
        where: {
          slug: slug, // Check slug globally
        },
      });
      if (existingListWithSlug) {
        return {
          success: false,
          error: 'Slug bestaat al. Kies een unieke slug.', // Updated error message
        };
      }

      // Build descriptions for all available locales
      const translationInstance = new (await import('./translation')).default();
      const descriptions: Record<string, string | undefined> = {};
      for (const locale of translationInstance.allLocales) {
        const descKey = `description_${locale}`;
        if ((listData as Record<string, any>)[descKey] !== undefined) {
          descriptions[descKey] = (listData as Record<string, any>)[descKey];
        }
      }

      // Create the new company list
      const newList = await this.prisma.companyList.create({
        data: {
          companyId: companyId,
          name: name,
          ...descriptions,
          slug: slug,
          numberOfCards: numberOfCards,
          numberOfTracks: numberOfTracks,
          playlistSource: playlistSource || 'voting', // Default to 'voting' if not provided
          playlistUrl: playlistUrl || null, // Set to null if not provided
          status: 'new', // Start with 'new' status
        },
      });

      this.logger.log(
        color.green.bold(
          `Created new list "${color.white.bold(
            newList.name
          )}" for company ${color.white.bold(company.name)}`
        )
      );

      return {
        success: true,
        data: {
          list: newList,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error creating company list: ${error}`));
      // Check for specific Prisma errors if needed, e.g., unique constraint violation
      if (
        (error as any).code === 'P2002' &&
        (error as any).meta?.target?.includes('slug')
      ) {
        // This specific Prisma error for unique constraint violation might still occur
        // if the database schema has a unique constraint on (companyId, slug) or just slug.
        // The check above should catch it, but this is a fallback.
        return {
          success: false,
          error: 'Slug bestaat al. Kies een unieke slug.', // Consistent error message
        };
      }
      return {
        success: false,
        error: 'Fout bij het aanmaken van de bedrijfslijst',
      };
    }
  }

  /**
   * Delete a specific company list if its status is 'new'
   * @param companyId The ID of the company the list belongs to
   * @param listId The ID of the list to delete
   * @returns Object with success status
   */
  public async deleteCompanyList(
    companyId: number,
    listId: number
  ): Promise<any> {
    try {
      if (!companyId || isNaN(companyId) || !listId || isNaN(listId)) {
        return { success: false, error: 'Invalid company or list ID provided' };
      }

      // Find the list to ensure it exists, belongs to the company, and has the correct status
      const list = await this.prisma.companyList.findUnique({
        where: { id: listId },
      });

      if (!list) {
        return { success: false, error: 'Company list not found' };
      }

      if (list.companyId !== companyId) {
        return {
          success: false,
          error: 'List does not belong to this company',
        };
      }

      if (list.status !== 'new') {
        return {
          success: false,
          error: 'List cannot be deleted because its status is not "new"',
        };
      }

      // Delete the list
      await this.prisma.companyList.delete({
        where: { id: listId },
      });

      this.logger.log(
        color.red.bold(
          `Deleted list "${color.white.bold(
            list.name
          )}" (ID: ${listId}) for company ID ${companyId}`
        )
      );

      return { success: true };
    } catch (error) {
      this.logger.log(color.red.bold(`Error deleting company list: ${error}`));
      return { success: false, error: 'Error deleting company list' };
    }
  }

  /**
   * Update an existing company list using multipart/form-data
   * @param companyId The ID of the company the list belongs to
   * @param listId The ID of the list to update
   * @param request The Fastify request object containing multipart data
   * @returns Object with success status and the updated list
   */
  public async updateCompanyList(
    companyId: number,
    listId: number,
    request: any // Changed parameter back to accept the request object
  ): Promise<any> {
    try {
      // Basic validation
      if (!companyId || isNaN(companyId) || !listId || isNaN(listId)) {
        return { success: false, error: 'Invalid company or list ID provided' };
      }

      // Find the list to ensure it exists and belongs to the company
      const list = await this.prisma.companyList.findUnique({
        where: { id: listId },
      });

      if (!list) {
        return { success: false, error: 'Company list not found' };
      }

      if (list.companyId !== companyId) {
        return {
          success: false,
          error: 'List does not belong to this company',
        };
      }

      // Prepare update data object
      const updateData: Partial<CompanyList> = {};
      const fields: { [key: string]: any } = {}; // Store non-file fields

      // Process multipart data from the request
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type === 'file') {
          // Process expected image files immediately
          if (part.fieldname === 'background') {
            // Store the result of processing the image
            const savedBackgroundFilename = await this.processAndSaveImage(
              part, // Pass the file part object directly
              listId,
              'background'
            );
            // Add to updateData only if successfully processed
            if (savedBackgroundFilename !== null) {
              updateData.background = savedBackgroundFilename;
            }
          } else if (part.fieldname === 'background2') {
            const savedBackground2Filename = await this.processAndSaveImage(
              part,
              listId,
              'background2'
            );
            if (savedBackground2Filename !== null) {
              updateData.background2 = savedBackground2Filename;
            }
          } else if (part.fieldname === 'votingBackground') {
            const savedVotingBackgroundFilename =
              await this.processAndSaveImage(part, listId, 'votingBackground');
            if (savedVotingBackgroundFilename !== null) {
              updateData.votingBackground = savedVotingBackgroundFilename;
            }
          } else if (part.fieldname === 'votingLogo') {
            const savedVotingLogoFilename = await this.processAndSaveImage(
              part,
              listId,
              'votingLogo'
            );
            if (savedVotingLogoFilename !== null) {
              updateData.votingLogo = savedVotingLogoFilename;
            }
          } else {
            // Drain any other unexpected file streams to prevent hanging

            try {
              await part.toBuffer(); // Consume the stream fully
            } catch (drainError) {
              // Decide if we should abort or continue
              // For now, we log and continue
            }
          }
        } else {
          // Handle regular fields - store them for later processing
          fields[part.fieldname] = part.value;
        }
      }

      // Add text and numeric fields from the collected 'fields' object
      if (fields.name !== undefined) updateData.name = String(fields.name);

      // Dynamically update all description fields for available locales
      const translationInstance = new (await import('./translation')).default();
      for (const locale of translationInstance.allLocales) {
        const descKey = `description_${locale}`;
        if ((fields as Record<string, any>)[descKey] !== undefined) {
          (updateData as Record<string, any>)[descKey] = String(
            (fields as Record<string, any>)[descKey]
          );
        }
      }

      if (fields.playlistSource !== undefined)
        updateData.playlistSource = String(fields.playlistSource);
      if (fields.playlistUrl !== undefined)
        updateData.playlistUrl = String(fields.playlistUrl);
      if (fields.qrColor !== undefined)
        updateData.qrColor = String(fields.qrColor);
      if (fields.textColor !== undefined)
        updateData.textColor = String(fields.textColor);

      // Handle languages field (comma separated string)
      if (fields.languages !== undefined) {
        // Store as a comma-separated string in the DB
        updateData.languages = String(fields.languages);
      }

      // Handle hideCircle boolean field
      if (fields.hideCircle !== undefined) {
        updateData.hideCircle = this.utils.parseBoolean(fields.hideCircle);
      }

      // Handle showNames boolean field
      if (fields.showNames !== undefined) {
        updateData.showNames = this.utils.parseBoolean(fields.showNames);
      }

      // Explicitly handle empty string values for background fields to set them to null
      if (fields.background === '') {
        updateData.background = null;
      }
      if (fields.background2 === '') {
        updateData.background2 = null;
      }

      if (fields.numberOfCards !== undefined) {
        const numCards = Number(fields.numberOfCards);
        if (!isNaN(numCards) && numCards >= 0) {
          updateData.numberOfCards = numCards;
        } else {
          this.logger.log(
            color.yellow.bold(
              `Invalid numberOfCards value provided: ${fields.numberOfCards}`
            )
          );
        }
      }
      if (fields.numberOfTracks !== undefined) {
        const numTracks = Number(fields.numberOfTracks);
        if (!isNaN(numTracks) && numTracks >= 0) {
          updateData.numberOfTracks = numTracks;
        } else {
          this.logger.log(
            color.yellow.bold(
              `Invalid numberOfTracks value provided: ${fields.numberOfTracks}`
            )
          );
        }
      }

      if (fields.minimumNumberOfTracks !== undefined) {
        if (String(fields.minimumNumberOfTracks).trim() === '') {
          updateData.minimumNumberOfTracks = null;
        } else {
          const minNumTracks = Number(fields.minimumNumberOfTracks);
          if (!isNaN(minNumTracks) && minNumTracks >= 0) {
            updateData.minimumNumberOfTracks = minNumTracks;
          } else {
            this.logger.log(
              color.yellow.bold(
                `Invalid minimumNumberOfTracks value provided: ${fields.minimumNumberOfTracks}`
              )
            );
            // Optionally, decide if an invalid non-empty string should also be null or ignored
            // For now, it's just logged and not added to updateData if invalid
          }
        }
      }

      // Update status if provided
      if (fields.status !== undefined) {
        // updateData.status = String(fields.status); // Status update logic might be handled elsewhere or based on progression
      }

      // Parse and validate startAt and endAt dates from fields
      if (fields.startAt !== undefined) {
        const startDateString = String(fields.startAt); // Ensure it's a string
        // Handle empty string or the literal string "null" as null
        if (
          startDateString === '' ||
          startDateString.toLowerCase() === 'null'
        ) {
          updateData.startAt = null;
        } else {
          const startDate = new Date(startDateString);
          // Check if Date object is valid (getTime() returns NaN for invalid dates)
          if (!isNaN(startDate.getTime())) {
            updateData.startAt = startDate;
          } else {
            // If parsing fails, set to null and log a warning
            updateData.startAt = null;
          }
        }
      }
      // If startAt was not provided at all (undefined), it won't be added to updateData, preserving existing value or DB default

      if (fields.endAt !== undefined) {
        const endDateString = String(fields.endAt); // Ensure it's a string
        // Handle empty string or the literal string "null" as null
        if (endDateString === '' || endDateString.toLowerCase() === 'null') {
          updateData.endAt = null;
        } else {
          const endDate = new Date(endDateString);
          // Check if Date object is valid
          if (!isNaN(endDate.getTime())) {
            updateData.endAt = endDate;
          } else {
            // If parsing fails, set to null and log a warning
            updateData.endAt = null;
          }
        }
      }
      // If endAt was not provided at all (undefined), it won't be added to updateData

      // Only update if there's something to change
      if (Object.keys(updateData).length === 0) {
        // Add an explicit check for list before accessing its properties
        if (!list) {
          // This case should theoretically not be reachable due to earlier checks
          this.logger.log(
            color.red.bold(
              `Error: list object became null/undefined unexpectedly before logging in updateCompanyList for listId: ${listId}`
            )
          );
          return {
            success: false,
            error: 'Internal error: List data became unavailable unexpectedly.',
          };
        }
        this.logger.log(
          color.yellow.bold(
            `No update data provided or processed for list ${color.white.bold(
              list.name
            )}`
          )
        );
        // Return current list data if nothing changed, but include any filenames processed
        // Note: updateData.background/background2 will only be set if processing was successful
        // If nothing changed, return the original list data, reflecting potential nulls if '' was sent
        return {
          success: true,
          data: {
            list, // Return the original list data
            backgroundFilename:
              'background' in updateData
                ? updateData.background
                : list.background,
            background2Filename:
              'background2' in updateData
                ? updateData.background2
                : list.background2,
            votingBackgroundFilename:
              'votingBackground' in updateData
                ? updateData.votingBackground
                : list.votingBackground,
            votingLogoFilename:
              'votingLogo' in updateData
                ? updateData.votingLogo
                : list.votingLogo,
          },
        };
      }

      // Update the company list
      const updatedList = await this.prisma.companyList.update({
        where: { id: listId },
        data: updateData,
      });

      // Invalidate cache for this list (by slug)
      await this.clearCompanyListCache(updatedList.slug);

      // Return the updated list and explicitly include the processed filenames
      return {
        success: true,
        data: {
          list: updatedList,
          // Reflect the final state, prioritizing updateData which might be null
          backgroundFilename:
            'background' in updateData
              ? updateData.background
              : updatedList.background,
          background2Filename:
            'background2' in updateData
              ? updateData.background2
              : updatedList.background2,
          votingBackgroundFilename:
            'votingBackground' in updateData
              ? updateData.votingBackground
              : updatedList.votingBackground,
          votingLogoFilename:
            'votingLogo' in updateData
              ? updateData.votingLogo
              : updatedList.votingLogo,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error updating company list: ${error}`));
      console.log(error);
      return { success: false, error: 'Error updating company list' };
    }
  }

  /**
   * Centralized cache clearing for a company list by slug.
   * @param slug The slug of the company list.
   */
  private async clearCompanyListCache(slug: string) {
    if (!slug) return;
    const cacheKey = `companyListByDomain:${slug}`;
    await this.cache.del(cacheKey);
  }

  /**
   * Mark a company list as requiring a Spotify refresh.
   * @param companyListId The ID of the company list.
   */
  private async markSpotifyForReload(companyListId: number) {
    if (!companyListId) return;
    await this.prisma.companyList.update({
      where: { id: companyListId },
      data: { spotifyRefreshRequired: true },
    });
  }

  /**
   * Adds TrackExtraInfo records for a given company list and playlist.
   * Always creates an entry for each unique track in the ranking.
   * If shownames is true, includes names for users who agreed to use their name.
   * Sets extraArtistAttribute to the position in the ranking (#1, #2, ...).
   * @param listId The ID of the company list.
   * @param playlistId The ID of the playlist.
   * @param shownames Whether to include names in extraNameAttribute.
   * @param ranking Optional: Array of trackIds in ranking order (for position).
   * @private
   */
  private async addTrackExtraInfo(
    listId: number,
    playlistId: number,
    shownames: boolean,
    ranking?: number[]
  ): Promise<void> {
    try {
      // Get all submission tracks for this list
      const allSubmissionTracks =
        await this.prisma.companyListSubmissionTrack.findMany({
          where: {
            CompanyListSubmission: {
              companyListId: listId,
            },
          },
          select: {
            trackId: true,
            CompanyListSubmission: {
              select: {
                firstname: true,
                lastname: true,
                cardName: true,
                agreeToUseName: true,
              },
            },
          },
        });

      // Aggregate submissions by trackId
      const trackSubmissionsMap: Map<
        number,
        {
          firstname: string | null;
          lastname: string | null;
          cardName: string | null;
          agreeToUseName: boolean | null;
        }[]
      > = new Map();
      for (const submission of allSubmissionTracks) {
        const trackId = submission.trackId;
        if (!trackSubmissionsMap.has(trackId)) {
          trackSubmissionsMap.set(trackId, []);
        }
        if (submission.CompanyListSubmission) {
          trackSubmissionsMap.get(trackId)!.push({
            firstname: submission.CompanyListSubmission.firstname,
            lastname: submission.CompanyListSubmission.lastname,
            cardName: submission.CompanyListSubmission.cardName,
            agreeToUseName:
              submission.CompanyListSubmission.agreeToUseName ?? false,
          });
        }
      }

      // If ranking is not provided, use all unique trackIds in any order
      const trackIdsInOrder =
        ranking && Array.isArray(ranking) && ranking.length > 0
          ? ranking
          : Array.from(trackSubmissionsMap.keys());

      const trackExtraInfoCreations = [];

      // Iterate through tracks in ranking order, assign position
      for (let i = 0; i < trackIdsInOrder.length; i++) {
        const trackId = trackIdsInOrder[i];
        const voters = trackSubmissionsMap.get(trackId) || [];

        // Only include names if shownames is true and user agreed
        let cardNames: string[] = [];
        if (shownames) {
          for (const voter of voters) {
            if (
              voter.agreeToUseName &&
              voter.cardName &&
              voter.cardName.length > 0
            ) {
              cardNames.push(voter.cardName.replace(/ /g, '&nbsp;'));
            }
          }
        }

        let extraNameAttributeValue = '';
        if (cardNames.length > 0) {
          extraNameAttributeValue = `${cardNames.join(' • ')}`;
        }

        // Position in ranking (1-based)
        const position = i + 1;
        const extraArtistAttributeValue = `#${position}`;

        trackExtraInfoCreations.push(
          this.prisma.trackExtraInfo.create({
            data: {
              playlistId: playlistId,
              trackId: trackId,
              extraNameAttribute: extraNameAttributeValue,
              extraArtistAttribute: extraArtistAttributeValue,
            },
          })
        );
      }

      if (trackExtraInfoCreations.length > 0) {
        await Promise.all(trackExtraInfoCreations);
        this.logger.log(
          color.blue.bold(
            `Successfully created ${color.white.bold(
              trackExtraInfoCreations.length
            )} extra track info records for tracks in playlist ${color.white.bold(
              playlistId
            )}.`
          )
        );
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error adding extra track info for list ${color.white.bold(
            listId
          )} and playlist ${color.white.bold(playlistId)}: ${color.white.bold(
            error
          )}`
        )
      );
      // Depending on requirements, you might want to re-throw the error
      // or handle it in a way that doesn't stop the parent process (e.g., generatePDF)
    }
  }

  public async generatePDF(
    listId: number,
    mollie: Mollie,
    clientIp: string
  ): Promise<any> {
    const price = 100;

    // Get the company list details
    let companyList = await this.prisma.companyList.findUnique({
      where: { id: listId },
      include: {
        Company: true,
      },
    });

    companyList = await this.prisma.companyList.findUnique({
      where: { id: listId },
      include: {
        Company: true,
      },
    });

    if (companyList) {
      // Remove the playlist and payment using the paymentId and playlistId on the companyList
      if (companyList.playlistId) {
        await this.prisma.playlist.delete({
          where: { id: companyList.playlistId },
        });
      }
      if (companyList.paymentId) {
        await this.prisma.payment.delete({
          where: { id: companyList.paymentId },
        });
      }
    }

    // Update the list status to 'generating_pdf' using prisma
    const updatedCompanyList = await this.prisma.companyList.update({
      where: { id: listId },
      data: { status: 'generating_pdf' },
    });

    // Invalidate cache for this list (by slug)
    await this.clearCompanyListCache(updatedCompanyList.slug);

    if (!companyList) {
      return { success: false, error: 'Company list not found' };
    }

    // playlist ID the the last part of the companyList.playlistUrl
    const playlistId = companyList.playlistUrl!.split('/').pop();

    const discount = await this.discount.createDiscountCode(price, '', '');

    let background = null;

    // Copy companyList.background to the public directory
    if (
      companyList &&
      companyList.background &&
      companyList.background.length > 0
    ) {
      const companyDataBackgroundPath = `${process.env['PUBLIC_DIR']}/companydata/backgrounds/${companyList.background}`;
      // Target directory is now public/background
      const backgroundTargetDir = `${process.env['PUBLIC_DIR']}/background/${companyList.background}`;

      try {
        // Copy the background file to the target directory
        await fs.copyFile(companyDataBackgroundPath, backgroundTargetDir);

        // --- Start Image Processing ---
        // Read the copied file
        const buffer = await fs.readFile(backgroundTargetDir);

        // Define the base sharp operation
        let sharpInstance = sharp(buffer).resize(1000, 1000, {
          fit: 'cover',
        });

        // Conditionally add the circle composite layer
        if (!companyList.hideCircle) {
          const circleSvg = `<svg width="1000" height="1000"><circle cx="500" cy="500" r="400" fill="white" stroke="white" stroke-width="10"/></svg>`;
          sharpInstance = sharpInstance.composite([
            {
              input: Buffer.from(circleSvg),
              blend: 'over', // Or appropriate blend mode if needed
            },
          ]);
        }

        // Convert to PNG and get the processed buffer
        const processedBuffer = await sharpInstance
          .png({ compressionLevel: 9, quality: 90 })
          .toBuffer();

        // Overwrite the file in the target directory with the processed image
        await fs.writeFile(backgroundTargetDir, processedBuffer);

        this.logger.log(
          color.blue.bold(
            `Processed background image for list ${color.white.bold(
              listId
            )}: ${color.white.bold(backgroundTargetDir)}`
          )
        );
        // --- End Image Processing ---

        // Get the filename (already correct)
        background = companyList.background;
      } catch (error) {
        this.logger.log(
          color.red.bold(
            `Error copying or processing background for list ${color.white.bold(
              listId
            )}: ${color.white.bold(error)}`
          )
        );
        // Decide how to handle the error - maybe proceed without background?
        background = null; // Set background to null if processing fails
      }
    }

    const items = [
      {
        productType: 'cards',
        playlistId: playlistId,
        playlistName: companyList.name,
        numberOfTracks: companyList.numberOfCards,
        hideCircle: companyList.hideCircle,
        hideDomain: true,
        qrColor: companyList.qrColor,
        amount: 1,
        price: price,
        type: 'physical',
        subType: 'none',
        background,
        image: '',
        doubleSided: false,
        eco: false,
        isSlug: false,
      },
    ];

    const discounts = [
      { code: discount.code, amountLeft: price, fullAmount: price },
    ];

    const paymentParams = {
      user: { userId: null, email: null, displayName: null },
      locale: 'en',
      refreshPlaylists: [],
      onzevibe: true,
      cart: { items, discounts },
      extraOrderData: {
        fullname: 'OnzeVibe',
        email: 'info@onzevibe.nl',
        address: 'Prinsenhof',
        housenumber: '1',
        city: 'Sassenheim',
        zipcode: '2171XZ',
        countrycode: 'NL',
        price: 0,
        shipping: 0,
        total: 0,
        taxRate: 21,
        taxRateShipping: 21,
        agreeNoRefund: true,
        agreeTerms: true,
        marketingEmails: false,
        differentInvoiceAddress: false,
        invoiceAddress: '',
        invoiceHousenumber: '',
        invoiceCity: '',
        invoiceZipcode: '',
        invoiceCountrycode: '',
        orderType: 'physical',
        vibe: true,
      },
    };

    this.logger.log(
      color.blue.bold(
        `Started PDF generation for list ${color.white.bold(
          companyList.name
        )} (ID: ${color.white.bold(listId)})`
      )
    );

    const result = await mollie.getPaymentUri(
      paymentParams,
      clientIp,
      true,
      true
    );

    const userId = result.data.userId;

    // Get the user from db
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    // Get the playlist using the playlistId
    const playlist = await this.prisma.playlist.findUnique({
      where: { playlistId },
    });

    if (playlist) {
      // Always add extra track info, passing showNames as a parameter and ranking for position
      this.logger.log(
        color.blue.bold(
          `Adding extra track info for company list ${color.white.bold(
            companyList.name
          )} (showNames: ${companyList.showNames ? 'true' : 'false'})`
        )
      );

      // Get ranking for this list to determine order/position
      let rankingTrackIds: number[] = [];
      try {
        const rankingResult = await this.getRanking(listId);
        if (
          rankingResult.success &&
          rankingResult.data &&
          Array.isArray(rankingResult.data.ranking)
        ) {
          rankingTrackIds = rankingResult.data.ranking.map(
            (track: any) => track.id
          );
        }
      } catch (e) {
        this.logger.log(
          color.yellow.bold(
            `Could not retrieve ranking for extra track info: ${e}`
          )
        );
      }

      await this.addTrackExtraInfo(
        listId,
        playlist.id,
        !!companyList.showNames,
        rankingTrackIds
      );

      await this.mollie.clearPDFs(result.data.paymentId);
      this.generator.generate(
        result.data.paymentId,
        clientIp,
        '',
        this.mollie,
        true, // Force finalize
        true
      );

      const payment = await this.mollie.getPayment(result.data.paymentId);

      const trackCountFull = await this.prisma.playlistHasTrack.count({
        where: {
          playlistId: playlist.id,
        },
      });

      // Count the number of tracks in the playlist with manuallyChecked = false
      const trackCountUnchecked = await this.prisma.playlistHasTrack.count({
        where: {
          playlistId: playlist.id,
          track: {
            year: { gt: 0 },
            manuallyChecked: false,
          },
        },
      });

      // Update the company list with the playlistId
      await this.prisma.companyList.update({
        where: { id: listId },
        data: {
          playlistId: playlist.id,
          paymentId: payment.id,
          numberOfUncheckedTracks: trackCountUnchecked,
          totalSpotifyTracks: trackCountFull,
        },
      });
    }

    if (user && companyList) {
      const downloadLink = `${process.env['API_URI']}/download/${result.data.paymentId}/${user.hash}/${playlistId}/printer`;
      const reviewLink = `${process.env['FRONTEND_URI']}/usersuggestions/${result.data.paymentId}/${user.hash}/${playlistId}/0`;

      // Update the list status to 'generating_pdf' using prisma
      const finalizedList = await this.prisma.companyList.update({
        where: { id: listId },
        data: { status: 'pdf_complete', downloadLink, reviewLink },
      });

      // Invalidate cache for this list (by slug)
      await this.clearCompanyListCache(finalizedList.slug);

      this.logger.log(
        color.blue.bold(
          `PDF generation complete for list ${color.white.bold(
            companyList.name
          )} (ID: ${color.white.bold(listId)})`
        )
      );
    }
  }

  /**
   * Calculate the ranking for a company list based on verified submissions.
   * @param listId The ID of the company list to rank.
   * @returns Object with success status and the ranked list of tracks.
   */
  public async getRanking(
    listId: number
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      if (!listId || isNaN(listId)) {
        return { success: false, error: 'Invalid list ID provided' };
      }

      // 1. Get the Company List details, including numberOfTracks and numberOfCards
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: listId },
        select: {
          id: true,
          name: true,
          numberOfTracks: true,
          numberOfCards: true, // Fetch numberOfCards
        },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      const maxPoints = companyList.numberOfTracks;
      if (maxPoints <= 0) {
        return {
          success: false,
          error: 'List has zero or negative numberOfTracks, cannot rank.',
        };
      }

      // 2. Get all verified submissions for this list
      const verifiedSubmissions =
        await this.prisma.companyListSubmission.findMany({
          where: {
            companyListId: listId,
            verified: true, // Only consider verified submissions
          },
          select: {
            id: true,
            firstname: true,
            lastname: true,
            agreeToUseName: true, // <-- Add this field
            createdAt: true,
            CompanyListSubmissionTrack: {
              // Fetch associated tracks ordered by position, and createdAt with the first
              orderBy: { position: 'asc' },
              select: {
                trackId: true,
                position: true,
              },
            },
          },
        });

      if (verifiedSubmissions.length === 0) {
        return { success: true, data: { list: companyList, ranking: [] } }; // Return empty ranking
      }

      // 3. Calculate points, count votes, collect voter objects, and track first vote time for each track
      const trackScores: { [trackId: number]: number } = {};
      const trackVoteCounts: { [trackId: number]: number } = {}; // To store vote counts
      const trackVotersMap: {
        [trackId: number]: { name: string; agreeToUseName: boolean }[];
      } = {}; // To store voter objects
      const trackFirstVoteTime: { [trackId: number]: Date } = {}; // To store first vote time

      for (const submission of verifiedSubmissions) {
        const voterName = `${submission.firstname || ''} ${
          submission.lastname || ''
        }`.trim(); // Construct full name, trim whitespace test
        const agreeToUseName = !!submission.agreeToUseName;

        for (const submissionTrack of submission.CompanyListSubmissionTrack) {
          // Increment vote count for this track
          trackVoteCounts[submissionTrack.trackId] =
            (trackVoteCounts[submissionTrack.trackId] || 0) + 1;

          // Add voter object
          if (!trackVotersMap[submissionTrack.trackId]) {
            trackVotersMap[submissionTrack.trackId] = [];
          }
          // Add object only if name is not empty
          if (voterName) {
            trackVotersMap[submissionTrack.trackId].push({
              name: voterName,
              agreeToUseName,
            });
          }

          // Points = maxPoints - position + 1
          // Example: maxPoints=5 -> pos 1 gets 5, pos 2 gets 4, ..., pos 5 gets 1
          const points = maxPoints - submissionTrack.position + 1;

          if (points > 0) {
            // Ensure only valid positions contribute points
            trackScores[submissionTrack.trackId] =
              (trackScores[submissionTrack.trackId] || 0) + points;
          }

          // Track the first vote time for each track
          if (!trackFirstVoteTime[submissionTrack.trackId]) {
            // Use the createdAt of the submission as the time of the first vote for this track
            // If createdAt is not available, fallback to current time
            // @ts-ignore
            const createdAt = submission.createdAt
              ? new Date(submission.createdAt)
              : new Date();
            trackFirstVoteTime[submissionTrack.trackId] = createdAt;
          }
        }
      }

      // 4. Get track details for the ranked tracks
      const trackIds = Object.keys(trackScores).map(Number);
      const tracks = await this.prisma.track.findMany({
        where: {
          id: { in: trackIds },
        },
        select: {
          id: true,
          trackId: true,
          name: true,
          manuallyChecked: true,
          artist: true,
          year: true,
          spotifyLink: true,
          youtubeLink: true,
        },
      });

      // 5. Combine track details with scores and sort (with tiebreaker: first vote wins)
      const rankedTracks = tracks
        .map((track) => ({
          ...track,
          score: trackScores[track.id] || 0, // Default score to 0 if somehow missing
          voteCount: trackVoteCounts[track.id] || 0, // Add vote count, default to 0
          voters: trackVotersMap[track.id] || [], // Add voters array of objects, default to empty
          firstVoteTime: trackFirstVoteTime[track.id] || new Date(0), // Add first vote time for tiebreaker
        }))
        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score; // Sort descending by score
          }
          // Tie-break: track with earliest first vote wins
          return a.firstVoteTime.getTime() - b.firstVoteTime.getTime();
        })
        // Add the 'withinLimit' property based on the index and numberOfCards
        .map((track, index) => ({
          ...track,
          withinLimit: index < companyList.numberOfCards,
        }));

      return {
        success: true,
        data: {
          list: companyList,
          ranking: rankedTracks,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error calculating ranking: ${error}`));
      return { success: false, error: 'Error calculating list ranking' };
    }
  }

  public async finalizeList(companyListId: number): Promise<any> {
    try {
      // Get the company list
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: companyListId },
        include: { Company: true },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      // Get all verified submissions for this company list
      const submissions = await this.prisma.companyListSubmission.findMany({
        where: {
          companyListId: companyListId,
          verified: true,
          status: 'submitted',
        },
        orderBy: { createdAt: 'asc' },
        include: {
          CompanyListSubmissionTrack: {
            include: {
              Track: true,
            },
            orderBy: { position: 'asc' },
          },
        },
      });

      // --- Use Vibe's getRanking method ---
      const rankingResult = await this.getRanking(companyListId);

      if (!rankingResult.success || !rankingResult.data) {
        this.logger.log(
          color.red.bold(
            `Failed to get ranking for list ${companyListId}: ${rankingResult.error}`
          )
        );
        return {
          success: false,
          error: `Failed to calculate ranking: ${rankingResult.error}`,
        };
      }

      const allRankedTracks = rankingResult.data.ranking; // This is already sorted by score
      const totalSubmissionsCount = submissions.length; // Keep the count of submissions

      if (allRankedTracks.length === 0) {
        this.logger.log(
          color.yellow.bold(
            `No tracks found in ranking for list ${companyListId}.`
          )
        );
        // Optionally update status or handle differently
        // For now, proceed to potentially create empty playlists or return success with empty data
      }

      // Use numberOfCards from companyList
      const maxTracks = companyList.numberOfCards;

      // Filter the ranked tracks to get the top ones based on numberOfCards
      // The 'withinLimit' flag from getRanking already tells us this.
      const topTracks = allRankedTracks.filter(
        (track: any) => track.withinLimit
      );

      // If maxTracks was 0 or invalid in the DB, getRanking might not set withinLimit correctly.
      // As a fallback, slice if needed, though relying on withinLimit is preferred.
      if (
        topTracks.length === 0 &&
        maxTracks > 0 &&
        allRankedTracks.length > 0
      ) {
        this.logger.log(
          color.yellow.bold(
            `Fallback: Slicing top ${maxTracks} tracks as 'withinLimit' was not set.`
          )
        );
        // Ensure we don't try to slice more than available tracks
        const actualSlice = Math.min(maxTracks, allRankedTracks.length);
        // Reassign topTracks based on slice
        // Note: This fallback might indicate an issue in getRanking's withinLimit logic if maxTracks is valid.
        // topTracks = allRankedTracks.slice(0, actualSlice);
        // Let's stick to the withinLimit flag for consistency for now. If it's empty, it's empty.
      }

      this.logger.log(
        color.blue.bold(
          `Creating playlist for company ${color.white.bold(
            companyList.Company.name
          )} with ${color.white.bold(topTracks.length)}`
        )
      );

      // --- Create/Update Limited Playlist ---
      const limitedPlaylistResult = await this.createPlaylist(
        companyList.Company.name,
        companyList.name,
        topTracks.map((track: any) => track.trackId)
      );

      // --- Update CompanyList with Limited Playlist URL ---
      if (
        limitedPlaylistResult.success &&
        limitedPlaylistResult.data?.playlistUrl
      ) {
        try {
          await this.prisma.companyList.update({
            where: { id: companyListId },
            data: { playlistUrl: limitedPlaylistResult.data.playlistUrl }, // Update the standard playlistUrl field
          });
        } catch (dbError) {
          this.logger.log(
            color.red.bold(
              `Failed to update playlistUrl for CompanyList ID ${companyListId}: ${dbError}`
            )
          );
          // Decide if this should be a critical error or just logged
        }
      } else {
        this.logger.log(
          color.yellow.bold(
            `Skipping update of playlistUrl for CompanyList ID ${companyListId} due to limited playlist creation/update failure.`
          )
        );
      }
      // --- End Update ---

      // --- Create/Update Full Playlist ---
      const fullPlaylistName = `${companyList.name} (FULL)`;
      const fullPlaylistResult = await this.createPlaylist(
        companyList.Company.name,
        fullPlaylistName, // Name with suffix
        allRankedTracks.map(
          (track: any) => track.spotifyLink!.split('/').pop()!
        ) // All ranked tracks
      );

      // --- Update CompanyList with Full Playlist URL ---
      if (fullPlaylistResult.success && fullPlaylistResult.data?.playlistUrl) {
        try {
          await this.prisma.companyList.update({
            where: { id: companyListId },
            data: { playlistUrlFull: fullPlaylistResult.data.playlistUrl },
          });
        } catch (dbError) {
          this.logger.log(
            color.red.bold(
              `Failed to update playlistUrlFull for CompanyList ID ${companyListId}: ${dbError}`
            )
          );
          // Decide if this should be a critical error or just logged
        }
      } else {
        this.logger.log(
          color.yellow.bold(
            `Skipping update of playlistUrlFull for CompanyList ID ${companyListId} due to playlist creation/update failure.`
          )
        );
      }

      // Update the list status to:  spotify_list_generated
      const updatedSpotifyList = await this.prisma.companyList.update({
        where: { id: companyListId },
        data: {
          status: 'spotify_list_generated',
          spotifyRefreshRequired: false,
        },
      });

      // Invalidate cache for this list (by slug)
      await this.clearCompanyListCache(updatedSpotifyList.slug);

      // --- End Update ---

      return {
        success: true,
        data: {
          companyName: companyList.Company.name,
          companyListName: companyList.name,
          totalSubmissions: totalSubmissionsCount, // Use the stored count
          // Map the topTracks (those within limit) based on the ranking result structure
          tracks: topTracks.map((track: any, index: number) => ({
            position: index + 1, // Position based on the final sorted limited list
            trackId: track.id, // DB track ID
            spotifyTrackId: track.spotifyLink!.split('/').pop()!, // Extract Spotify ID
            artist: track.artist,
            title: track.name, // Field name is 'name' in Track model
            score: track.score, // Include the score from ranking
            voteCount: track.voteCount, // Include the vote count from ranking
          })),
          // Include results for both playlists
          playlistLimited: limitedPlaylistResult.success
            ? limitedPlaylistResult.data
            : { error: limitedPlaylistResult.error }, // Include error if failed
          playlistFull: fullPlaylistResult.success
            ? fullPlaylistResult.data
            : { error: fullPlaylistResult.error }, // Include error if failed
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error finalizing list: ${error}`));
      return { success: false, error: 'Error finalizing list' };
    }
  }

  /**
   * Creates a Spotify playlist with the given tracks
   * @param companyName The name of the company
   * @param listName The name of the list
   * @param trackIds Array of Spotify track IDs to add to the playlist
   * @returns Object with success status and playlist data
   */
  public async createPlaylist(
    companyName: string,
    listName: string,
    trackIds: string[]
  ): Promise<any> {
    try {
      if (!trackIds || trackIds.length === 0) {
        return { success: false, error: 'No tracks provided' };
      }

      // Construct the playlist name
      const playlistName = `${companyName} - ${listName}`;

      // Call the public method on the Spotify instance
      // This method now handles token acquisition and API calls internally.
      const result = await this.spotify.createOrUpdatePlaylist(
        playlistName,
        trackIds
      );

      // Handle the result
      if (result.success) {
        // Return the success data directly
        return {
          success: true,
          data: result.data, // Contains playlistId, playlistUrl, playlistName
        };
      }
      return result;
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error creating Spotify playlist: ${error}`)
      );
      return { success: false, error: 'Error creating Spotify playlist' };
    }
  }
}

export default Vibe;
