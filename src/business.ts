import { DELIVERY_FIELDS, effectiveDeliveryAddress } from './deliveryAddress';
import { CompanyList } from '@prisma/client';
import { resolveVatRegion } from './services/vat';
import * as auth from './auth';
import crypto from 'crypto';
import Logger from './logger';
import { color } from 'console-log-colors';
import fs from 'fs/promises'; // Added fs
import path from 'path'; // Added path
import Utils from './utils'; // Added Utils
import Spotify from './spotify';
import Cache from './cache';
import Translation from './translation';
import PrismaInstance from './prisma';
import {
  ListVariant,
  PaymentOption,
  PaymentAmounts,
  ListPricing,
  ListPricingTotals,
  SHIPPING_EXTRA_KEY,
  listPricingFromCalculation,
  listPricingTotals,
  listPrinterVariant,
  paymentAmounts,
  variantCalculationColumn,
} from './listPricing';
import {
  estimateBusinessShipping,
  shippingExtraKeyVars,
  shippingLineText,
} from './businessShipping';

// Card backgrounds and the voting page's logo and background (processAndSaveImage).
const UPLOAD_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

class Business {
  private static instance: Business;
  private translation = new Translation();
  public prisma = PrismaInstance.getInstance();

  /**
   * Get all users that belong to a specific company.
   * @param companyId The company ID to get users for
   * @returns Object with success status and array of users or error
   */
  public async getUsersByCompany(companyId: number): Promise<{
    success: boolean;
    users?: any[];
    error?: string;
  }> {
    try {
      if (!companyId || isNaN(companyId)) {
        return { success: false, error: 'Invalid company ID provided' };
      }

      // Check if company exists
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true },
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
          phone: true,
          locale: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return { success: true, users };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error getting users by company: ${error}`)
      );
      return { success: false, error: 'Error retrieving users for company' };
    }
  }

  /**
   * The user behind a lead from the public /business form:
   * created when the e-mail is new, otherwise adopted as the company's
   * contact when it has no company yet. Also puts it in its groups.
   */
  public async upsertLeadUser(lead: {
    email: string;
    fullname?: string;
    phone?: string;
    companyId: number;
    locale: string;
    password: string;
    marketingEmails?: boolean;
    isQRVote?: boolean;
  }): Promise<any> {
    const { email, fullname, phone, companyId, isQRVote } = lead;

    // Hash the password using the same method as in auth.ts
    // (pbkdf2Sync with 10000 iterations, 64 bytes, sha512)
    const salt = auth.generateSalt();
    const hash = auth.hashPassword(lead.password, salt);

    // Find the appropriate user group based on qrvote flag
    const userGroupName = isQRVote ? 'qrvoteadmin' : 'companyadmin';
    const userGroup = await this.prisma.userGroup.findUnique({
      where: { name: userGroupName },
    });

    // Create the user (if not exists)
    let user = await this.prisma.user.findUnique({
      where: { email },
    });
    if (!user) {
      // Generate a hash for the user (required field)
      const userHash = crypto.randomBytes(8).toString('hex').slice(0, 16);

      // For QRVote users, generate verification hash and set verified to false
      // For regular users, set verified to true with current date
      let verificationHash: string | null = null;
      let verified = true;
      let verifiedAt: Date | null = new Date();

      if (isQRVote) {
        verificationHash = crypto.randomBytes(16).toString('hex');
        verified = false;
        verifiedAt = null;
      }

      user = await this.prisma.user.create({
        data: {
          userId: email,
          email,
          displayName: fullname || email.split('@')[0],
          phone: phone || null,
          password: hash,
          salt: salt,
          hash: userHash,
          companyId: companyId,
          locale: lead.locale,
          marketingEmails: !!lead.marketingEmails,
          sync: false,
          verificationHash: verificationHash,
          verified: verified,
          verifiedAt: verifiedAt,
        },
      });
    } else {
      // User already exists, update with verification hash if QRVote
      if (isQRVote) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            verificationHash: crypto.randomBytes(16).toString('hex'),
            verified: false,
            verifiedAt: null,
          },
        });
      }

      // If this unaffiliated user submitted a business intake, adopt them
      // as the contact for the newly created company. Never overwrite an
      // existing companyId — that would move someone else's user.
      const mergePatch: any = {};
      if (user.companyId == null) {
        mergePatch.companyId = companyId;
      }
      if (phone && !user.phone) {
        mergePatch.phone = phone;
      }
      if (Object.keys(mergePatch).length > 0) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: mergePatch,
        });
      }
    }

    // Add user to the appropriate group using the helper function
    if (userGroup) {
      await this.ensureUserInGroup(user.id, userGroupName);
    }
    await this.ensureUserInGroup(user.id, 'users');

    return user;
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
  private spotify = Spotify.getInstance();
  private cache = Cache.getInstance();

  private constructor() {}

  /**
   * Ensures a usergroup exists and connects a user to it
   * @param userId The user's database ID
   * @param groupName The name of the usergroup to connect the user to
   */
  private async ensureUserInGroup(
    userId: number,
    groupName: string
  ): Promise<void> {
    try {
      // First, ensure the usergroup exists
      let userGroup = await this.prisma.userGroup.findUnique({
        where: { name: groupName },
      });

      if (!userGroup) {
        userGroup = await this.prisma.userGroup.create({
          data: { name: groupName },
        });
      }

      // Check if user is already in the group
      const existingConnection = await this.prisma.userInGroup.findFirst({
        where: {
          userId: userId,
          groupId: userGroup.id,
        },
      });

      // If not already connected, create the connection
      if (!existingConnection) {
        await this.prisma.userInGroup.create({
          data: {
            userId: userId,
            groupId: userGroup.id,
          },
        });
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error ensuring user is in ${groupName} group: ${error}`)
      );
      // Don't throw here to avoid breaking the registration process
    }
  }

  public static getInstance(): Business {
    if (!Business.instance) {
      Business.instance = new Business();
    }
    return Business.instance;
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
          numberOfBoxes: true,
          printer: true,
          startAt: true,
          endAt: true,
          votingBackground: true,
          votingLogo: true,
          buttonBackgroundColor: true,
          buttonTextColor: true,
          qrvote: true,
          Company: true,
          downloadLink: true,
          reviewLink: true,
          hideCircle: true,
          languages: true,
          forceTemplate: true,
          addBirthdayNumber1: true,
          hideBirthdayNumber1: true,
          // Delivery: the toggle and the list's own address (src/deliveryAddress.ts)
          useCompanyDeliveryAddress: true,
          ...Object.fromEntries(DELIVERY_FIELDS.map((f) => [f, true])),
          desiredDeliveryDate: true,
          deliveryAsap: true,
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
              birthDate: true,
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
      this.logger.log(color.red.bold(`Error getting list state: ${error}`));
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

      // The file lands in the public folder as it is, so only raster images:
      // an .html or .svg there would run script on the API's domain.
      if (!UPLOAD_IMAGE_EXTENSIONS.includes(fileExtension)) {
        await fileData.toBuffer(); // drain the stream so the request can finish
        this.logger.log(
          color.yellow.bold(
            `Refused ${type} upload with extension ${color.white.bold(fileExtension)} for list ${listId}`
          )
        );
        return null;
      }

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
        'followUp',
        'onlyForAdmin',
        'excludeFromMailing',
        'address',
        'housenumber',
        'city',
        'zipcode',
        'countrycode',
        'contact',
        'contactemail',
        'contactphone',
        'locale',
        'message',
        'calculation',
        'calculationTromp',
        'calculationSchneider',
        ...DELIVERY_FIELDS,
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
   * @param userGroups Optional array of user groups to filter companies (admin sees all)
   * @returns Object with success status and array of companies
   */
  public async getAllCompanies(userGroups?: string[]): Promise<any> {
    try {
      // Check if user is admin
      const isAdmin = userGroups?.includes('admin');

      // Fetch companies by name with a count of their lists
      // Filter out onlyForAdmin companies for non-admin users
      const companiesWithListCount = await this.prisma.company.findMany({
        where: isAdmin ? {} : { onlyForAdmin: false },
        orderBy: { name: 'asc' },
        include: {
          _count: {
            select: { CompanyList: true },
          },
        },
      });

      // Map the result to add the numberOfLists property
      const companies = companiesWithListCount.map((company) => ({
        ...company,
        numberOfLists: company._count.CompanyList, // Use the actual count
        _count: undefined, // Remove the internal _count object
        // Derived server-side so the frontend never re-implements the
        // legacy free-text country normalization
        vatRegion: resolveVatRegion(company.countrycode),
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
  public async createCompany(companyData: {
    name: string;
    followUp?: boolean;
    onlyForAdmin?: boolean;
    address?: string;
    housenumber?: string;
    city?: string;
    zipcode?: string;
    countrycode?: string;
    contact?: string;
    contactemail?: string;
    contactphone?: string;
    locale?: string;
    message?: string;
  }): Promise<any> {
    try {
      if (!companyData.name || companyData.name.trim() === '') {
        return { success: false, error: 'Company name cannot be empty' };
      }

      // Check if company with the same name already exists (case-sensitive check is default for MySQL unless collation is CI)
      const existingCompany = await this.prisma.company.findFirst({
        where: { name: { equals: companyData.name.trim() } }, // Removed mode: 'insensitive', added trim()
      });

      if (existingCompany) {
        return {
          success: false,
          error: 'Company with this name already exists',
        };
      }

      const newCompany = await this.prisma.company.create({
        data: {
          name: companyData.name.trim(), // Trim whitespace
          followUp: companyData.followUp || false,
          onlyForAdmin: companyData.onlyForAdmin || false,
          address: companyData.address,
          housenumber: companyData.housenumber,
          city: companyData.city,
          zipcode: companyData.zipcode,
          countrycode: companyData.countrycode,
          contact: companyData.contact,
          contactemail: companyData.contactemail,
          contactphone: companyData.contactphone,
          locale: companyData.locale || 'nl',
          message: companyData.message,
        },
      });

      this.logger.log(
        color.green.bold(
          `Created new company: ${color.white.bold(newCompany.name)} (ID: ${
            newCompany.id
          })`
        )
      );

      // Automatically convert the contact person into a contact user
      // connected to this company (companyadmin group).
      const contactEmail = companyData.contactemail?.trim();
      if (contactEmail) {
        try {
          const existingUser = await this.prisma.user.findUnique({
            where: { email: contactEmail },
          });
          if (!existingUser) {
            const randomPassword = crypto.randomBytes(16).toString('hex');
            await auth.createOrUpdateAdminUser(
              contactEmail,
              randomPassword,
              companyData.contact?.trim() || contactEmail,
              newCompany.id,
              'companyadmin',
              undefined,
              undefined,
              companyData.contactphone?.trim() || null
            );
            this.logger.log(
              color.green.bold(
                `Created contact user ${color.white.bold(
                  contactEmail
                )} for company ${color.white.bold(newCompany.name)}`
              )
            );
          } else {
            this.logger.log(
              color.yellow.bold(
                `Contact user ${color.white.bold(
                  contactEmail
                )} already exists, skipping auto-create for company ${color.white.bold(
                  newCompany.name
                )}`
              )
            );
          }
        } catch (userError) {
          this.logger.log(
            color.red.bold(
              `Company created but contact user creation failed: ${userError}`
            )
          );
        }
      }

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
   * Build the (hard-coded Dutch) printer order e-mail for a list.
   * Returns subject + html + text so the admin can copy/paste it into
   * their own mail client. Works for both Tromp and Schneider lists.
   */
  public async getOrderEmail(companyId: number, listId: number): Promise<any> {
    try {
      const list: any = await (this.prisma as any).companyList.findUnique({
        where: { id: listId },
        include: {
          Company: { select: { id: true, name: true, ...Object.fromEntries(DELIVERY_FIELDS.map((f) => [f, true])) } },
          CompanyListDeliveryAddress: { orderBy: { id: 'asc' } },
          CompanyFile: { where: { category: 'design' }, orderBy: { createdAt: 'asc' } },
        },
      });
      if (!list || list.companyId !== companyId) {
        return { success: false, error: 'List not found' };
      }

      const warnings: string[] = [];

      // Total number of boxes comes from the current quotation/calculator
      // state stored on the list (per-printer column).
      const printer = listPrinterVariant(list.printer);
      const column = variantCalculationColumn(printer);
      let calcState: any = {};
      try {
        calcState = JSON.parse(list[column] || '{}');
      } catch {
        /* ignore */
      }
      const totalBoxes = Number(calcState.quantity) || 0;
      if (!totalBoxes) {
        warnings.push(
          'Geen aantal dozen gevonden in de calculator van deze lijst. Open de calculator en sla de berekening op.'
        );
      }

      // Printer-specific product description
      let productDescription = '';
      if (printer === 'schneider') {
        const cardCount = Number(calcState.cardCount) || list.numberOfCards || 96;
        const bundleByCount: Record<number, { bundle: string; box: string }> = {
          48: { bundle: '1x 48 in banderol', box: '1-vaks' },
          96: { bundle: '2x 48 in banderol', box: '2-vaks' },
          144: { bundle: '2x 72 in banderol', box: '2-vaks' },
          192: { bundle: '4x 48 in banderol', box: '4-vaks' },
        };
        const spec = bundleByCount[cardCount] || bundleByCount[96];
        productDescription = `${cardCount} kaarten (${spec.bundle}), formaat 56 x 56 mm, wit 350 grams Condat, 2-zijdig uniek, fc/fc + lak bedrukt, met afgeronde hoeken in een luxe ${spec.box} dekseldoosje van wit SK2 karton, deksel + bodem fc/0 bedrukt + glanslaminaat.`;
      } else {
        const printingType = calcState.printingType || 'eigen';
        const trompDescriptions: Record<string, string> = {
          eigen:
            '200 kaarten per set, doosje met volledig eigen bedrukking, kaarten 2-zijdig uniek bedrukt',
          voorbedrukt:
            '200 kaarten per set in een voorbedrukt doosje met venster, kaarten 2-zijdig uniek bedrukt',
          klein:
            '100 kaarten per set in een klein voorbedrukt doosje met venster, kaarten 2-zijdig uniek bedrukt',
          luxe: 'luxe doos met 200 kaarten + bedrukte chips',
        };
        productDescription =
          trompDescriptions[printingType] || trompDescriptions['eigen'];
      }

      // Desired delivery date in Dutch
      let deliveryDateText = '';
      // "z.s.m." on the list wins over a date (the list settings offer one or the other).
      const deliveryAsap = list.deliveryAsap === true;
      if (deliveryAsap) {
        deliveryDateText = 'z.s.m.';
      } else if (list.desiredDeliveryDate) {
        const months = [
          'januari', 'februari', 'maart', 'april', 'mei', 'juni',
          'juli', 'augustus', 'september', 'oktober', 'november', 'december',
        ];
        const d = new Date(list.desiredDeliveryDate);
        deliveryDateText = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
      } else {
        deliveryDateText = '[LEVERDATUM]';
        warnings.push('Geen gewenste leverdatum ingesteld op deze lijst.');
      }

      // Delivery addresses: first one gets all boxes, the rest 0, and the
      // QRSong! (Rick Groenewegen) address is always added last with 3 boxes.
      type OrderAddress = { name: string; lines: string[]; boxes: number };
      const addresses: OrderAddress[] = list.CompanyListDeliveryAddress.map(
        (a: any, index: number) => ({
          name: a.name,
          lines: [
            ...String(a.address || '')
              .split('\n')
              .map((line: string) => line.trim())
              .filter(Boolean),
            a.country,
          ].filter(Boolean),
          boxes: index === 0 ? totalBoxes : 0,
        })
      );
      // No separate addresses on the list: the delivery address from the list
      // settings (the company's default, or the list's own when switched off).
      if (addresses.length === 0) {
        const delivery = effectiveDeliveryAddress(list.Company, list);
        if (delivery) {
          addresses.push({
            name: list.Company?.name ?? '',
            lines: [
              ...(delivery.name ? [`t.a.v. ${delivery.name}`] : []),
              ...delivery.lines,
              ...(delivery.phone ? [`Tel. ${delivery.phone}`] : []),
            ],
            boxes: totalBoxes,
          });
        }
      }
      if (addresses.length === 0) {
        warnings.push(
          'Geen leveradressen bij deze lijst en geen leveradres bij het bedrijf. Alleen het QRSong! adres staat in de mail: vul het adres van de klant zelf aan.'
        );
      }
      addresses.push({
        name: 'Rick Groenewegen',
        lines: ['Prinsenhof 1', '2171XZ Sassenheim', 'Nederland'],
        boxes: 3,
      });

      // The attachments: the list's assets in the Design category.
      const files = list.CompanyFile.map((f: any) => ({
        id: f.id,
        originalName: f.originalName,
      }));
      if (!files.length) {
        warnings.push(
          'Er staan nog geen ontwerpen bij deze lijst (tabblad "Assets", categorie Design).'
        );
      }

      const numberWords = [
        '', 'één', 'twee', 'drie', 'vier', 'vijf',
        'zes', 'zeven', 'acht', 'negen', 'tien',
      ];
      const addressCountText =
        numberWords[addresses.length] || String(addresses.length);

      // Build text + html versions of the mail body
      const textParts: string[] = [];
      textParts.push('Goedendag,');
      textParts.push(
        `We willen graag een order plaatsen voor in totaal ${totalBoxes || '[AANTAL]'} x ${productDescription}`
      );
      textParts.push(
        deliveryAsap
          ? 'De wens is dat het zo snel mogelijk (z.s.m.) geleverd wordt.'
          : `De wens is dat het uiterlijk ${deliveryDateText} geleverd wordt.`
      );
      textParts.push(
        'De bestanden voor de kaartjes en het doosje zijn als bijlage toegevoegd.'
      );
      textParts.push(
        `We willen de order graag op ${addressCountText} verschillende adressen uit laten leveren:`
      );
      addresses.forEach((address, index) => {
        textParts.push(
          `Adres ${index + 1}: ${address.boxes} stuks\n\n${[
            address.name,
            ...address.lines,
          ].join('\n')}`
        );
      });
      textParts.push('Gr,\nRick Groenewegen');
      const text = textParts.join('\n\n');

      const esc = (value: string) =>
        value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      const htmlParts: string[] = [];
      htmlParts.push('<p>Goedendag,</p>');
      htmlParts.push(
        `<p>We willen graag een order plaatsen voor in totaal <strong>${
          totalBoxes || '[AANTAL]'
        }</strong> x ${esc(productDescription)}</p>`
      );
      htmlParts.push(
        deliveryAsap
          ? '<p>De wens is dat het <strong>zo snel mogelijk (z.s.m.)</strong> geleverd wordt.</p>'
          : `<p>De wens is dat het uiterlijk <strong>${esc(
              deliveryDateText
            )}</strong> geleverd wordt.</p>`
      );
      htmlParts.push(
        '<p>De bestanden voor de kaartjes en het doosje zijn als bijlage toegevoegd.</p>'
      );
      htmlParts.push(
        `<p>We willen de order graag op <strong>${esc(
          addressCountText
        )}</strong> verschillende adressen uit laten leveren:</p>`
      );
      addresses.forEach((address, index) => {
        htmlParts.push(
          `<p><strong>Adres ${index + 1}: ${address.boxes} stuks</strong></p>`
        );
        htmlParts.push(
          `<p>${[address.name, ...address.lines].map(esc).join('<br>')}</p>`
        );
      });
      htmlParts.push('<p>Gr,<br>Rick Groenewegen</p>');
      const html = htmlParts.join('\n');

      return {
        success: true,
        data: {
          subject: `Order ${list.Company?.name || list.name}`,
          html,
          text,
          totalBoxes,
          addressCount: addresses.length,
          files,
          warnings,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error building order email: ${error}`));
      return { success: false, error: 'Error building order email' };
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
      description_jp?: string;
      description_cn?: string;
      slug: string;
      numberOfCards: number;
      numberOfTracks: number;
      playlistSource?: string; // Added optional playlistSource
      playlistUrl?: string; // Added optional playlistUrl
      qrvote?: boolean; // Added optional qrvote flag
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
          playlistSource: playlistSource || 'own', // Default to 'own' (existing playlist, no voting) if not provided
          playlistUrl: playlistUrl || null, // Set to null if not provided
          status: 'new', // Start with 'new' status
          qrvote: listData.qrvote ?? false, // Use provided qrvote value or default to false
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
   * Delete a company list, whatever its status: the admin no longer uses
   * list statuses. Everything under the list (votes, questions, files,
   * delivery addresses, invoice records) cascades.
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
      if (fields.buttonBackgroundColor !== undefined)
        updateData.buttonBackgroundColor = String(fields.buttonBackgroundColor);
      if (fields.buttonTextColor !== undefined)
        updateData.buttonTextColor = String(fields.buttonTextColor);

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

      // Handle forceTemplate field
      if (fields.forceTemplate !== undefined) {
        updateData.forceTemplate = fields.forceTemplate === '' ? null : String(fields.forceTemplate);
      }

      // Handle addBirthdayNumber1 field
      if (fields.addBirthdayNumber1 !== undefined) {
        updateData.addBirthdayNumber1 = this.utils.parseBoolean(fields.addBirthdayNumber1);
      }

      // Handle hideBirthdayNumber1 field
      if (fields.hideBirthdayNumber1 !== undefined) {
        updateData.hideBirthdayNumber1 = this.utils.parseBoolean(fields.hideBirthdayNumber1);
      }

      // Explicitly handle empty string values for background fields to set them to null
      if (fields.background === '') {
        updateData.background = null;
      }
      if (fields.background2 === '') {
        updateData.background2 = null;
      }
      if (fields.votingBackground === '') {
        updateData.votingBackground = null;
      }
      if (fields.votingLogo === '') {
        updateData.votingLogo = null;
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
   * Centralized cache clearing for a company list by slug. The voting page
   * caches the list per visitor (`companyListByDomain:<slug>:<hash>`, see
   * Hitlist.getCompanyListByDomain), so every visitor's copy goes.
   * @param slug The slug of the company list.
   */
  public async clearCompanyListCache(slug: string | null | undefined) {
    if (!slug) return;
    await this.cache.delPatternNonBlocking(`companyListByDomain:${slug}:*`);
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
                isBirthdayTrack: true,
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
        [trackId: number]: {
          name: string;
          agreeToUseName: boolean;
          isBirthdayTrack: boolean;
        }[];
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
              isBirthdayTrack: !!submissionTrack.isBirthdayTrack,
            });
          }

          // Points calculation:
          // - Birthday tracks (isBirthdayTrack: true) always get maxPoints (same as #1 position)
          // - Regular tracks: maxPoints - position + 1
          // Example: maxPoints=5 -> pos 1 gets 5, pos 2 gets 4, ..., pos 5 gets 1
          const points = submissionTrack.isBirthdayTrack
            ? maxPoints
            : maxPoints - submissionTrack.position + 1;

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

      // --- Use getRanking ---
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

      // Filter the ranked tracks to get the top ones based on numberOfCards
      // The 'withinLimit' flag from getRanking already tells us this. If
      // none is within the limit, the playlist is empty.
      const topTracks = allRankedTracks.filter(
        (track: any) => track.withinLimit
      );

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

  /**
   * Calculate Tromp pricing for boxes and card sets
   * Based on Tromp Print & Packaging quote (Offerte 202511652)
   * @param params Calculation parameters
   * @returns Object with calculation results
   */
  public async calculateTrompPricing(params: {
    quantity: number;
    includeStansmestekening: boolean;
    includeStansvorm: boolean;
    includeCustomApp?: boolean;
    includeVotingPortal?: boolean;
    profitMargin: number;
    printingType?: string; // 'eigen', 'voorbedrukt', 'klein', or 'luxe'
  }): Promise<any> {
    try {
      const {
        quantity,
        includeStansmestekening,
        includeStansvorm,
        includeCustomApp = false,
        includeVotingPortal = false,
        profitMargin,
        printingType = 'eigen', // Default to 'eigen' (own printing)
      } = params;

      // Validate input
      if (!quantity || quantity < 1) {
        return { success: false, error: 'Invalid quantity' };
      }

      // Calculate prices based on Excel formulas from doosje QR-song.xlsx
      let boxPrice: number;
      let cardPrice: number;
      let boxTypeName: string;
      let cardsPerSet: number;

      if (printingType === 'luxe') {
        // Luxe doos (luxury box, cards included) - linear total cost.
        // Confirmed by Tromp: totalCost = setup + perBox * quantity.
        //   setup  = €3850 (fixed)
        //   perBox = €10.50
        // Per-unit = 3850/qty + 10.50.
        const LUXE_SETUP = 3850;
        const LUXE_PER_BOX = 10.5;
        boxPrice = LUXE_SETUP + LUXE_PER_BOX * quantity;
        cardPrice = 0;
        boxTypeName = 'Luxe doos (200 kaarten + bedrukte chips)';
        cardsPerSet = 200;
      } else if (printingType === 'voorbedrukt') {
        // Voorbedrukt doosje met venster (Column D) - Pre-printed box with window
        // Boxes: (1165 / 1000) * quantity = 1.165 * quantity
        boxPrice = 1.165 * quantity;
        // Cards: (quantity * 5.9) + 250
        cardPrice = (quantity * 5.9) + 250;
        boxTypeName = 'Voorbedrukt met venster';
        cardsPerSet = 200;
      } else if (printingType === 'klein') {
        // Klein voorbedrukt doosje met venster (Column F) - Small pre-printed box with 100 cards
        // Boxes: same as voorbedrukt = 1.165 * quantity
        boxPrice = 1.165 * quantity;
        // Cards: ((standardCardPrice - 100) * 0.5) + 100
        // Where standardCardPrice = (quantity * 5.9) + 250
        const standardCardPrice = (quantity * 5.9) + 250;
        cardPrice = ((standardCardPrice - 100) * 0.5) + 100;
        boxTypeName = 'Klein voorbedrukt met venster';
        cardsPerSet = 100;
      } else {
        // Volledig eigen bedrukking (Column B) - Own printing (default)
        // Boxes: (quantity * 0.335) + 830
        boxPrice = (quantity * 0.335) + 830;
        // Cards: (quantity * 5.9) + 250
        cardPrice = (quantity * 5.9) + 250;
        boxTypeName = 'Volledig eigen bedrukking';
        cardsPerSet = 200;
      }

      // Calculate per-unit prices
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const boxPricePerUnit = round2(boxPrice / quantity);
      const cardPricePerUnit = round2(cardPrice / quantity);

      // Calculate extras
      const extras: {
        key?: string;
        keyVars?: Record<string, any>;
        name: string;
        price: number;
      }[] = [];
      let extrasTotal = 0;

      if (includeStansmestekening) {
        extras.push({ key: 'dielineDrawing', name: 'Stansmestekening + dummy', price: 150.0 });
        extrasTotal += 150.0;
      }

      if (includeStansvorm) {
        extras.push({ key: 'cuttingDie', name: 'Stansvorm', price: 425.0 });
        extrasTotal += 425.0;
      }

      // Calculate totals
      // Price per set includes boxes + cards + profit (but NOT extras, as they're one-time costs shown separately)
      const baseCostPerSet = (boxPrice + cardPrice) / quantity;
      const profitPerSet = profitMargin || 0;
      const pricePerSet = round2(baseCostPerSet + profitPerSet);

      // Derive totals from the rounded pricePerSet so clientPrice = pricePerSet × quantity exactly
      const subtotalFromRounded = round2(pricePerSet * quantity);
      const baseClientPrice = round2(subtotalFromRounded + extrasTotal);

      // Calculate ourProfit and trompCost for display
      const baseOurProfit = round2((profitMargin || 0) * quantity);
      const trompCost = round2(subtotalFromRounded - baseOurProfit + extrasTotal);

      // Add custom app fee and voting portal fee (one-time) - added to both client price and our profit
      const customAppFee = includeCustomApp ? 350 : 0;
      const votingPortalFee = includeVotingPortal ? 500 : 0;
      const clientPrice = round2(baseClientPrice + customAppFee + votingPortalFee);
      const ourProfit = round2(baseOurProfit + customAppFee + votingPortalFee);

      // Return calculation results
      return {
        success: true,
        calculation: {
          quantity,
          printingType: printingType,
          boxTypeName: boxTypeName,
          cardsPerSet: cardsPerSet,
          boxTierName: `${boxTypeName} @ €${boxPricePerUnit.toFixed(2)}/unit`,
          boxPricePerUnit: boxPricePerUnit,
          boxPrice: boxPrice,
          cardTierName: `${cardsPerSet} kaartjes @ €${cardPricePerUnit.toFixed(2)}/set`,
          cardPricePerUnit: cardPricePerUnit,
          cardPrice: cardPrice,
          extras: extras,
          extrasTotal: extrasTotal,
          trompCost: trompCost,
          ourProfit: ourProfit,
          pricePerSet: pricePerSet,
          clientPrice: clientPrice,
          customAppFee: customAppFee,
          votingPortalFee: votingPortalFee,
        },
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error calculating Tromp pricing: ${error}`)
      );
      return { success: false, error: 'Error calculating Tromp pricing' };
    }
  }

  /**
   * Calculate Schneider pricing for luxury card boxes
   * Pricing structure:
   * - 48 cards (1x48 in banderol): Tiered pricing per unit, 1-vaks box
   * - 96 cards (2x48 in banderol): Fixed €790 + €2.16 per piece, 2-vaks box
   * - 144 cards (2x72 in banderol): Fixed €1000 + €2.65 per piece, 2-vaks box
   * - 192 cards (4x48 in banderol): Fixed €1350 + €3.73 per piece, 4-vaks box
   * - Stansmes 2-vaks (144 cards): €325 one-time
   * - Stansmes 4-vaks (192 cards): €375 one-time
   * - Shipping (src/businessShipping.ts): included within the Netherlands;
   *   abroad an estimate, or `forceShippingPrice` (0 = free), added as the
   *   one-off extra `shipping`. Schneiders bills it, so it counts in both the
   *   Schneider cost and the client price. `calculation.shipping` always
   *   carries the estimate's details.
   * @param params Calculation parameters
   * @returns Object with calculation results
   */
  public async calculateSchneiderPricing(params: {
    quantity: number;
    cardCount: number; // 48, 96, 144, or 192
    includeStansmes: boolean;
    includeCustomApp?: boolean;
    includeVotingPortal?: boolean;
    profitMargin: number;
    /** ISO 3166-1 alpha-2 (or a name); absent or null is the Netherlands. */
    deliveryCountry?: string | null;
    /** Total excl. VAT; null/undefined uses the estimate, 0 is free. */
    forceShippingPrice?: number | null;
  }): Promise<any> {
    try {
      const {
        quantity,
        cardCount,
        includeStansmes,
        includeCustomApp = false,
        includeVotingPortal = false,
        profitMargin,
        deliveryCountry = null,
        forceShippingPrice = null,
      } = params;

      // Validate input
      if (!quantity || quantity < 1) {
        return { success: false, error: 'Invalid quantity' };
      }

      if (![48, 96, 144, 192].includes(cardCount)) {
        return { success: false, error: 'Invalid card count. Must be 48, 96, 144, or 192' };
      }

      // Pricing structure based on Schneider quote
      let fixedCost: number;
      let pricePerPiece: number;
      let boxType: string;
      let stansmesPrice: number;
      let subtotal: number;

      // 48 cards uses tiered pricing with 30% reseller discount applied
      if (cardCount === 48) {
        // Original tiered pricing for 48 cards (before 30% reseller discount)
        // Tiers must match frontend QUANTITIES for profit margin lookup
        const priceTiers: { qty: number; price: number }[] = [
          { qty: 75, price: 5.99 },
          { qty: 100, price: 5.31 },
          { qty: 150, price: 4.27 },
          { qty: 200, price: 3.61 },
          { qty: 250, price: 3.18 },
          { qty: 300, price: 2.87 },
          { qty: 400, price: 2.46 },
          { qty: 500, price: 2.21 },
          { qty: 750, price: 1.90 },
          { qty: 1000, price: 1.66 },
          { qty: 1500, price: 1.46 },
          { qty: 2000, price: 1.35 },
          { qty: 2500, price: 1.28 },
          { qty: 5000, price: 1.07 },
          { qty: 10000, price: 0.83 },
        ];

        // Reseller discount rate
        const resellerDiscount = 0.30;

        // Find the applicable price tier (use the highest tier that quantity qualifies for)
        let tierPrice: number;
        if (quantity <= priceTiers[0].qty) {
          tierPrice = priceTiers[0].price;
        } else if (quantity >= priceTiers[priceTiers.length - 1].qty) {
          tierPrice = priceTiers[priceTiers.length - 1].price;
        } else {
          // Find the highest tier the quantity qualifies for (no interpolation)
          let applicableTier = priceTiers[0];
          for (const tier of priceTiers) {
            if (quantity >= tier.qty) {
              applicableTier = tier;
            } else {
              break;
            }
          }
          tierPrice = applicableTier.price;
        }

        // Apply 30% reseller discount
        const discountedPrice = tierPrice * (1 - resellerDiscount);

        fixedCost = 0;
        pricePerPiece = Math.round(discountedPrice * 100) / 100;
        boxType = '1-vaks luxe dekseldoosje';
        stansmesPrice = 0; // No stansmes for 48 cards
        subtotal = pricePerPiece * quantity;
      } else {
        switch (cardCount) {
          case 96:
            // 96 kaarten (2X 48 in banderol), 2-vaks dekseldoosje
            fixedCost = 790.0;
            pricePerPiece = 2.16;
            boxType = '2-vaks luxe dekseldoosje';
            stansmesPrice = 0; // No stansmes for 96 cards (uses standard)
            break;
          case 144:
            // 144 kaarten (2X 72 in banderol), 2-vaks dekseldoosje
            fixedCost = 1000.0;
            pricePerPiece = 2.65;
            boxType = '2-vaks luxe dekseldoosje';
            stansmesPrice = 325.0;
            break;
          case 192:
            // 192 kaarten (4X 48 in banderol), 4-vaks dekseldoosje
            fixedCost = 1350.0;
            pricePerPiece = 3.73;
            boxType = '4-vaks luxe dekseldoosje';
            stansmesPrice = 375.0;
            break;
          default:
            return { success: false, error: 'Invalid card count' };
        }

        // Calculate base costs for non-48 card products
        const variableCost = pricePerPiece * quantity;
        subtotal = fixedCost + variableCost;
      }

      // Calculate extras
      const extras: {
        key?: string;
        keyVars?: Record<string, any>;
        name: string;
        price: number;
      }[] = [];
      let extrasTotal = 0;

      // Stansmes only applies to 144 and 192 cards
      if (includeStansmes && cardCount !== 48 && cardCount !== 96 && stansmesPrice > 0) {
        extras.push({
          key: 'cuttingDieBox',
          keyVars: { compartments: cardCount === 192 ? 4 : 2 },
          name: `Stansmes ${cardCount === 192 ? '4' : '2'}-vaks doosje`,
          price: stansmesPrice
        });
        extrasTotal += stansmesPrice;
      }

      // Shipping abroad is a one-off extra like the cutting die: Schneiders
      // bills it, we pass it on at cost.
      const shipping = estimateBusinessShipping({
        cardCount,
        quantity,
        country: deliveryCountry,
        forceShippingPrice,
      });
      if (shipping && shipping.price > 0) {
        extras.push({
          key: 'shipping',
          keyVars: shippingExtraKeyVars(shipping),
          name: 'Verzending',
          price: shipping.price,
        });
        extrasTotal += shipping.price;
      }

      // Calculate cost per box (without extras, as they're one-time)
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const costPerBox = round2(subtotal / quantity);
      const profitPerBox = round2(profitMargin || 0);
      const pricePerBox = round2(costPerBox + profitPerBox);

      // Calculate totals
      const schneiderCost = round2(subtotal + extrasTotal);
      const baseOurProfit = round2((profitMargin || 0) * quantity);

      // Add custom app fee (one-time)
      const customAppFee = includeCustomApp ? 350 : 0;
      if (includeCustomApp) {
        extras.push({ key: 'customApp', name: 'App in eigen stijl', price: customAppFee });
      }

      // Add voting portal fee (one-time)
      const votingPortalFee = includeVotingPortal ? 500 : 0;
      if (includeVotingPortal) {
        extras.push({ key: 'votingPortal', name: 'Voting Portal', price: votingPortalFee });
      }

      const clientPrice = round2(pricePerBox * quantity + extrasTotal + customAppFee + votingPortalFee);
      const ourProfit = round2(baseOurProfit + customAppFee + votingPortalFee);

      // Return calculation results
      return {
        success: true,
        calculation: {
          quantity,
          cardCount,
          boxType,
          fixedCost,
          pricePerPiece,
          subtotal,
          extras,
          extrasTotal: round2(extrasTotal + customAppFee + votingPortalFee),
          schneiderCost,
          ourProfit,
          pricePerBox,
          clientPrice,
          customAppFee,
          votingPortalFee,
          shipping,
        },
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error calculating Schneider pricing: ${error}`)
      );
      return { success: false, error: 'Error calculating Schneider pricing' };
    }
  }

  /**
   * Generate a quotation PDF for a company
   * @param companyId The company ID
   * @param userId The user making the request
   * @param userGroups The user's groups
   * @param userCompanyId The user's company ID (for companyadmin validation)
   * @param type The quotation type ('qrsong' for Tromp, or 'schneider')
   * @param pricingOptions Optional pricing options from frontend (isReseller, profitMargins, calculatedPrices)
   * @returns Buffer with PDF data or error
   */
  public async generateQuotationPDF(
    companyId: number,
    userId: number,
    userGroups: string[],
    userCompanyId: number | undefined,
    type: 'qrsong' | 'schneider',
    pricingOptions?: {
      isReseller?: boolean;
      profitMargins?: { qrsong: number; reseller: number };
      calculatedPrices?: {
        printerCost: number;
        qrsongProfitAmount: number;
        resellerPrice: number;
        resellerProfitAmount: number;
        retailPrice: number;
        ourTotalProfit: number;
        clientPricePerUnit: number;
        clientPaysTotal: number;
      };
    },
    listId?: number,
    contactUserId?: number
  ): Promise<{
    success: boolean;
    data?: Buffer;
    filename?: string;
    quotationNumber?: string;
    error?: string;
  }> {
    try {
      // If user is companyadmin, only allow for their own company
      if (userGroups.includes('companyadmin') && userCompanyId !== companyId) {
        return {
          success: false,
          error:
            'Forbidden: You can only generate quotations for your own company',
        };
      }

      // Get company details - pass userGroups to include onlyForAdmin companies for admins
      const companiesResult = await this.getAllCompanies(userGroups);
      if (!companiesResult.success || !companiesResult.data?.companies) {
        return { success: false, error: 'Failed to fetch companies' };
      }
      const company = companiesResult.data.companies.find(
        (c: any) => c.id === companyId
      );

      if (!company) {
        return { success: false, error: 'Company not found' };
      }

      // Generate unique quotation number - QRS for both printers (no printer names)
      const quotationNumber = `QRS${Date.now().toString().slice(-8)}`;

      // Prepare file path — archive to PRIVATE_DIR so we can re-download later.
      const quotationDir = `${process.env['PRIVATE_DIR']}/quotation`;
      try {
        await fs.access(quotationDir);
      } catch {
        await fs.mkdir(quotationDir, { recursive: true });
      }
      const filePath = `${quotationDir}/${quotationNumber}.pdf`;

      // Generate PDF using Lambda
      const PDF = require('./pdf').default;
      const pdfManager = new PDF();

      // Create the URL for the HTML rendering
      const baseUrl = process.env['API_URI'] || 'http://localhost:3004';

      // Build query string with pricing options if provided
      const queryParams = new URLSearchParams();
      if (pricingOptions?.isReseller !== undefined) {
        queryParams.set('isReseller', String(pricingOptions.isReseller));
      }
      if (pricingOptions?.profitMargins) {
        queryParams.set('profitMargins', JSON.stringify(pricingOptions.profitMargins));
      }
      if (pricingOptions?.calculatedPrices) {
        queryParams.set('calculatedPrices', JSON.stringify(pricingOptions.calculatedPrices));
      }
      if (listId) {
        queryParams.set('listId', String(listId));
      }
      if (contactUserId) {
        queryParams.set('contactUserId', String(contactUserId));
      }

      // The Lambda that renders this URL has no session, so the company's
      // business language has to travel in the query string.
      const locale = this.translation.resolveBusinessLocale(company.locale);
      queryParams.set('locale', locale);

      const queryString = queryParams.toString();
      const htmlUrl = `${baseUrl}/business/quotation/${type}/${companyId}/${quotationNumber}${queryString ? '?' + queryString : ''}`;

      this.logger.log(
        color.blue.bold(`Generating PDF quotation from URL: `) +
          color.white.bold(htmlUrl)
      );

      // Generate PDF using Lambda
      await pdfManager.generateFromUrl(htmlUrl, filePath, {
        format: 'a4',
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
      });

      // Read the archived PDF (kept on disk under PRIVATE_DIR for re-download)
      const pdfBuffer = await fs.readFile(filePath);

      // Generate filename for download - never include printer names like 'tromp' or 'schneider'
      const quotationT = await this.translation.getBusinessTranslator(
        locale,
        'quotation'
      );
      const downloadFilename = `${quotationT('fileName')}_${company.name.replace(
        /[^a-zA-Z0-9]/g,
        '_'
      )}_${quotationNumber}.pdf`;

      // Persist a quotation history row. Pull the current calculation JSON
      // from the list (or fall back to the company-level one) so we can
      // extract the flags and totals the admin cares about.
      try {
        const column =
          type === 'qrsong' ? 'calculationTromp' : 'calculationSchneider';

        let calcJson: string | null = null;
        let listName: string | null = null;
        let listNumberOfCards: number | null = null;

        if (listId) {
          const list: any = await (this.prisma as any).companyList.findUnique({
            where: { id: listId },
            select: {
              name: true,
              numberOfCards: true,
              calculationTromp: true,
              calculationSchneider: true,
            },
          });
          if (list) {
            listName = list.name;
            listNumberOfCards = list.numberOfCards ?? null;
            calcJson = list[column] as string | null;
          }
        }
        if (!calcJson) {
          calcJson = (company as any)[column] as string | null;
        }

        let state: any = {};
        if (calcJson) {
          try { state = JSON.parse(calcJson); } catch { /* ignore */ }
        }

        const clientPaysTotal = pricingOptions?.calculatedPrices?.clientPaysTotal;
        const retailPrice = pricingOptions?.calculatedPrices?.retailPrice;
        const quantity = Number(state.quantity) || 0;
        const totalAmount =
          clientPaysTotal ??
          (retailPrice != null && quantity > 0 ? retailPrice * quantity : null);
        const ourProfit =
          (pricingOptions as any)?.ourProfit ??
          pricingOptions?.calculatedPrices?.ourTotalProfit ??
          null;

        await (this.prisma as any).quotation.create({
          data: {
            quotationNumber,
            companyId,
            listId: listId ?? null,
            listName,
            userEmail: typeof userId === 'string' ? userId : null,
            variant: type,
            quantity,
            numberOfCards: listNumberOfCards,
            totalAmount,
            clientPaysTotal: clientPaysTotal ?? null,
            ourProfit,
            includeVotingPortal: !!state.includeVotingPortal,
            includeCustomApp: !!state.includeCustomApp,
            includePersonalization: !!state.includePersonalization,
            isReseller: !!(pricingOptions?.isReseller ?? state.isReseller),
            manualDiscountPercent: this.quotedDiscountPercent(state, company),
            locale,
            payload: JSON.stringify({
              state,
              pricingOptions: pricingOptions ?? null,
              contactUserId: contactUserId ?? null,
            }),
          },
        });
      } catch (persistError: any) {
        this.logger.log(
          color.red.bold(
            `Quotation PDF generated but persist FAILED: ${persistError?.message || persistError}`
          )
        );
        console.error('[quotation persist] full error:', persistError);
      }

      return {
        success: true,
        data: pdfBuffer,
        filename: downloadFilename,
        quotationNumber,
      };
    } catch (error: any) {
      this.logger.log(color.red.bold(`Error generating quotation: ${error}`));
      return { success: false, error: 'Failed to generate quotation' };
    }
  }

  /**
   * The discount a quotation prints: the list calculation's own, or, for a
   * Tromp or Schneider calculation saved before the discount moved onto the
   * list, the company-wide one (the quotation route applies the same rule).
   */
  private quotedDiscountPercent(state: any, company: any): number {
    if (typeof state?.manualDiscountPercent === 'number') {
      return state.manualDiscountPercent;
    }
    if (!company?.calculation) return 0;
    try {
      return Number(JSON.parse(company.calculation).manualDiscountPercent) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Fetch the archived PDF for a previously generated quotation from
   * PRIVATE_DIR/quotation/<quotationNumber>.pdf so the client can re-download
   * the original document without any Lambda calls.
   */
  public async getQuotationPDF(
    companyId: number,
    quotationId: number,
    userGroups: string[],
    userCompanyId?: number
  ): Promise<{
    success: boolean;
    data?: Buffer;
    filename?: string;
    error?: string;
  }> {
    try {
      if (userGroups.includes('companyadmin') && userCompanyId !== companyId) {
        return { success: false, error: 'Forbidden' };
      }

      const quotation = await (this.prisma as any).quotation.findUnique({
        where: { id: quotationId },
      });
      if (!quotation || quotation.companyId !== companyId) {
        return { success: false, error: 'Quotation not found' };
      }

      const companiesResult = await this.getAllCompanies(userGroups);
      const company = companiesResult.data?.companies?.find(
        (c: any) => c.id === companyId
      );
      if (!company) {
        return { success: false, error: 'Company not found' };
      }

      const pdfPath = `${process.env['PRIVATE_DIR']}/quotation/${quotation.quotationNumber}.pdf`;
      try {
        await fs.access(pdfPath);
      } catch {
        return { success: false, error: 'Archived PDF not found' };
      }

      const pdfBuffer = await fs.readFile(pdfPath);
      // Name the re-download after the language the quotation was issued in,
      // not the company's current one — the archived PDF cannot change.
      const quotationT = await this.translation.getBusinessTranslator(
        this.translation.resolveBusinessLocale(quotation.locale),
        'quotation'
      );
      const downloadFilename = `${quotationT('fileName')}_${company.name.replace(
        /[^a-zA-Z0-9]/g,
        '_'
      )}_${quotation.quotationNumber}.pdf`;

      return {
        success: true,
        data: pdfBuffer,
        filename: downloadFilename,
      };
    } catch (error: any) {
      this.logger.log(
        color.red.bold(`Error fetching archived quotation: ${error?.message || error}`)
      );
      return { success: false, error: 'Failed to fetch quotation' };
    }
  }

  /**
   * MoneyBird invoice references for a list, in the company's language.
   * Invoice creation and the "is this already invoiced?" lookup MUST derive
   * their references from here, or the dashboard reports a down payment as
   * un-invoiced and an admin bills the customer twice.
   *
   * `legacyDown`/`legacyRemaining` are the Dutch, em-dashed format used before
   * these documents were translated, so invoices booked back then still
   * resolve.
   */
  public async buildInvoiceReferences(
    listName: string,
    locale?: string | null
  ): Promise<{
    full: string;
    down: string;
    remaining: string;
    legacyDown: string;
    legacyRemaining: string;
  }> {
    const t = await this.translation.getBusinessTranslator(
      this.translation.resolveBusinessLocale(locale),
      'invoice_lines'
    );
    return {
      full: listName,
      down: `${listName} - ${t('downPayment')}`,
      remaining: `${listName} - ${t('remainingPayment')}`,
      legacyDown: `${listName} \u2014 Aanbetaling 30%`,
      legacyRemaining: `${listName} \u2014 Slottermijn 70%`,
    };
  }

  /**
   * Invoice lines for a company list, built from the price snapshot its
   * calculator saved (see listPricing.ts). The quotation and the Sell column
   * show the same numbers, so the invoice matches both. Nothing is
   * recalculated here: the server only knows the printer cost, not the
   * profit table, reseller prices or forced prices.
   *
   * Prices are excl. VAT; the caller attaches the VAT rate and MoneyBird
   * computes the VAT.
   *
   * paymentOption:
   *   - 'full': every line, plus a discount line when there is a discount;
   *     shipping comes after the discount line, which never includes it
   *   - 'down': one line, 30% of the total
   *   - 'remaining': one line, the total minus `downPaymentExclVat` (the
   *     down payment actually invoiced), or minus 30% when there is none
   *
   * A Tromp list whose snapshot says Tromp sold it (`trompSold`) bills our
   * license fee per set instead of a box. Such a list lives under the Tromp
   * company, so the invoice goes to Tromp like any company's.
   */
  public async buildInvoiceLineItems(
    companyId: number,
    listId: number,
    type: ListVariant,
    paymentOption: PaymentOption,
    options: { downPaymentExclVat?: number | null } = {}
  ): Promise<{
    success: boolean;
    error?: string;
    /** 'no_pricing': the list has no saved price snapshot yet. */
    code?: 'no_pricing';
    items?: { description: string; amount: string; price: string }[];
    company?: any;
    list?: any;
    reference?: string;
    /** Business locale the line items were rendered in. */
    locale?: string;
    pricing?: ListPricing;
    totals?: ListPricingTotals;
    /** What each of the three invoices comes to, excl. VAT. */
    amounts?: PaymentAmounts;
    /** What this invoice comes to, excl. VAT. */
    invoiceTotal?: number;
  }> {
    try {
      const list: any = await (this.prisma as any).companyList.findUnique({
        where: { id: listId },
      });
      if (!list || list.companyId !== companyId) {
        return { success: false, error: 'List not found' };
      }
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
      });
      if (!company) return { success: false, error: 'Company not found' };

      const rawCalculation = list[variantCalculationColumn(type)];
      const pricing = listPricingFromCalculation(rawCalculation);
      if (!pricing) {
        return {
          success: false,
          code: 'no_pricing',
          error:
            'This list has no saved prices yet. Open its calculator, check the prices, and try again.',
        };
      }
      const calc = JSON.parse(rawCalculation);
      const totals = listPricingTotals(pricing);
      const amounts = paymentAmounts(totals.total, options.downPaymentExclVat);

      // Invoice line text is free text we supply, so it has to be translated
      // here; MoneyBird's own labels are handled by the `language` we send
      // along with the invoice.
      const locale = this.translation.resolveBusinessLocale(company.locale);
      const t = await this.translation.getBusinessTranslator(
        locale,
        'invoice_lines'
      );
      // Extras are named by the pricing calculators and shared with the
      // quotation, so they live under their own prefix.
      const tExtra = await this.translation.getBusinessTranslator(
        locale,
        'extras'
      );
      const extraName = (e: any): string =>
        e.key ? tExtra(e.key, e.keyVars) : e.name;

      // The product line names what the quotation names; the numbers all
      // come from the snapshot. A license fee names the list, which is how
      // Tromp tells its orders apart.
      let productDescription: string;
      if (type === 'qrsong' && pricing.trompSold) {
        productDescription = t('licenseFee', {
          list: list.name,
          cards: pricing.licenseCards || 200,
        });
      } else if (type === 'qrsong') {
        productDescription =
          calc.printingType === 'luxe'
            ? t('luxeBox')
            : calc.printingType === 'klein'
              ? t('smallBox')
              : t('standardBox');
      } else {
        productDescription = t('qrsongBox', { count: calc.cardCount || 48 });
      }

      const items: { description: string; amount: string; price: string }[] = [
        {
          description: productDescription,
          amount: String(pricing.quantity),
          price: pricing.unitPrice.toFixed(2),
        },
      ];
      const isShipping = (e: { key?: string }) => e.key === SHIPPING_EXTRA_KEY;
      for (const e of pricing.extras.filter((x) => !isShipping(x))) {
        items.push({
          description: t('extraOneOff', { name: extraName(e) }),
          amount: '1',
          price: e.price.toFixed(2),
        });
      }
      if (pricing.customAppFee > 0) {
        items.push({
          description: t('customApp'),
          amount: '1',
          price: pricing.customAppFee.toFixed(2),
        });
      }
      if (pricing.votingPortalFee > 0) {
        items.push({
          description: t('votingPortal'),
          amount: '1',
          price: pricing.votingPortalFee.toFixed(2),
        });
      }
      // A negative line, excl. VAT, so MoneyBird computes the VAT on the
      // discounted total like the quotation does. The discount is a
      // percentage of the lines above it: never of shipping, which follows.
      if (totals.discountAmount > 0) {
        items.push({
          description: t('discount', { percent: pricing.discountPercent }),
          amount: '1',
          price: (-totals.discountAmount).toFixed(2),
        });
      }
      // Shipping names its country and what goes ("Verzending naar
      // Duitsland (34 omdozen op 1 pallet)") and comes last, after the
      // discount (Rick, 2026-10-06).
      const shippingExtras = pricing.extras.filter(isShipping);
      if (shippingExtras.length > 0) {
        let countryNames: Record<string, string> | null = null;
        try {
          countryNames = await this.translation.getTranslationsByPrefix(
            locale,
            'countries'
          );
        } catch {
          countryNames = null; // the ISO code stands in for the name
        }
        for (const e of shippingExtras) {
          const text = shippingLineText(tExtra, e.keyVars, countryNames);
          items.push({
            description: text.details
              ? t('shipping', { name: text.description, details: text.details })
              : text.description,
            amount: '1',
            price: e.price.toFixed(2),
          });
        }
      }

      const reference = `${list.name}`;
      const result = {
        success: true,
        company,
        list,
        reference,
        locale,
        pricing,
        totals,
        amounts,
      };

      if (paymentOption === 'down' || paymentOption === 'remaining') {
        const invoiceTotal =
          paymentOption === 'down' ? amounts.down : amounts.remaining;
        if (invoiceTotal <= 0) {
          return {
            success: false,
            error: `Nothing left to invoice: the down payment already invoiced covers the list total of € ${totals.total.toFixed(2)} excl. VAT.`,
          };
        }
        const label =
          paymentOption === 'down'
            ? `${t('downPayment')} - ${list.name}`
            : `${t('remainingPayment')} - ${list.name}`;
        return {
          ...result,
          items: [
            { description: label, amount: '1', price: invoiceTotal.toFixed(2) },
          ],
          invoiceTotal,
        };
      }

      return { ...result, items, invoiceTotal: totals.total };
    } catch (error: any) {
      this.logger.log(
        color.red.bold(`Error building invoice items: ${error?.message || error}`)
      );
      return { success: false, error: error?.message || 'Failed to build items' };
    }
  }

  // ============================================
  // Company Events
  // ============================================

  /**
   * Get all events for a company
   */
  public async getCompanyEvents(companyId: number): Promise<any> {
    try {
      const events = await this.prisma.companyEvent.findMany({
        where: { companyId },
        include: {
          User: {
            select: {
              id: true,
              displayName: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return { success: true, data: events };
    } catch (error: any) {
      this.logger.log(color.red.bold(`Error getting company events: ${error}`));
      return { success: false, error: 'Failed to get company events' };
    }
  }

  /**
   * Create a new company event
   */
  public async createCompanyEvent(
    companyId: number,
    userId: number,
    content: string,
    attachmentUrl: string | null
  ): Promise<any> {
    try {
      const event = await this.prisma.companyEvent.create({
        data: {
          companyId,
          userId,
          type: 'comment',
          content,
          attachmentUrl,
        },
        include: {
          User: {
            select: {
              id: true,
              displayName: true,
              email: true,
            },
          },
        },
      });

      return { success: true, data: event };
    } catch (error: any) {
      this.logger.log(color.red.bold(`Error creating company event: ${error}`));
      return { success: false, error: 'Failed to create company event' };
    }
  }

  /**
   * Update a company event
   */
  public async updateCompanyEvent(
    companyId: number,
    eventId: number,
    content: string
  ): Promise<any> {
    try {
      const event = await this.prisma.companyEvent.findFirst({
        where: { id: eventId, companyId },
      });

      if (!event) {
        return { success: false, error: 'Event not found' };
      }

      const updatedEvent = await this.prisma.companyEvent.update({
        where: { id: eventId },
        data: { content: content.trim() },
        include: { User: true },
      });

      return { success: true, data: updatedEvent };
    } catch (error: any) {
      this.logger.log(color.red.bold(`Error updating company event: ${error}`));
      return { success: false, error: 'Failed to update event' };
    }
  }

  /**
   * Delete a company event
   */
  public async deleteCompanyEvent(
    companyId: number,
    eventId: number
  ): Promise<any> {
    try {
      const event = await this.prisma.companyEvent.findFirst({
        where: { id: eventId, companyId },
      });

      if (!event) {
        return { success: false, error: 'Event not found' };
      }

      // Delete attachment file if exists
      if (event.attachmentUrl) {
        const filePath = `${process.env['PUBLIC_DIR']}${event.attachmentUrl}`;
        await fs.unlink(filePath).catch(() => {});
      }

      await this.prisma.companyEvent.delete({
        where: { id: eventId },
      });

      return { success: true };
    } catch (error: any) {
      this.logger.log(color.red.bold(`Error deleting company event: ${error}`));
      return { success: false, error: 'Failed to delete company event' };
    }
  }

  // ============================================
  // Bulk Import Companies from Excel
  // ============================================

  /**
   * Import companies (leads) from an Excel export.
   *
   * Columns are matched by header name (case-insensitive), so both the
   * current lead export (Email, First name, Last name, Company name,
   * Phone number, Address, zipcode, Country, ..., Comment) and the older
   * Dutch layout (Bedrijfsnaam, E-mail, Voornaam, Achternaam,
   * Telefoonnummer, Adres, Plaats, Land, zipcode, Categorie, Opmerking)
   * are accepted. Columns without a recognised header are ignored.
   */
  public async importCompaniesFromExcel(
    fileBuffer: Buffer,
    userId: number
  ): Promise<any> {
    try {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(fileBuffer);
      const worksheet = workbook.worksheets[0];

      if (!worksheet || worksheet.rowCount < 2) {
        return { success: false, error: 'Excel file is empty or has no data rows' };
      }

      // Helper to extract text value from exceljs cell
      const getCellText = (cell: any): string => {
        if (cell.value === null || cell.value === undefined) return '';
        // Rich text cells have a 'richText' property
        if (cell.value.richText) {
          return cell.value.richText.map((r: any) => r.text).join('');
        }
        // Hyperlink cells have a 'text' property
        if (cell.value.text) {
          return cell.value.text;
        }
        // Formula cells have a 'result' property
        if (cell.value.result !== undefined) {
          return String(cell.value.result);
        }
        // Regular values
        return String(cell.value);
      };

      // Convert worksheet to array of arrays
      const rows: string[][] = [];
      worksheet.eachRow((row: any) => {
        const rowValues: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
          rowValues[colNumber - 1] = getCellText(cell);
        });
        rows.push(rowValues);
      });

      // Resolve column positions from the header row. Header names are
      // compared after lower-casing and stripping everything that is not a
      // letter or digit, so "E-mail", "Email" and "e_mail" all match.
      const columnAliases: { [field: string]: string[] } = {
        company: ['companyname', 'company', 'bedrijfsnaam', 'bedrijf'],
        email: ['email', 'emailaddress', 'emailadres'],
        firstName: ['firstname', 'voornaam'],
        lastName: ['lastname', 'achternaam'],
        phone: ['phonenumber', 'phone', 'telefoonnummer', 'telefoon'],
        address: ['address', 'adres', 'straat'],
        city: ['city', 'plaats', 'woonplaats'],
        country: ['country', 'land'],
        zipcode: ['zipcode', 'zip', 'postcode'],
        comment: ['comment', 'comments', 'opmerking', 'opmerkingen', 'notes', 'note'],
      };
      const normalizeHeader = (value: string): string =>
        (value ?? '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '');
      const headerRow = rows[0].map(normalizeHeader);
      const columns: { [field: string]: number } = {};
      for (const [fieldName, aliases] of Object.entries(columnAliases)) {
        const index = headerRow.findIndex((header) => aliases.includes(header));
        if (index >= 0) {
          columns[fieldName] = index;
        }
      }

      if (columns.company === undefined) {
        const found = rows[0].filter((header) => header && header.trim()).join(', ');
        return {
          success: false,
          error: `Could not find a company name column in the header row (found: ${found || 'no headers'})`,
        };
      }

      const field = (row: string[], fieldName: string): string => {
        const index = columns[fieldName];
        if (index === undefined) return '';
        return (row[index] ?? '').toString().trim();
      };

      // Skip header row
      const dataRows = rows.slice(1);

      // Country code mapping
      const countryMap: { [key: string]: string } = {
        nederland: 'NL',
        netherlands: 'NL',
        'the netherlands': 'NL',
        holland: 'NL',
        belgium: 'BE',
        belgie: 'BE',
        belgië: 'BE',
        germany: 'DE',
        duitsland: 'DE',
        deutschland: 'DE',
        france: 'FR',
        frankrijk: 'FR',
        uk: 'GB',
        'united kingdom': 'GB',
        'great britain': 'GB',
        england: 'GB',
        'verenigd koninkrijk': 'GB',
        usa: 'US',
        'united states': 'US',
        ireland: 'IE',
        ierland: 'IE',
        luxembourg: 'LU',
        luxemburg: 'LU',
        spain: 'ES',
        spanje: 'ES',
        slovenia: 'SI',
        slovenië: 'SI',
        slovenie: 'SI',
        austria: 'AT',
        oostenrijk: 'AT',
        switzerland: 'CH',
        zwitserland: 'CH',
        italy: 'IT',
        italië: 'IT',
        italie: 'IT',
        portugal: 'PT',
        denmark: 'DK',
        denemarken: 'DK',
        sweden: 'SE',
        zweden: 'SE',
        norway: 'NO',
        noorwegen: 'NO',
        poland: 'PL',
        polen: 'PL',
      };

      // Group rows by company name
      const companiesMap = new Map<string, string[][]>();
      for (const row of dataRows) {
        const companyName = field(row, 'company');
        if (!companyName) continue;

        if (!companiesMap.has(companyName)) {
          companiesMap.set(companyName, []);
        }
        companiesMap.get(companyName)!.push(row);
      }

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];
      const details: any[] = [];

      // Get companyadmin user group
      const companyAdminGroup = await this.prisma.userGroup.findUnique({
        where: { name: 'companyadmin' },
      });

      if (!companyAdminGroup) {
        return { success: false, error: 'companyadmin user group not found' };
      }

      let usersCreatedTotal = 0;

      // Create (or link) a companyadmin user for every contact row that has
      // an e-mail address. Returns the number of users created or linked.
      const createContacts = async (
        companyId: number,
        contactRows: string[][]
      ): Promise<number> => {
        let usersCreated = 0;
        for (const row of contactRows) {
          const email = field(row, 'email').toLowerCase();
          if (!email) continue;

          // Check if user already exists
          const existingUser = await this.prisma.user.findUnique({
            where: { email },
          });

          if (existingUser) {
            // If user exists but has no company, link them
            if (!existingUser.companyId) {
              await this.prisma.user.update({
                where: { id: existingUser.id },
                data: { companyId },
              });
              usersCreated++;
            }
            continue;
          }

          // Create new user
          const userFirstName = field(row, 'firstName');
          const userLastName = field(row, 'lastName');
          const displayName =
            [userFirstName, userLastName].filter(Boolean).join(' ') || email.split('@')[0];

          // Generate unique hash and userId
          const userHash = require('crypto').randomBytes(8).toString('hex').slice(0, 16);
          const userIdStr = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          const newUser = await this.prisma.user.create({
            data: {
              userId: userIdStr,
              email,
              displayName,
              hash: userHash,
              companyId,
              verified: false,
            },
          });

          // Add user to companyadmin group
          await this.prisma.userInGroup.create({
            data: {
              userId: newUser.id,
              groupId: companyAdminGroup.id,
            },
          });

          usersCreated++;
        }
        return usersCreated;
      };

      for (const [companyName, companyRows] of companiesMap) {
        try {
          // Check if company already exists
          const existingCompany = await this.prisma.company.findFirst({
            where: { name: { equals: companyName } },
          });

          if (existingCompany) {
            // Known company: leave it untouched, but still add the contact
            // persons from the sheet that do not exist as users yet.
            const usersCreated = await createContacts(existingCompany.id, companyRows);
            usersCreatedTotal += usersCreated;
            skipped++;
            details.push({
              company: companyName,
              status: 'skipped',
              reason: 'Company already exists',
              companyId: existingCompany.id,
              usersCreated,
            });
            continue;
          }

          // Use first row for company data
          const firstRow = companyRows[0];

          // Extract house number from address ("Hoofdstraat 12a", "Straat, 2")
          const fullAddress = field(firstRow, 'address');
          const addressMatch = fullAddress.match(/^(.+?)[\s,]+(\d+\s*\w*)$/);
          let address = fullAddress;
          let housenumber = '';
          if (addressMatch) {
            address = addressMatch[1].trim();
            housenumber = addressMatch[2].trim();
          }

          // Convert country to code
          const countryRaw = field(firstRow, 'country');
          const countrycode = countryMap[countryRaw.toLowerCase()] || countryRaw;

          // Combine first and last name for contact
          const firstName = field(firstRow, 'firstName');
          const lastName = field(firstRow, 'lastName');
          const contact = [firstName, lastName].filter(Boolean).join(' ');

          // Format phone number
          let phone = field(firstRow, 'phone');
          if (phone.startsWith('00')) {
            // International prefix written as 00 -> +
            phone = '+' + phone.substring(2);
          } else if (phone && !phone.startsWith('+')) {
            // Add Dutch country code if not present
            if (phone.startsWith('0')) {
              phone = '+31' + phone.substring(1);
            } else if (phone.startsWith('6')) {
              phone = '+316' + phone.substring(1);
            } else {
              phone = '+31' + phone;
            }
          }

          // Create company
          const newCompany = await this.prisma.company.create({
            data: {
              name: companyName,
              followUp: false,
              address,
              housenumber,
              city: field(firstRow, 'city'),
              zipcode: field(firstRow, 'zipcode'),
              countrycode,
              contact,
              contactemail: field(firstRow, 'email'),
              contactphone: phone,
            },
          });

          // Create company event from the comment column if present
          const comment = field(firstRow, 'comment');
          if (comment) {
            await this.prisma.companyEvent.create({
              data: {
                companyId: newCompany.id,
                userId,
                type: 'comment',
                content: comment,
              },
            });
          }

          const usersCreated = await createContacts(newCompany.id, companyRows);
          usersCreatedTotal += usersCreated;

          imported++;
          details.push({
            company: companyName,
            status: 'imported',
            companyId: newCompany.id,
            usersCreated,
          });
        } catch (error: any) {
          errors.push(`${companyName}: ${error.message}`);
          details.push({ company: companyName, status: 'error', error: error.message });
        }
      }

      this.logger.log(
        color.green.bold(
          `Imported ${imported} companies, skipped ${skipped}, contacts created: ${usersCreatedTotal}, errors: ${errors.length}`
        )
      );

      return {
        success: true,
        data: {
          imported,
          skipped,
          usersCreated: usersCreatedTotal,
          errors,
          details,
        },
      };
    } catch (error: any) {
      this.logger.log(color.red.bold(`Error importing companies: ${error}`));
      return { success: false, error: `Failed to import companies: ${error.message}` };
    }
  }
}

export default Business;
