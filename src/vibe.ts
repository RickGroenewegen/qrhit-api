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
          include: {
            Company: true,
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
   * Processes and saves an uploaded image file.
   * @param fileData The file data object from Fastify multipart.
   * @param listId The ID of the company list.
   * @param type The type of image ('background' or 'background2').
   * @returns The generated filename or null if an error occurred or no file provided.
   */
  private async processAndSaveImage(
    fileData: any,
    listId: number,
    type: 'background' | 'background2'
  ): Promise<string | null> {
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

      // Generate unique filename using utils.generateRandomString
      const uniqueId = this.utils.generateRandomString(32);
      const fileExtension =
        path.extname(fileData.filename).toLowerCase() || '.png'; // Default to png if no extension
      // Ensure filename includes listId and type for clarity, though uniqueId should suffice
      const actualFilename = `card_${type}_${listId}_${uniqueId}${fileExtension}`;
      const filePath = path.join(backgroundsDir, actualFilename);

      // Get file buffer
      const buffer = await fileData.toBuffer();

      // Write the file (simple save, like designer.ts logo upload)
      await fs.writeFile(filePath, buffer);

      this.logger.log(
        color.green.bold(
          `Card image saved successfully: ${color.white.bold(filePath)}`
        )
      );

      // Return the relative path for storage in DB
      return `/public/companydata/backgrounds/${actualFilename}`;
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
   * @param files Object containing file uploads for background and background2
   * @param colors Object containing qrColor and textColor
   * @returns Object with success status and updated company list
   */
  public async updateCardDesign(
    listId: number,
    companyId: number,
    files: { background?: any; background2?: any },
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

      // Process and save images
      const backgroundFilename = await this.processAndSaveImage(
        files.background,
        listId,
        'background'
      );
      const background2Filename = await this.processAndSaveImage(
        files.background2,
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
      const companies = await this.prisma.company.findMany({
        orderBy: { name: 'asc' },
      });

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
        return { success: false, error: 'Company with this name already exists' };
      }

      const newCompany = await this.prisma.company.create({
        data: {
          name: name.trim(), // Trim whitespace
        },
      });

      this.logger.log(
        color.green.bold(
          `Created new company: ${color.white.bold(newCompany.name)} (ID: ${newCompany.id})`
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
}

export default Vibe;
