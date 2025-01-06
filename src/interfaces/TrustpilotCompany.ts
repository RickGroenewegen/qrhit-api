export interface TrustpilotCategory {
  id: string;
  name: string;
}

export interface TrustpilotCompany {
  name: string;
  domain: string;
  website: string;
  logo: string;
  trust_score: number;
  review_count: number;
  rating: number;
  categories: TrustpilotCategory[];
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  country?: string;
  about_company?: string;
  average_days_to_reply: number;
  negative_review_count: number;
  negative_review_count_with_reply: number;
  reply_to_negative_review_percent: number;
}

export interface RatingDistribution {
  [key: string]: number;
}

export interface LanguageDistribution {
  [key: string]: number;
}
