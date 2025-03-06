import { ApiResult } from './interfaces/ApiResult';
import { TrustpilotReview } from './interfaces/TrustpilotReview';
import { TrustpilotCompany } from './interfaces/TrustpilotCompany';
import Cache from './cache';
import Utils from './utils';
import AnalyticsClient from './analytics';
import Logger from './logger';
import { Prisma } from '@prisma/client';
import PrismaInstance from './prisma';
import axios from 'axios';
import cluster from 'cluster';
import { CronJob } from 'cron';
import { color } from 'console-log-colors';

class Trustpilot {
  private cache = Cache.getInstance();
  private utils = new Utils();
  private logger = new Logger();
  private analytics = AnalyticsClient.getInstance();
  private prisma = PrismaInstance.getInstance();
  private static instance: Trustpilot;
  private trustPilot = this.prisma.trustPilot;
  private supportedLocales: string[] = ['en-US', 'nl-NL'];

  private constructor() {
    if (!process.env.RAPID_API_KEY) {
      throw new Error('RAPID_API_KEY environment variable is not defined');
    }
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] == 'development') {
          // Initial fetch of reviews
          await this.fetchReviewsFromAPI();

          // Set up cron job to run at 2 AM every day
          const job = new CronJob('0 2 * * *', async () => {
            this.logger.log(
              color.blue.bold('Running scheduled Trustpilot review fetch')
            );
            await this.fetchReviewsFromAPI();
          });
          job.start();
        }
      });
    }
  }

  public static getInstance(): Trustpilot {
    if (!Trustpilot.instance) {
      Trustpilot.instance = new Trustpilot();
    }
    return Trustpilot.instance;
  }

  /**
   * Fetches reviews from Trustpilot API and stores them in the database
   */
  private async fetchReviewsFromAPI(): Promise<void> {
    try {
      this.logger.log(
        color.blue.bold(
          'Fetching Trustpilot reviews from API for all supported locales'
        )
      );

      let totalReviews = 0;
      let newOrUpdatedReviews: any[] = [];

      // Loop through all supported locales
      for (const locale of this.supportedLocales) {
        this.logger.log(
          color.blue.bold(
            `Fetching reviews for locale: ${color.white.bold(locale)}`
          )
        );

        const options = {
          method: 'GET',
          url: 'https://trustpilot-company-and-reviews-data.p.rapidapi.com/company-reviews',
          params: {
            company_domain: 'qrsong.io',
            date_posted: 'any',
            rating: '5',
            locale: locale,
          },
          headers: {
            'x-rapidapi-key': process.env.RAPID_API_KEY,
            'x-rapidapi-host':
              'trustpilot-company-and-reviews-data.p.rapidapi.com',
          },
        };

        const response = await axios.request(options);
        const reviews = response.data.data.reviews;

        this.logger.log(
          color.blue.bold(
            `Retrieved ${color.white.bold(
              reviews.length
            )} reviews from Trustpilot API for locale ${color.white.bold(
              locale
            )}`
          )
        );

        totalReviews += reviews.length;

        // Process each review and store in database
        for (const review of reviews) {
          // First check if a review with this name already exists
          const existingReview = await this.prisma.trustPilot.findFirst({
            where: {
              name: review.consumer_name,
            },
          });

          if (existingReview) {
            // Update existing review
            await this.prisma.trustPilot.update({
              where: {
                id: existingReview.id,
              },
              data: {
                country: review.consumer_country || '',
                title: review.review_title || '',
                message: review.review_text || '',
                rating: review.review_rating,
                image: review.consumer_image || '',
                locale: locale,
                updatedAt: new Date(),
              },
            });
            newOrUpdatedReviews.push(existingReview.id);
          } else {
            // Create new review
            const newReview = await this.prisma.trustPilot.create({
              data: {
                name: review.consumer_name,
                country: review.consumer_country || '',
                title: review.review_title || '',
                message: review.review_text || '',
                rating: review.review_rating,
                image: review.consumer_image || '',
                locale: locale,
              },
            });
            newOrUpdatedReviews.push(newReview.id);
          }
        }

        // Add a small delay between requests to avoid rate limiting
        if (
          locale !== this.supportedLocales[this.supportedLocales.length - 1]
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      this.logger.log(
        color.green.bold(
          `Stored a total of ${color.white.bold(
            totalReviews
          )} Trustpilot reviews in database`
        )
      );

      // Clear cache to ensure fresh data is served
      const today = new Date().toISOString().split('T')[0];
      const cacheKey = `trustpilot_reviews_${today}`;
      await this.cache.del(cacheKey);

      // Translate reviews if needed
      if (newOrUpdatedReviews.length > 0) {
        this.logger.log(
          color.blue.bold(
            `Translating ${color.white.bold(
              newOrUpdatedReviews.length
            )} new or updated reviews`
          )
        );
        
        // Get the reviews that need translation
        const reviewsToTranslate = await this.prisma.trustPilot.findMany({
          where: {
            id: {
              in: newOrUpdatedReviews
            }
          }
        });
        
        // Import ChatGPT and translate reviews
        const { ChatGPT } = await import('./chatgpt');
        const openai = new ChatGPT();
        await openai.translateTrustpilotReviews(reviewsToTranslate);
      }
    } catch (error: any) {
      this.logger.log(
        color.red.bold('Error fetching and storing Trustpilot reviews')
      );
      console.log(error);
    }
  }

  /**
   * Gets reviews from the database
   */
  public async getReviews(cache: boolean = true): Promise<ApiResult> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const cacheKey = `trustpilot_reviews_${today}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult && cache) {
        return JSON.parse(cacheResult);
      }

      // Fetch reviews from database
      const dbReviews = await this.prisma.trustPilot.findMany({
        orderBy: {
          updatedAt: 'desc',
        },
      });

      // Map database records to TrustpilotReview format
      const reviews: TrustpilotReview[] = dbReviews.map((review) => ({
        id: review.id.toString(),
        stars: review.rating,
        title: review.title,
        text: review.message,
        author: review.name,
        date: review.updatedAt.toISOString(),
        authorImage: review.image,
        authorCountry: review.country,
        authorReviewCount: 1, // Default since we don't store this
        isVerified: false, // Default since we don't store this
      }));

      const result = {
        success: true,
        reviews,
      };

      // Cache for 1 hour
      await this.cache.set(cacheKey, JSON.stringify(result), 3600);

      return result;
    } catch (error: any) {
      this.logger.log(
        color.red.bold('Error fetching Trustpilot reviews from database')
      );
      console.log(error);
      return {
        success: false,
        error: 'Error fetching Trustpilot reviews from database',
      };
    }
  }

  /**
   * Translates existing reviews that don't have translations
   */
  public async translateExistingReviews(): Promise<void> {
    try {
      this.logger.log(
        color.blue.bold('Finding reviews that need translation')
      );
      
      // Find reviews that have empty translations
      // We'll check for title_en as a proxy for all translations
      const reviewsToTranslate = await this.prisma.trustPilot.findMany({
        where: {
          OR: [
            { title_en: null },
            { title_en: '' }
          ]
        }
      });
      
      if (reviewsToTranslate.length === 0) {
        this.logger.log(
          color.green.bold('No reviews need translation')
        );
        return;
      }
      
      this.logger.log(
        color.blue.bold(
          `Found ${color.white.bold(
            reviewsToTranslate.length
          )} reviews that need translation`
        )
      );
      
      // Import ChatGPT and translate reviews
      const { ChatGPT } = await import('./chatgpt');
      const openai = new ChatGPT();
      await openai.translateTrustpilotReviews(reviewsToTranslate);
      
    } catch (error: any) {
      this.logger.log(
        color.red.bold('Error translating existing reviews')
      );
      console.log(error);
    }
  }

  public async getCompanyDetails(cache: boolean = true): Promise<ApiResult> {
    try {
      const cacheKey = 'trustpilot_company';
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult && cache) {
        return JSON.parse(cacheResult);
      }

      const options = {
        method: 'GET',
        url: 'https://trustpilot-company-and-reviews-data.p.rapidapi.com/company-details',
        params: {
          company_domain: 'qrsong.io',
          locale: 'en-US',
        },
        headers: {
          'x-rapidapi-key': process.env.RAPID_API_KEY,
          'x-rapidapi-host':
            'trustpilot-company-and-reviews-data.p.rapidapi.com',
        },
      };

      const response = await axios.request(options);
      const data = response.data.data;

      const company: TrustpilotCompany = {
        trust_score: data.company.trust_score,
        review_count: data.company.review_count,
        rating: data.company.rating,
      };

      const result = {
        success: true,
        company,
      };

      // Cache for 24 hours
      await this.cache.set(cacheKey, JSON.stringify(result), 86400);

      return result;
    } catch (error: any) {
      this.logger.log(
        color.red.bold('Error fetching Trustpilot company details')
      );
      console.log(error);
      return {
        success: false,
        error: 'Error fetching Trustpilot company details',
      };
    }
  }
}

export default Trustpilot;
