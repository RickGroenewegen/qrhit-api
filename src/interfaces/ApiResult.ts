export interface ApiResult {
  success: boolean;
  error?: string;
  data?: any;
  needsReAuth?: boolean;
  authUrl?: string; // Add optional property for authorization URL
}
