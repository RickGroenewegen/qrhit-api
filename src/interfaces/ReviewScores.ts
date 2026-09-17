export interface AppStoreScore {
  rating: number;
  rating_count: number;
  url: string;
}

export interface ReviewScores {
  /** Trustpilot. Field names predate this file; older frontends read them. */
  company: {
    trust_score: number;
    review_count: number;
    rating: number;
  };
  apps: {
    ios: AppStoreScore | null;
    android: AppStoreScore | null;
  };
}
