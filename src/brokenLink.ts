import PrismaInstance from './prisma';
import Logger from './logger';

class BrokenLink {
  private static instance: BrokenLink;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): BrokenLink {
    if (!BrokenLink.instance) {
      BrokenLink.instance = new BrokenLink();
    }
    return BrokenLink.instance;
  }

  /**
   * Log a broken link to the database
   * @param params Object containing url, type, errorType, serviceType, userAgent
   * @returns Promise with success status and optional id
   */
  public async logBrokenLink(params: {
    url: string;
    type: 'invalid' | 'non-retrievable';
    errorType: string;
    serviceType?: string | null;
    userAgent?: string | null;
  }): Promise<{ success: boolean; id?: number; error?: string }> {
    try {
      const { url, type, errorType, serviceType, userAgent } = params;

      // Validate required fields
      if (!url || !type || !errorType) {
        return { success: false, error: 'Missing required fields' };
      }

      // Validate type value
      if (type !== 'invalid' && type !== 'non-retrievable') {
        return { success: false, error: 'Invalid type. Must be "invalid" or "non-retrievable"' };
      }

      // Check for duplicate URL within the last hour (rate limiting)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const existingLink = await this.prisma.brokenLink.findFirst({
        where: {
          url: url,
          createdAt: {
            gte: oneHourAgo,
          },
        },
      });

      if (existingLink) {
        // Already logged recently, skip duplicate
        return { success: true, id: existingLink.id };
      }

      const brokenLink = await this.prisma.brokenLink.create({
        data: {
          url,
          type,
          errorType,
          serviceType: serviceType || null,
          userAgent: userAgent || null,
        },
      });

      return { success: true, id: brokenLink.id };
    } catch (error) {
      this.logger.log(`Error logging broken link: ${error}`);
      return { success: false, error: 'Failed to log broken link' };
    }
  }

  /**
   * Get all broken links with optional filtering and pagination
   * @param params Optional filter parameters
   * @returns Promise with success status and data array
   */
  public async getBrokenLinks(params?: {
    type?: string;
    serviceType?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ success: boolean; data?: any[]; total?: number; error?: string }> {
    try {
      const { type, serviceType, limit = 50, offset = 0 } = params || {};

      const where: any = {};
      if (type) {
        where.type = type;
      }
      if (serviceType) {
        where.serviceType = serviceType;
      }

      const [data, total] = await Promise.all([
        this.prisma.brokenLink.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        this.prisma.brokenLink.count({ where }),
      ]);

      return { success: true, data, total };
    } catch (error) {
      this.logger.log(`Error fetching broken links: ${error}`);
      return { success: false, error: 'Failed to fetch broken links' };
    }
  }

  /**
   * Get count of broken links (excludes ignored links)
   * @returns Promise with success status and count
   */
  public async getBrokenLinksCount(): Promise<{ success: boolean; count?: number; error?: string }> {
    try {
      const count = await this.prisma.brokenLink.count({
        where: { ignored: false },
      });
      return { success: true, count };
    } catch (error) {
      this.logger.log(`Error counting broken links: ${error}`);
      return { success: false, error: 'Failed to count broken links' };
    }
  }

  /**
   * Toggle ignored status of a broken link
   * @param id The broken link ID
   * @returns Promise with success status and new ignored state
   */
  public async toggleIgnored(id: number): Promise<{ success: boolean; ignored?: boolean; error?: string }> {
    try {
      const link = await this.prisma.brokenLink.findUnique({
        where: { id },
        select: { ignored: true },
      });

      if (!link) {
        return { success: false, error: 'Broken link not found' };
      }

      const updated = await this.prisma.brokenLink.update({
        where: { id },
        data: { ignored: !link.ignored },
      });

      return { success: true, ignored: updated.ignored };
    } catch (error) {
      this.logger.log(`Error toggling ignored status: ${error}`);
      return { success: false, error: 'Failed to toggle ignored status' };
    }
  }

  /**
   * Delete a broken link by ID
   * @param id The broken link ID
   * @returns Promise with success status
   */
  public async deleteBrokenLink(id: number): Promise<{ success: boolean; error?: string }> {
    try {
      await this.prisma.brokenLink.delete({
        where: { id },
      });
      return { success: true };
    } catch (error) {
      this.logger.log(`Error deleting broken link: ${error}`);
      return { success: false, error: 'Failed to delete broken link' };
    }
  }

  /**
   * Delete all broken links (bulk cleanup)
   * @returns Promise with success status and deleted count
   */
  public async deleteAllBrokenLinks(): Promise<{ success: boolean; deleted?: number; error?: string }> {
    try {
      const result = await this.prisma.brokenLink.deleteMany();
      return { success: true, deleted: result.count };
    } catch (error) {
      this.logger.log(`Error deleting all broken links: ${error}`);
      return { success: false, error: 'Failed to delete broken links' };
    }
  }
}

export default BrokenLink;
