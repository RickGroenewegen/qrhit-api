import { PrismaClient, CompanyList } from '@prisma/client'; // Added CompanyList
import Logger from './logger';
import { color } from 'console-log-colors';
import fs from 'fs/promises'; // Added fs
import path from 'path'; // Added path
import Utils from './utils'; // Added Utils

class Vibe {
  private static instance: Vibe;
  private prisma = new PrismaClient();
  private logger = new Logger();
  private utils = new Utils();

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
  public async getState(companyId: number, listId?: number): Promise<any> {
    try {
      if (!companyId) {
        return { success: false, error: 'No company ID provided' };
      }

      // Get company information
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
      });

      if (!company) {
        return { success: false, error: 'Company not found' };
      }

      // Get questions for the list if listId is provided
      let questions: any[] = [];
      let companyList = null;

      if (listId) {
        // Check if company list exists and belongs to the company
        companyList = await this.prisma.companyList.findUnique({
          where: { id: listId },
          select: {
            // Explicitly select fields including the requested ones
            id: true,
            companyId: true,
            name: true,
            description: true,
            slug: true,
            background: true,
            background2: true,
            playlistSource: true, // Ensure playlistSource is selected
            playlistUrl: true, // Ensure playlistUrl is selected
            qrColor: true,
            textColor: true,
            status: true,
            numberOfTracks: true,
            numberOfCards: true,
            createdAt: true,
            updatedAt: true,
            Company: true, // Keep including Company details
          },
        });

        if (companyList && companyList.companyId === companyId) {
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

          this.logger.log(
            color.blue.bold(
              `Retrieved ${color.white.bold(
                questions.length
              )} questions for list ${color.white.bold(companyList.name)}`
            )
          );
        }
      }

