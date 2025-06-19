import { ApiResult } from './interfaces/ApiResult';
import { TrustpilotReview } from './interfaces/TrustpilotReview';
import { TrustpilotCompany } from './interfaces/TrustpilotCompany';
import Cache from './cache';
import Utils from './utils';
import Logger from './logger';
import PrismaInstance from './prisma';
import axios from 'axios';
import cluster from 'cluster';
import { CronJob } from 'cron';
import { color } from 'console-log-colors';
import Translation from './translation';

class Trustpilot {
  private cache = Cache.getInstance();
  private utils = new Utils();
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private static instance: Trustpilot;
  private supportedLocales: string[] = ['en-US', 'nl-NL', 'es-ES'];
  private translation = new Translation();

  private constructor() {
    if (!process.env.RAPID_API_KEY) {
      throw new Error('RAPID_API_KEY environment variable is not defined');
    }
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer) {
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
            const updateData: any = {
              country: review.consumer_country || '',
              rating: review.review_rating,
              image: review.consumer_image || '',
              locale: locale,
              updatedAt: new Date(),
            };

            // Store the original title and message in the locale-specific fields
            // based on the current locale (en-US -> title_en, nl-NL -> title_nl)
            const langCode = locale.split('-')[0].toLowerCase();
            updateData[`title_${langCode}`] = review.review_title || '';
            updateData[`message_${langCode}`] = review.review_text || '';

            await this.prisma.trustPilot.update({
              where: {
                id: existingReview.id,
              },
              data: updateData,
            });
            newOrUpdatedReviews.push(existingReview.id);
          } else {
            // Create new review with all required fields
            // Include all the locale-specific fields with empty strings
            const createData: any = {
              name: review.consumer_name,
              country: review.consumer_country || '',
              rating: review.review_rating,
              image: review.consumer_image || '',
              locale: locale,
            };

            // Add all locale-specific fields with empty values
            for (const lang of this.translation.allLocales) {
              createData[`title_${lang}`] = '';
              createData[`message_${lang}`] = '';
            }

            // Set the values for the current locale
            const langCode = locale.split('-')[0].toLowerCase();
            createData[`title_${langCode}`] = review.review_title || '';
            createData[`message_${langCode}`] = review.review_text || '';

            const newReview = await this.prisma.trustPilot.create({
              data: createData,
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
              in: newOrUpdatedReviews,
            },
          },
        });

        // Import ChatGPT and translate reviews
        const { ChatGPT } = await import('./chatgpt');
        const openai = new ChatGPT();
        await openai.translateTrustpilotReviews(reviewsToTranslate);
      }
    } catch (error: any) {
      this.logger.log(
        color.yellow.bold('Error fetching and storing Trustpilot reviews')
      );
    }
  }

  /**
   * Gets reviews from the database
   */
  public async getReviews(
    cache: boolean = true,
    amount: number | string = 0,
    locale: string = 'en',
    landingPage: boolean = false
  ): Promise<ApiResult> {
    try {
      let landingPageInt = 0;
      if (landingPage) {
        landingPageInt = 1;
      }

      // Convert amount to number if it's a string
      const amountNum = typeof amount === 'string' ? parseInt(amount) : amount;

      const today = new Date().toISOString().split('T')[0];
      const cacheKey = `trustpilot_reviews_${today}_${amountNum}_${locale}_${landingPageInt}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult && cache) {
        return JSON.parse(cacheResult);
      }

      // Fetch reviews from database with limit if amount is specified
      const dbReviews = await this.prisma.trustPilot.findMany({
        orderBy: {
          updatedAt: 'desc',
        },
        where: landingPage ? { landingPage: true } : undefined,
        ...(amountNum > 0 ? { take: amountNum } : {}),
      });

      // Map database records to TrustpilotReview format
      const reviews: TrustpilotReview[] = dbReviews.map((review) => {
        // Get the appropriate locale-specific title and message
        // Default to English if the requested locale isn't available
        const requestedLocale = locale.toLowerCase();
        const title = review[`title_${requestedLocale}` as keyof typeof review];
        const text =
          review[`message_${requestedLocale}` as keyof typeof review];

        return {
          id: review.id.toString(),
          stars: review.rating,
          title: title as string,
          text: text as string,
          author: review.name,
          date: review.updatedAt.toISOString(),
          authorImage: review.image,
          authorCountry: review.country,
          authorReviewCount: 1, // Default since we don't store this
          isVerified: false, // Default since we don't store this
        };
      });

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
      this.logger.log(color.blue.bold('Finding reviews that need translation'));

      // Find reviews that need translation
      const orConditions: { [key: string]: string }[] =
        this.translation.allLocales.map((lang: string) => ({
          [`title_${lang}`]: '',
        }));

      const reviewsToTranslate = await this.prisma.trustPilot.findMany({
        where: {
          OR: orConditions,
        },
      });

      if (reviewsToTranslate.length === 0) {
        this.logger.log(color.green.bold('No reviews need translation'));
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
      this.logger.log(color.red.bold('Error translating existing reviews'));
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
        color.yellow.bold('Error fetching Trustpilot company details')
      );
      return {
        success: false,
        error: 'Error fetching Trustpilot company details',
      };
    }
  }
}

export default Trustpilot;
