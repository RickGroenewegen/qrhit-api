export interface ApiResult {
  success: boolean;
  error?: string;
  data?: any;
  needsReAuth?: boolean; // Add optional property for re-authentication flag
}
