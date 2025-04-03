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
   * @returns Object containing company information
   */
  public async getState(companyId: number): Promise<any> {
    try {
      if (!companyId) {
        return { success: false, error: 'No company ID provided' };
      }

      // Get company information
      const company = await this.prisma.company.findUnique({
        where: { id: companyId }
      });
      
      if (!company) {
        return { success: false, error: 'Company not found' };
      }
      
      // Return the state object with company info
      return {
        success: true,
        data: {
          company
        }
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting vibe state: ${error}`));
      return { success: false, error: 'Error retrieving company state' };
    }
  }
}

export default Vibe;