      // Return the state object with company info, list info and questions
      return {
        success: true,
        data: {
          company,
          questions,
          list: companyList,
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
   * @param type The type of image ('background' or 'background2').
   * @returns The generated filename or null if an error occurred or no file provided.
   */
  private async processAndSaveImage(
    fileData: any, // Expecting a file part object
    listId: number,
    type: 'background' | 'background2'
  ): Promise<string | null> {
    // Check if fileData exists and has a filename (indicating a file was uploaded)
    if (!fileData || !fileData.filename) {
      this.logger.log(color.yellow.bold(`No file provided for ${type}`));
      return null; // No file uploaded for this field
    }

    console.log(111, listId, type);

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

      this.logger.log(
        color.blue.bold(
          `Retrieved ${color.white.bold(
            companyLists.length
          )} lists for company ${color.white.bold(existingCompany.name)}`
        )
      );

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
   * Get questions for a specific company list
   * @param listId The company list ID to get questions for
   * @returns Object containing list questions
   */
  public async getListQuestions(listId: number): Promise<any> {
    try {
      if (!listId) {
        return { success: false, error: 'No list ID provided' };
      }

      // Check if company list exists
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: listId },
        include: {
          Company: true,
        },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

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
      const questions = questionsWithOptions.map((q) => ({
        ...q,
        options: q.CompanyListQuestionOptions,
        CompanyListQuestionOptions: undefined,
      }));

      this.logger.log(
        color.blue.bold(
          `Retrieved ${color.white.bold(
            questions.length
          )} questions for list ${color.white.bold(companyList.name)}`
        )
      );

      return {
        success: true,
        data: {
          companyList,
          questions,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting company lists: ${error}`));
      return { success: false, error: 'Error retrieving company lists' };
    }
  }

  /**
   * Upsert questions for a specific company list
   * @param listId The company list ID to update questions for
   * @param companyId The company ID to verify ownership
   * @param questions Array of question objects to upsert
   * @returns Object with success status and updated questions
   */
  public async upsertListQuestions(
    listId: number,
    companyId: number,
    questions: any[]
  ): Promise<any> {
    try {
      if (!listId) {
        return { success: false, error: 'No list ID provided' };
      }

      if (!questions || !Array.isArray(questions)) {
        return { success: false, error: 'Invalid questions data' };
      }

      // Check if company list exists and belongs to the company
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: listId },
        include: {
          Company: true,
        },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      // Verify that the list belongs to the company
      if (companyList.companyId !== companyId) {
        return {
          success: false,
          error: 'Company list does not belong to this company',
        };
      }

      // Get existing questions for this list
      const existingQuestions = await this.prisma.companyListQuestion.findMany({
        where: { companyListId: listId },
        include: {
          CompanyListQuestionOptions: true,
        },
      });

      // Create a map of existing question IDs
      const existingQuestionIds = new Set(existingQuestions.map((q) => q.id));

      // Track which question IDs are being updated
      const updatedQuestionIds = new Set<number>();

      // Process each question
      for (const question of questions) {
        if (question.id === 0) {
          // Create new question
          const newQuestion = await this.prisma.companyListQuestion.create({
            data: {
              companyListId: listId,
              question: question.question,
              type: question.type,
            },
          });

          // Add options if they exist
          if (question.options && Array.isArray(question.options)) {
            for (const option of question.options) {
              await this.prisma.companyListQuestionOptions.create({
                data: {
                  questionId: newQuestion.id,
                  name: option.name,
                  value: option.value,
                },
              });
            }
          }

          this.logger.log(
            color.green.bold(
              `Created new question "${color.white.bold(
                question.question
              )}" for list ${color.white.bold(companyList.name)}`
            )
          );
        } else {
          // Update existing question
          if (existingQuestionIds.has(question.id)) {
            await this.prisma.companyListQuestion.update({
              where: { id: question.id },
              data: {
                question: question.question,
                type: question.type,
              },
            });

            // Handle options for existing question
            if (question.options && Array.isArray(question.options)) {
              // Get existing options
              const existingOptions =
                existingQuestions.find((q) => q.id === question.id)
                  ?.CompanyListQuestionOptions || [];

              // Create a map of existing option IDs
              const existingOptionIds = new Set(
                existingOptions.map((o) => o.id)
              );

              // Track which option IDs are being updated
              const updatedOptionIds = new Set<number>();

              // Process each option
              for (const option of question.options) {
                if (!option.id || option.id === 0) {
                  // Create new option
                  await this.prisma.companyListQuestionOptions.create({
                    data: {
                      questionId: question.id,
                      name: option.name,
                      value: option.value,
                    },
                  });
                } else {
                  // Update existing option
                  if (existingOptionIds.has(option.id)) {
                    await this.prisma.companyListQuestionOptions.update({
                      where: { id: option.id },
                      data: {
                        name: option.name,
                        value: option.value,
                      },
                    });
                    updatedOptionIds.add(option.id);
                  }
                }
              }

              // Delete options that are no longer present
              const optionsToDelete = Array.from(existingOptionIds).filter(
                (id) => !updatedOptionIds.has(id)
              );

              if (optionsToDelete.length > 0) {
                await this.prisma.companyListQuestionOptions.deleteMany({
                  where: {
                    id: {
                      in: optionsToDelete,
                    },
                  },
                });
              }
            }

            updatedQuestionIds.add(question.id);
            this.logger.log(
              color.blue.bold(
                `Updated question ${color.white.bold(
                  question.id
                )} for list ${color.white.bold(companyList.name)}`
              )
            );
          } else {
            this.logger.log(
              color.yellow.bold(
                `Question ID ${color.white.bold(
                  question.id
                )} not found for list ${color.white.bold(companyList.name)}`
              )
            );
          }
        }
      }

      // Delete questions that are no longer present
      const questionsToDelete = Array.from(existingQuestionIds).filter(
        (id) => !updatedQuestionIds.has(id)
      );

      if (questionsToDelete.length > 0) {
        await this.prisma.companyListQuestion.deleteMany({
          where: {
            id: {
              in: questionsToDelete,
            },
          },
        });
        this.logger.log(
          color.red.bold(
            `Deleted ${color.white.bold(
              questionsToDelete.length
            )} questions for list ${color.white.bold(companyList.name)}`
          )
        );
      }

      // Get the updated list of questions with their options
      const updatedQuestionsWithOptions =
        await this.prisma.companyListQuestion.findMany({
          where: { companyListId: listId },
          orderBy: { createdAt: 'asc' },
          include: {
            CompanyListQuestionOptions: true,
          },
        });

