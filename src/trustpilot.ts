import { ApiResult } from './interfaces/ApiResult';
import { TrustpilotReview } from './interfaces/TrustpilotReview';
import { TrustpilotCompany } from './interfaces/TrustpilotCompany';
import Cache from './cache';
import Utils from './utils';
import AnalyticsClient from './analytics';
import Logger from './logger';
import PrismaInstance from './prisma';
import axios from 'axios';

class Trustpilot {
  private cache = Cache.getInstance();
  private utils = new Utils();
  private logger = new Logger();
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
      const today = new Date().toISOString().split('T')[0];
      const cacheKey = `trustpilot_reviews_${today}`;
      const cacheResult = await this.cache.get(cacheKey);

      if (cacheResult && cache) {
        return JSON.parse(cacheResult);
      }

      const options = {
        method: 'GET',
        url: 'https://trustpilot-company-and-reviews-data.p.rapidapi.com/company-reviews',
        params: {
          company_domain: 'qrsong.io',
          date_posted: 'any',
          rating: '5',
          locale: 'en-US',
        },
        headers: {
          'x-rapidapi-key': process.env.RAPID_API_KEY,
          'x-rapidapi-host':
            'trustpilot-company-and-reviews-data.p.rapidapi.com',
        },
      };

      const response = await axios.request(options);

      const reviews: TrustpilotReview[] = response.data.data.reviews.map(
        (review: any) => ({
          id: review.review_id,
          stars: review.review_rating,
          title: review.review_title,
          text: review.review_text,
          author: review.consumer_name,
          date: review.review_time,
          authorImage: review.consumer_image,
          authorCountry: review.consumer_country,
          authorReviewCount: review.consumer_review_count,
          isVerified: review.consumer_is_verified,
        })
      );

      const result = {
        success: true,
        reviews,
      };

      // Cache for 1 hour
      await this.cache.set(cacheKey, JSON.stringify(result), 3600);

      return result;
    } catch (error: any) {
      this.logger.log('Error fetching Trustpilot reviews');
      console.log(error);
      return {
        success: false,
        error: 'Error fetching Trustpilot reviews',
      };
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
      this.logger.log('Error fetching Trustpilot company details');
      console.log(error);
      return {
        success: false,
        error: 'Error fetching Trustpilot company details',
      };
    }
  }
}

export default Trustpilot;
