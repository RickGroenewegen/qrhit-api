import crypto from 'crypto';
import { color } from 'console-log-colors';
import Settings from './settings';
import Logger from './logger';

// Authorization URL (user-facing login page)
const TIDAL_LOGIN_URL = 'https://login.tidal.com';
// Token exchange URL (backend)
const TIDAL_AUTH_BASE_URL = 'https://auth.tidal.com/v1/oauth2';
const TIDAL_API_BASE_URL = 'https://openapi.tidal.com/v2';

/**
 * Tidal API wrapper with OAuth 2.0 + PKCE support
 * Handles authentication, token management, and API calls
 */
class TidalApi {
  private static instance: TidalApi;
  private settings = Settings.getInstance();
  private logger = new Logger();

  // PKCE state stored temporarily during auth flow
  private codeVerifier: string | null = null;

  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.TIDAL_CLIENT_ID || '';
    this.clientSecret = process.env.TIDAL_CLIENT_SECRET || '';
    this.redirectUri = process.env.TIDAL_REDIRECT_URI || '';

    if (!this.clientId) {
      this.logger.log('WARNING: TIDAL_CLIENT_ID not set in environment');
    }
  }

  public static getInstance(): TidalApi {
    if (!TidalApi.instance) {
      TidalApi.instance = new TidalApi();
    }
    return TidalApi.instance;
  }

  /**
   * Generate PKCE code verifier (random 43-128 character string)
   */
  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Generate PKCE code challenge from verifier (SHA256 hash, base64url encoded)
   */
  private generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }

  /**
   * Get the OAuth authorization URL with PKCE
   * User should be redirected to this URL to authorize
   */
  getAuthorizationUrl(): string {
    // Generate and store PKCE verifier
    this.codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(this.codeVerifier);

    // Store verifier in settings for later use (in case of server restart)
    this.settings.setSetting('tidal_code_verifier', this.codeVerifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'playlists.read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `${TIDAL_LOGIN_URL}/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    code: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Retrieve code verifier
      let verifier = this.codeVerifier;
      if (!verifier) {
        verifier = await this.settings.getSetting('tidal_code_verifier');
      }

      if (!verifier) {
        return { success: false, error: 'PKCE code verifier not found' };
      }

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: verifier,
      });

      // Add client secret if available (for confidential clients)
      if (this.clientSecret) {
        params.append('client_secret', this.clientSecret);
      }

      const response = await fetch(`${TIDAL_AUTH_BASE_URL}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        this.logger.log(
          `ERROR: Tidal token exchange failed: ${response.status} - ${JSON.stringify(errorData)}`
        );
        return {
          success: false,
          error: errorData.error_description || 'Token exchange failed',
        };
      }

      const tokenData = await response.json();

      // Store tokens
      await this.settings.setSetting('tidal_access_token', tokenData.access_token);
      if (tokenData.refresh_token) {
        await this.settings.setSetting('tidal_refresh_token', tokenData.refresh_token);
      }
      const expiresAt = Date.now() + tokenData.expires_in * 1000;
      await this.settings.setSetting('tidal_token_expires_at', expiresAt.toString());

      // Clear code verifier
      this.codeVerifier = null;
      await this.settings.setSetting('tidal_code_verifier', '');

      return { success: true };
    } catch (error: any) {
      this.logger.log(`ERROR: Tidal token exchange error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Refresh the access token using refresh token
   */
  async refreshAccessToken(): Promise<string | null> {
    try {
      const refreshToken = await this.settings.getSetting('tidal_refresh_token');
      if (!refreshToken) {
        this.logger.log(
          color.yellow.bold(`[${color.white.bold('tidal')}] No refresh token available`)
        );
        return null;
      }

      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
      });

      if (this.clientSecret) {
        params.append('client_secret', this.clientSecret);
      }

      const response = await fetch(`${TIDAL_AUTH_BASE_URL}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        this.logger.log(
          color.yellow.bold(
            `[${color.white.bold('tidal')}] Token refresh failed: ${response.status} - ${JSON.stringify(errorData)}`
          )
        );
        // Clear tokens if refresh fails
        await this.clearTokens();
        return null;
      }

      const tokenData = await response.json();

      // Store new tokens
      await this.settings.setSetting('tidal_access_token', tokenData.access_token);
      if (tokenData.refresh_token) {
        await this.settings.setSetting('tidal_refresh_token', tokenData.refresh_token);
      }
      const expiresAt = Date.now() + tokenData.expires_in * 1000;
      await this.settings.setSetting('tidal_token_expires_at', expiresAt.toString());

      this.logger.log(
        color.green.bold(`[${color.white.bold('tidal')}] Successfully refreshed token.`)
      );
      return tokenData.access_token;
    } catch (error: any) {
      this.logger.log(
        color.red.bold(`[${color.white.bold('tidal')}] Token refresh error: ${error.message}`)
      );
      return null;
    }
  }

  /**
   * Get a valid access token (refreshing if necessary)
   */
  async getAccessToken(): Promise<string | null> {
    const accessToken = await this.settings.getSetting('tidal_access_token');
    const expiresAtStr = await this.settings.getSetting('tidal_token_expires_at');
    const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : 0;

    // Check if token is valid (with 60 second buffer)
    if (accessToken && Date.now() < expiresAt - 60000) {
      return accessToken;
    }

    // Try to refresh
    return await this.refreshAccessToken();
  }

  /**
   * Check if we have valid Tidal credentials
   */
  async isConnected(): Promise<boolean> {
    const token = await this.getAccessToken();
    return !!token;
  }

  /**
   * Clear all stored tokens
   */
  async clearTokens(): Promise<void> {
    await this.settings.setSetting('tidal_access_token', '');
    await this.settings.setSetting('tidal_refresh_token', '');
    await this.settings.setSetting('tidal_token_expires_at', '');
    await this.settings.setSetting('tidal_code_verifier', '');
  }

  /**
   * Make an authenticated API request to Tidal
   */
  async apiRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<{ success: boolean; data?: T; error?: string; needsReAuth?: boolean }> {
    const accessToken = await this.getAccessToken();

    if (!accessToken) {
      this.logger.log('ERROR: Tidal API request - No access token available');
      return { success: false, error: 'Not authenticated with Tidal', needsReAuth: true };
    }

    try {
      const url = endpoint.startsWith('http') ? endpoint : `${TIDAL_API_BASE_URL}${endpoint}`;

      const response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/vnd.api+json',
          Accept: 'application/vnd.api+json',
          ...options.headers,
        },
      });

      if (response.status === 401) {
        // Token might be invalid, try to refresh and retry once
        const newToken = await this.refreshAccessToken();
        if (newToken) {
          const retryResponse = await fetch(url, {
            ...options,
            headers: {
              Authorization: `Bearer ${newToken}`,
              'Content-Type': 'application/vnd.api+json',
              Accept: 'application/vnd.api+json',
              ...options.headers,
            },
          });

          if (retryResponse.ok) {
            const data = await retryResponse.json();
            return { success: true, data };
          }
        }
        return { success: false, error: 'Authentication failed', needsReAuth: true };
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        this.logger.log(
          `ERROR: Tidal API request failed: ${response.status} - ${JSON.stringify(errorData)}`
        );
        return {
          success: false,
          error: errorData.errors?.[0]?.detail || `API request failed: ${response.status}`,
        };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error: any) {
      this.logger.log(`ERROR: Tidal API request error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get playlist metadata
   */
  async getPlaylist(playlistId: string, countryCode: string = 'US'): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    needsReAuth?: boolean;
  }> {
    return this.apiRequest(`/playlists/${playlistId}?countryCode=${countryCode}&include=items`);
  }

  /**
   * Get playlist items (tracks)
   */
  async getPlaylistItems(
    playlistId: string,
    limit: number = 100,
    offset: number = 0,
    countryCode: string = 'US'
  ): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    needsReAuth?: boolean;
  }> {
    return this.apiRequest(
      `/playlists/${playlistId}/relationships/items?countryCode=${countryCode}&page[limit]=${limit}&page[offset]=${offset}`
    );
  }

  /**
   * Get track details by ID
   */
  async getTrack(trackId: string, countryCode: string = 'US'): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    needsReAuth?: boolean;
  }> {
    return this.apiRequest(`/tracks/${trackId}?countryCode=${countryCode}&include=albums,artists`);
  }

  /**
   * Get multiple tracks by IDs
   */
  async getTracks(trackIds: string[], countryCode: string = 'US'): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    needsReAuth?: boolean;
  }> {
    // Tidal API supports filtering by multiple IDs
    const idsFilter = trackIds.join(',');
    return this.apiRequest(`/tracks?countryCode=${countryCode}&filter[id]=${idsFilter}&include=albums,artists`);
  }
}

export default TidalApi;
