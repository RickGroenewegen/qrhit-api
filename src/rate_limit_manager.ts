import { ApiResult } from './interfaces/ApiResult';
import Logger from './logger';
import { color } from 'console-log-colors';
import Cache from './cache';

interface ApiProvider {
  getPlaylist(playlistId: string): Promise<ApiResult>;
  getTracks(playlistId: string): Promise<ApiResult>;
  getTracksByIds(trackIds: string[]): Promise<ApiResult>;
  searchTracks(
    searchTerm: string,
    limit: number,
    offset: number
  ): Promise<ApiResult>;
}

interface RateLimitInfo {
  provider: 'spotifyApi' | 'spotifyScraper';
  retryAfter: number; // timestamp when provider can be used again
}

class RateLimitManager {
  private static instance: RateLimitManager;
  private cache = Cache.getInstance();
  private logger = new Logger();

  // Cache keys for rate limit tracking
  private readonly RATE_LIMIT_KEY = 'rate_limit_info';
  private readonly FALLBACK_DURATION = 5 * 60 * 1000; // 5 minutes base fallback

  constructor() {}

  public static getInstance(): RateLimitManager {
    if (!RateLimitManager.instance) {
      RateLimitManager.instance = new RateLimitManager();
    }
    return RateLimitManager.instance;
  }

  /**
   * Checks if a provider is currently rate limited
   */
  private async isProviderRateLimited(
    provider: 'spotifyApi' | 'spotifyScraper'
  ): Promise<boolean> {
    const rateLimitData = await this.cache.get(
      `${this.RATE_LIMIT_KEY}_${provider}`
    );
    if (!rateLimitData) {
      return false;
    }

    try {
      const info: RateLimitInfo = JSON.parse(rateLimitData);
      const now = Date.now();

      if (now < info.retryAfter) {
        const remainingSeconds = Math.ceil((info.retryAfter - now) / 1000);
        this.logger.log(
          color.yellow(
            `${provider} is rate limited for ${color.white.bold(
              remainingSeconds
            )} more seconds`
          )
        );
        return true;
      } else {
        // Rate limit has expired, clear it
        await this.clearRateLimit(provider);
        return false;
      }
    } catch (e) {
      // Invalid cache data, clear it
      await this.clearRateLimit(provider);
      return false;
    }
  }

  /**
   * Records a rate limit for a provider
   */
  private async setRateLimit(
    provider: 'spotifyApi' | 'spotifyScraper',
    retryAfterSeconds?: number
  ): Promise<void> {
    const now = Date.now();
    let retryAfterTimestamp: number;

    if (retryAfterSeconds) {
      // Use the Retry-After header value plus 5 minutes buffer
      retryAfterTimestamp =
        now + retryAfterSeconds * 1000 + this.FALLBACK_DURATION;
      this.logger.log(
        color.red.bold(
          `Setting rate limit for ${color.white.bold(
            provider
          )} for ${color.white.bold(
            retryAfterSeconds + 300
          )} seconds (Retry-After + 5 min buffer)`
        )
      );
    } else {
      // No Retry-After header, use default 5 minutes
      retryAfterTimestamp = now + this.FALLBACK_DURATION;
      this.logger.log(
        color.red.bold(
          `Setting rate limit for ${color.white.bold(
            provider
          )} for ${color.white.bold(300)} seconds (default)`
        )
      );
    }

    const rateLimitInfo: RateLimitInfo = {
      provider,
      retryAfter: retryAfterTimestamp,
    };

    // Store with TTL slightly longer than the retry period
    const ttl = Math.ceil((retryAfterTimestamp - now) / 1000) + 60; // Add 60s buffer
    await this.cache.set(
      `${this.RATE_LIMIT_KEY}_${provider}`,
      JSON.stringify(rateLimitInfo),
      ttl
    );
  }

  /**
   * Clears rate limit for a provider
   */
  private async clearRateLimit(
    provider: 'spotifyApi' | 'spotifyScraper'
  ): Promise<void> {
    await this.cache.del(`${this.RATE_LIMIT_KEY}_${provider}`);
    this.logger.log(
      color.green(`Cleared rate limit for ${color.white.bold(provider)}`)
    );
  }

  /**
   * Determines which API provider to use based on rate limits
   */
  public async getAvailableProvider(
    primaryProvider: ApiProvider,
    fallbackProvider: ApiProvider
  ): Promise<{ provider: ApiProvider; name: 'spotifyApi' | 'spotifyScraper' }> {
    const isApiRateLimited = await this.isProviderRateLimited('spotifyApi');
    const isScraperRateLimited = await this.isProviderRateLimited(
      'spotifyScraper'
    );

    // If both are rate limited, still try the one that will be available sooner
    if (isApiRateLimited && isScraperRateLimited) {
      const apiData = await this.cache.get(`${this.RATE_LIMIT_KEY}_spotifyApi`);
      const scraperData = await this.cache.get(
        `${this.RATE_LIMIT_KEY}_spotifyScraper`
      );

      let apiRetryAfter = Infinity;
      let scraperRetryAfter = Infinity;

      try {
        if (apiData) {
          const apiInfo: RateLimitInfo = JSON.parse(apiData);
          apiRetryAfter = apiInfo.retryAfter;
        }
        if (scraperData) {
          const scraperInfo: RateLimitInfo = JSON.parse(scraperData);
          scraperRetryAfter = scraperInfo.retryAfter;
        }
      } catch (e) {
        // Parse error, use primary
      }

      if (apiRetryAfter <= scraperRetryAfter) {
        this.logger.log(
          color.yellow.bold(
            'Both providers rate limited, using SpotifyApi (available sooner)'
          )
        );
        return { provider: primaryProvider, name: 'spotifyApi' };
      } else {
        this.logger.log(
          color.yellow.bold(
            'Both providers rate limited, using SpotifyScraper (available sooner)'
          )
        );
        return { provider: fallbackProvider, name: 'spotifyScraper' };
      }
    }

    // Use primary if not rate limited
    if (!isApiRateLimited) {
      return { provider: primaryProvider, name: 'spotifyApi' };
    }

    // Use fallback if primary is rate limited
    // this.logger.log(
    //   color.blue.bold(
    //     `Switching to ${color.white.bold('SpotifyScraper')} due to SpotifyApi rate limit`
    //   )
    // );
    return { provider: fallbackProvider, name: 'spotifyScraper' };
  }

