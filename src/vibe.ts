import { PrismaClient } from '@prisma/client';
import Logger from './logger';
import { color } from 'console-log-colors';

class Vibe {
  private static instance: Vibe;
  private prisma = new PrismaClient();
  private logger = new Logger();

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
          const questionsWithOptions = await this.prisma.companyListQuestion.findMany({
            where: { companyListId: listId },
            orderBy: { createdAt: 'asc' },
            include: {
              CompanyListQuestionOptions: true
            }
          });
          
          // Transform the questions to rename CompanyListQuestionOptions to options
          questions = questionsWithOptions.map(q => ({
            ...q,
            options: q.CompanyListQuestionOptions,
            CompanyListQuestionOptions: undefined
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

      // Return the state object with company info and questions
      return {
        success: true,
        data: {
          company,
          questions,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting vibe state: ${error}`));
      return { success: false, error: 'Error retrieving company state' };
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
      const questionsWithOptions = await this.prisma.companyListQuestion.findMany({
        where: { companyListId: listId },
        orderBy: { createdAt: 'asc' },
        include: {
          CompanyListQuestionOptions: true
        }
      });
      
      // Transform the questions to rename CompanyListQuestionOptions to options
      const questions = questionsWithOptions.map(q => ({
        ...q,
        options: q.CompanyListQuestionOptions,
        CompanyListQuestionOptions: undefined
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
      });

      // Create a map of existing question IDs
      const existingQuestionIds = new Set(existingQuestions.map((q) => q.id));

      // Track which question IDs are being updated
      const updatedQuestionIds = new Set<number>();

      // Process each question
      for (const question of questions) {
        if (question.id === 0) {
          // Create new question
          await this.prisma.companyListQuestion.create({
            data: {
              companyListId: listId,
              question: question.question,
              type: question.type,
            },
          });
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
      const updatedQuestionsWithOptions = await this.prisma.companyListQuestion.findMany({
        where: { companyListId: listId },
        orderBy: { createdAt: 'asc' },
        include: {
          CompanyListQuestionOptions: true
        }
      });
      
      // Transform the questions to rename CompanyListQuestionOptions to options
      const updatedQuestions = updatedQuestionsWithOptions.map(q => ({
        ...q,
        options: q.CompanyListQuestionOptions,
        CompanyListQuestionOptions: undefined
      }));

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
}

export default Vibe;
