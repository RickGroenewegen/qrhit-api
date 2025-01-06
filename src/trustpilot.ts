import { ApiResult } from './interfaces/ApiResult';
import { TrustpilotReview } from './interfaces/TrustpilotReview';
import Cache from './cache';
import Utils from './utils';
import AnalyticsClient from './analytics';
import Logger from './logger';
import PrismaInstance from './prisma';
import axios from 'axios';

class Trustpilot {
  private cache = Cache.getInstance();
  private utils = new Utils();
  private analytics = AnalyticsClient.getInstance();
  private prisma = PrismaInstance.getInstance();
  private static instance: Trustpilot;

  private constructor() {
    if (!process.env.RAPID_API_KEY) {
      throw new Error('RAPID_API_KEY environment variable is not defined');
    }
  }

  public static getInstance(): Trustpilot {
    if (!Trustpilot.instance) {
      Trustpilot.instance = new Trustpilot();
    }
    return Trustpilot.instance;
  }

  public async getReviews(cache: boolean = true): Promise<ApiResult> {
    try {
      const cacheKey = 'trustpilot_reviews';
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult && cache) {
        return JSON.parse(cacheResult);
      }

      const options = {
        method: 'GET',
        url: 'https://trustpilot-company-and-reviews-data.p.rapidapi.com/company-reviews',
        params: {
          company_domain: process.env.TRUSTPILOT_DOMAIN || 'qrsong.io',
          date_posted: 'any',
          locale: 'en-US'
        },
        headers: {
          'x-rapidapi-key': process.env.RAPID_API_KEY,
          'x-rapidapi-host': 'trustpilot-company-and-reviews-data.p.rapidapi.com'
        }
      };

      const response = await axios.request(options);
      
      const reviews: TrustpilotReview[] = response.data.reviews.map((review: any) => ({
        id: review.id,
        stars: review.stars,
        title: review.title,
        text: review.text,
        author: review.author.name,
        date: review.date_posted,
        link: review.link
      }));

      const result = {
        success: true,
        data: {
          totalReviews: reviews.length,
          averageRating: response.data.average_rating,
          reviews: reviews
        }
      };

      // Cache for 1 hour
      await this.cache.set(cacheKey, JSON.stringify(result), 3600);
      this.analytics.increaseCounter('trustpilot_reviews_fetched');

      return result;
    } catch (error) {
      this.logger.log('Error fetching Trustpilot reviews', error);
      return {
        success: false,
        error: 'Error fetching Trustpilot reviews'
      };
    }
  }
}

export default Trustpilot;