  /**
   * Executes an API call with automatic fallback on rate limit
   */
  public async executeWithFallback<T extends keyof ApiProvider>(
    method: T,
    args: Parameters<ApiProvider[T]>,
    primaryProvider: ApiProvider,
    fallbackProvider: ApiProvider
  ): Promise<ApiResult> {
    // Get the appropriate provider based on rate limits
    const { provider, name } = await this.getAvailableProvider(
      primaryProvider,
      fallbackProvider
    );

    try {
      // Execute the API call
      const result = await (provider[method] as any)(...args);

      // Check if we got a 429 error
      if (!result.success && result.error?.includes('429')) {
        // Extract retry-after if available
        const retryAfterMatch = result.error.match(
          /Retry after: (\d+) seconds/
        );
        const retryAfterSeconds = retryAfterMatch
          ? parseInt(retryAfterMatch[1], 10)
          : result.retryAfter;

        // Set rate limit for this provider
        await this.setRateLimit(name, retryAfterSeconds);

        // Try fallback provider if not already using it
        if (name === 'spotifyApi') {
          const isScraperRateLimited = await this.isProviderRateLimited(
            'spotifyScraper'
          );
          if (!isScraperRateLimited) {
            this.logger.log(
              color.blue.bold(
                `Attempting fallback to ${color.white.bold(
                  'SpotifyScraper'
                )} after SpotifyApi rate limit`
              )
            );

            // Try with fallback provider
            const fallbackResult = await (fallbackProvider[method] as any)(
              ...args
            );

            // Check if fallback also got rate limited
            if (
              !fallbackResult.success &&
              fallbackResult.error?.includes('429')
            ) {
              const fallbackRetryAfter = fallbackResult.error.match(
                /Retry after: (\d+) seconds/
              );
              const fallbackRetrySeconds = fallbackRetryAfter
                ? parseInt(fallbackRetryAfter[1], 10)
                : fallbackResult.retryAfter;

              await this.setRateLimit('spotifyScraper', fallbackRetrySeconds);

              // Both providers are now rate limited
              return {
                success: false,
                error:
                  'Both Spotify API and Scraper are rate limited. Please try again later.',
                retryAfter: Math.min(
                  retryAfterSeconds || 300,
                  fallbackRetrySeconds || 300
                ),
              };
            }

            return fallbackResult;
          }
        }

        // Return the rate limit error
        return result;
      }

      // Success or non-rate-limit error
      return result;
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `Error in executeWithFallback for ${method}: ${error.message}`
        )
      );
      return {
        success: false,
        error: `Internal error: ${error.message}`,
      };
    }
  }

  /**
   * Manually clear all rate limits (useful for testing or admin functions)
   */
  public async clearAllRateLimits(): Promise<void> {
    await this.clearRateLimit('spotifyApi');
    await this.clearRateLimit('spotifyScraper');
    this.logger.log(color.green.bold('Cleared all rate limits'));
  }

  /**
   * Get current rate limit status for monitoring
   */
  public async getRateLimitStatus(): Promise<{
    spotifyApi: { limited: boolean; retryAfter?: number };
    spotifyScraper: { limited: boolean; retryAfter?: number };
  }> {
    const now = Date.now();
    const status = {
      spotifyApi: {
        limited: false,
        retryAfter: undefined as number | undefined,
      },
      spotifyScraper: {
        limited: false,
        retryAfter: undefined as number | undefined,
      },
    };

    const apiData = await this.cache.get(`${this.RATE_LIMIT_KEY}_spotifyApi`);
    if (apiData) {
      try {
        const info: RateLimitInfo = JSON.parse(apiData);
        if (now < info.retryAfter) {
          status.spotifyApi.limited = true;
          status.spotifyApi.retryAfter = Math.ceil(
            (info.retryAfter - now) / 1000
          );
        }
      } catch (e) {}
    }

    const scraperData = await this.cache.get(
      `${this.RATE_LIMIT_KEY}_spotifyScraper`
    );
    if (scraperData) {
      try {
        const info: RateLimitInfo = JSON.parse(scraperData);
        if (now < info.retryAfter) {
          status.spotifyScraper.limited = true;
          status.spotifyScraper.retryAfter = Math.ceil(
            (info.retryAfter - now) / 1000
          );
        }
      } catch (e) {}
    }

    return status;
  }
}

export default RateLimitManager;
