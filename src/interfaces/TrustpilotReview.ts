export interface TrustpilotReview {
  id: string;
  stars: number;
  title: string;
  text: string;
  author: string;
  date: string;
  reply?: string;
  authorImage?: string;
  authorCountry: string;
  authorReviewCount: number;
  isVerified: boolean;
}