      // Transform the questions to rename CompanyListQuestionOptions to options
      const updatedQuestions = updatedQuestionsWithOptions.map((q) => ({
        ...q,
        options: q.CompanyListQuestionOptions,
        CompanyListQuestionOptions: undefined,
      }));

      // Update the list status to 'questions' if it's in an earlier state
      const updatedStatus = this.getUpdatedStatus(
        companyList.status,
        'questions'
      );
      if (updatedStatus !== companyList.status) {
        await this.prisma.companyList.update({
          where: { id: listId },
          data: { status: updatedStatus },
        });

        // Refresh the company list data
        const updatedCompanyList = await this.prisma.companyList.findUnique({
          where: { id: listId },
          include: { Company: true },
        });

        if (updatedCompanyList) {
          this.logger.log(
            color.green.bold(
              `Updated list status to ${color.white.bold(
                updatedStatus
              )} for list ${color.white.bold(updatedCompanyList.name)}`
            )
          );
          return {
            success: true,
            data: {
              companyList: updatedCompanyList,
              questions: updatedQuestions,
            },
          };
        }
      }

      return {
        success: true,
        data: {
          companyList,
          questions: updatedQuestions,
        },
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error upserting list questions: ${error}`)
      );
      return { success: false, error: 'Error upserting list questions' };
    }
  }

  /**
   * Update box design settings for a company list
   * @param listId The company list ID to update
   * @param companyId The company ID to verify ownership
   * @param ownBoxDesign Boolean indicating if company has own box design
   * @param designFile Optional file upload for custom box design
   * @returns Object with success status and updated company list
   */
  public async updateBoxDesign(
    listId: number,
    companyId: number,
    ownBoxDesign: boolean,
    designFile?: any
  ): Promise<any> {
    try {
      if (!listId) {
        return { success: false, error: 'No list ID provided' };
      }

      // Check if company list exists and belongs to the company
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: listId },
        include: {
          Company: true,
        },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      // Verify that the list belongs to the company
      if (companyList.companyId !== companyId) {
        return {
          success: false,
          error: 'Company list does not belong to this company',
        };
      }

      // Prepare update data
      const updateData: any = {
        ownBoxDesign: ownBoxDesign,
      };

      // Handle file upload if ownBoxDesign is true and a file was provided
      if (ownBoxDesign && designFile) {
        try {
          // Create directory if it doesn't exist
          const backgroundDir = `${process.env['PUBLIC_DIR']}/companydata`;
          const fs = require('fs');
          const util = require('util');
          const mkdir = util.promisify(fs.mkdir);
          const writeFile = util.promisify(fs.writeFile);

          try {
            await mkdir(backgroundDir, { recursive: true });
          } catch (error) {
            this.logger.log(
              color.red.bold(
                `Error creating company data directory: ${color.white.bold(
                  error
                )}`
              )
            );
          }

          // Generate a unique filename
          const fileExtension = designFile.filename.split('.').pop();
          const uniqueFilename = `box_design_${listId}_${Date.now()}.${fileExtension}`;
          const filePath = `${backgroundDir}/${uniqueFilename}`;

          // Save the file
          const buffer = await designFile.toBuffer();
          await writeFile(filePath, buffer);

          // Update the filename in the database
          updateData.ownBoxDesignFilename = uniqueFilename;

          this.logger.log(
            color.green.bold(
              `Saved box design file ${color.white.bold(
                uniqueFilename
              )} for list ${color.white.bold(companyList.name)}`
            )
          );
        } catch (error) {
          this.logger.log(
            color.red.bold(
              `Error saving box design file: ${color.white.bold(error)}`
            )
          );
          return { success: false, error: 'Error saving box design file' };
        }
      }

      // Update the list status to 'box' if it's in an earlier state
      const updatedStatus = this.getUpdatedStatus(companyList.status, 'box');
      if (updatedStatus !== companyList.status) {
        updateData.status = updatedStatus;
      }

      // Update the company list
      const updatedCompanyList = await this.prisma.companyList.update({
        where: { id: listId },
        data: updateData,
        include: {
          Company: true,
        },
      });

      this.logger.log(
        color.green.bold(
          `Updated box design for list ${color.white.bold(
            updatedCompanyList.name
          )}`
        )
      );

      return {
        success: true,
        data: {
          companyList: updatedCompanyList,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error updating box design: ${error}`));
      return { success: false, error: 'Error updating box design' };
    }
  }

  /**
   * Update card design settings for a company list
   * @param listId The company list ID to update
   * @param companyId The company ID to verify ownership
   * @param images Object containing base64 strings for background and background2
   * @param colors Object containing qrColor and textColor
   * @returns Object with success status and updated company list
   */
  public async updateCardDesign(
    listId: number,
    companyId: number,
    images: { background?: string; background2?: string },
    colors: { qrColor?: string; textColor?: string }
  ): Promise<any> {
    try {
      if (!listId) {
        return { success: false, error: 'No list ID provided' };
      }

      // Check if company list exists and belongs to the company
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: listId },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      // Verify that the list belongs to the company
      if (companyList.companyId !== companyId) {
        return {
          success: false,
          error: 'Company list does not belong to this company',
        };
      }

      // Process and save images from base64 strings
      const backgroundFilename = await this.processAndSaveImage(
        images.background,
        listId,
        'background'
      );
      const background2Filename = await this.processAndSaveImage(
        images.background2,
        listId,
        'background2'
      );

      // Prepare update data - only include fields that were successfully processed or provided
      const updateData: Partial<CompanyList> = {};
      if (backgroundFilename !== null) {
        updateData.background = backgroundFilename;
      }
      if (background2Filename !== null) {
        updateData.background2 = background2Filename;
      }
      if (colors.qrColor) {
        updateData.qrColor = colors.qrColor;
      }
      if (colors.textColor) {
        updateData.textColor = colors.textColor;
      }

      // Update the list status to 'card' if it's in an earlier state
      const updatedStatus = this.getUpdatedStatus(companyList.status, 'card');
      if (updatedStatus !== companyList.status) {
        updateData.status = updatedStatus;
      }

      // Only update if there's something to change
      if (Object.keys(updateData).length === 0) {
        this.logger.log(
          color.yellow.bold(
            `No card design data provided or processed for list ${color.white.bold(
              companyList.name
            )}`
          )
        );
        // Return current list data if nothing changed
        return {
          success: true,
          data: { companyList },
        };
      }

      // Update the company list
      const updatedCompanyList = await this.prisma.companyList.update({
        where: { id: listId },
        data: updateData,
        include: {
          Company: true, // Include company details if needed
        },
      });

      this.logger.log(
        color.green.bold(
          `Updated card design for list ${color.white.bold(
            updatedCompanyList.name
          )}`
        )
      );

      return {
        success: true,
        data: {
          companyList: updatedCompanyList,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error updating card design: ${error}`));
      return { success: false, error: 'Error updating card design' };
    }
  }

  /**
   * Get all companies
   * @returns Object with success status and array of companies
   */
  public async getAllCompanies(): Promise<any> {
    try {
      // Fetch companies and include a count of their lists
      const companiesWithListCount = await this.prisma.company.findMany({
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
      }));

      this.logger.log(
        color.blue.bold(
          `Retrieved ${color.white.bold(companies.length)} companies`
        )
      );

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
  public async createCompany(name: string): Promise<any> {
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
      description: string;
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
        description,
        slug,
        numberOfCards,
        numberOfTracks,
        playlistSource,
        playlistUrl,
      } = listData;

      // Basic validation
      if (!companyId || isNaN(companyId)) {
        return { success: false, error: 'Invalid company ID provided' };
      }
      if (
        !name ||
        !description ||
        !slug ||
        numberOfCards === undefined ||
        numberOfTracks === undefined
      ) {
        return {
          success: false,
          error: 'Missing required fields for company list',
        };
      }
      if (
        isNaN(numberOfCards) ||
        isNaN(numberOfTracks) ||
        numberOfCards < 0 ||
        numberOfTracks < 0
      ) {
        return { success: false, error: 'Invalid number for cards or tracks' };
      }

      // Check if company exists
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
      });
      if (!company) {
        return { success: false, error: 'Company not found' };
      }

      // Check if slug is unique for this company (optional, but good practice)
      const existingListWithSlug = await this.prisma.companyList.findFirst({
        where: {
          companyId: companyId,
          slug: slug,
        },
      });
      if (existingListWithSlug) {
        return {
          success: false,
          error: 'Slug already exists for this company',
        };
      }

      // Create the new company list
      const newList = await this.prisma.companyList.create({
        data: {
          companyId: companyId,
          name: name,
          description: description,
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
        return {
          success: false,
          error: 'Slug already exists for this company',
        };
      }
      return { success: false, error: 'Error creating company list' };
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

      console.log('Starting multipart processing...');

      for await (const part of parts) {
        console.log(`Processing part: type=${part.type}, fieldname=${part.fieldname}`);

        if (part.type === 'file') {
          // Process expected image files immediately
          if (part.fieldname === 'background') {
            console.log('Processing background file...');
            const backgroundFilename = await this.processAndSaveImage(
              part, // Pass the file part object directly
              listId,
              'background'
            );
            if (backgroundFilename !== null) {
              updateData.background = backgroundFilename;
              console.log(`Stored background filename: ${backgroundFilename}`);
            } else {
               console.log('Background file processing returned null.');
            }
          } else if (part.fieldname === 'background2') {
             console.log('Processing background2 file...');
            const background2Filename = await this.processAndSaveImage(
              part, // Pass the file part object directly
              listId,
              'background2'
            );
            if (background2Filename !== null) {
              updateData.background2 = background2Filename;
              console.log(`Stored background2 filename: ${background2Filename}`);
            } else {
               console.log('Background2 file processing returned null.');
            }
          } else {
            // Drain any other unexpected file streams to prevent hanging
            this.logger.log(
              color.yellow.bold(
                `Ignoring and draining unexpected file field: ${part.fieldname}`
              )
            );
             console.log(`Draining unexpected file: ${part.fieldname}`);
            try {
               await part.toBuffer(); // Consume the stream fully
               console.log(`Drained unexpected file: ${part.fieldname}`);
            } catch (drainError) {
               this.logger.log(color.red.bold(`Error draining file ${part.fieldname}: ${drainError}`));
               console.error(`Error draining file ${part.fieldname}:`, drainError);
               // Decide if we should abort or continue
               // For now, we log and continue
            }
          }
        } else {
          // Handle regular fields - store them for later processing
          fields[part.fieldname] = part.value;
           console.log(`Stored field: ${part.fieldname} = ${part.value}`);
        }
      }

       console.log('Finished multipart processing loop.');

      // Add text and numeric fields from the collected 'fields' object
      if (fields.name !== undefined) updateData.name = String(fields.name);
      if (fields.description !== undefined)
        updateData.description = String(fields.description);
      if (fields.playlistSource !== undefined)
        updateData.playlistSource = String(fields.playlistSource);
      if (fields.playlistUrl !== undefined)
        updateData.playlistUrl = String(fields.playlistUrl);
      if (fields.qrColor !== undefined)
        updateData.qrColor = String(fields.qrColor);
      if (fields.textColor !== undefined)
        updateData.textColor = String(fields.textColor);

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

      // Update status if provided
      if (fields.status !== undefined) {
        // updateData.status = String(fields.status); // Add status update logic if needed
      }

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
        // Return current list data if nothing changed
        return {
          success: true,
          data: { list },
        };
      }

      // Update the company list
      const updatedList = await this.prisma.companyList.update({
        where: { id: listId },
        data: updateData,
      });

      this.logger.log(
        color.green.bold(
          `Updated list "${color.white.bold(
            updatedList.name
          )}" (ID: ${listId}) for company ID ${companyId}`
        )
      );

      return {
        success: true,
        data: {
          list: updatedList,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error updating company list: ${error}`));
      console.log(error);
      return { success: false, error: 'Error updating company list' };
    }
  }
}

export default Vibe;
