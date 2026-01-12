import { ServiceType, isValidServiceType } from '../enums/ServiceType';
import { IMusicProvider, UrlValidationResult } from '../interfaces/IMusicProvider';
import { SpotifyProvider, YouTubeMusicProvider, TidalProvider, DeezerProvider, AppleMusicProvider } from '../providers';
import Logger from '../logger';

/**
 * Result of URL recognition
 */
export interface UrlRecognitionResult {
  recognized: boolean;
  serviceType?: ServiceType;
  provider?: IMusicProvider;
  playlistId?: string;
  validation?: UrlValidationResult;
}

/**
 * Registry for all music service providers.
 * Provides a unified interface for working with multiple music services.
 */
class MusicServiceRegistry {
  private static instance: MusicServiceRegistry;
  private providers: Map<ServiceType, IMusicProvider> = new Map();
  private logger = new Logger();

  constructor() {
    // Register all providers
    this.registerProvider(SpotifyProvider.getInstance());
    this.registerProvider(YouTubeMusicProvider.getInstance());
    this.registerProvider(TidalProvider.getInstance());
    this.registerProvider(DeezerProvider.getInstance());
    this.registerProvider(AppleMusicProvider.getInstance());
  }

  public static getInstance(): MusicServiceRegistry {
    if (!MusicServiceRegistry.instance) {
      MusicServiceRegistry.instance = new MusicServiceRegistry();
    }
    return MusicServiceRegistry.instance;
  }

  /**
   * Register a music provider
   */
  private registerProvider(provider: IMusicProvider): void {
    this.providers.set(provider.serviceType, provider);
  }

  /**
   * Get a provider by service type
   */
  getProvider(serviceType: ServiceType): IMusicProvider | undefined {
    return this.providers.get(serviceType);
  }

  /**
   * Get a provider by service type string (for API requests)
   */
  getProviderByString(serviceType: string): IMusicProvider | undefined {
    if (isValidServiceType(serviceType)) {
      return this.providers.get(serviceType as ServiceType);
    }
    return undefined;
  }

  /**
   * Get all registered providers
   */
  getAllProviders(): IMusicProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all available service types
   */
  getAvailableServiceTypes(): ServiceType[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Recognize a URL and determine which service it belongs to
   */
  recognizeUrl(url: string): UrlRecognitionResult {
    const trimmedUrl = url.trim();

    // Try each provider to see if it recognizes the URL
    for (const [serviceType, provider] of this.providers) {
      const validation = provider.validateUrl(trimmedUrl);

      if (validation.isServiceUrl) {
        return {
          recognized: true,
          serviceType,
          provider,
          playlistId: validation.resourceId,
          validation,
        };
      }
    }

    return {
      recognized: false,
    };
  }

  /**
   * Get playlist from any service by URL
   * Automatically detects the service from the URL
   */
  async getPlaylistFromUrl(url: string) {
    const recognition = this.recognizeUrl(url);

    if (!recognition.recognized || !recognition.provider) {
      return {
        success: false,
        error: 'URL not recognized as a supported music service',
      };
    }

    if (!recognition.validation?.isValid) {
      return {
        success: false,
        error: recognition.validation?.errorType === 'not_playlist'
          ? 'This URL is from a supported service but is not a playlist'
          : 'Invalid URL format',
        serviceType: recognition.serviceType,
      };
    }

    // Handle shortlinks if needed
    let playlistId = recognition.playlistId;
    if (!playlistId && recognition.provider.resolveShortlink) {
      const resolved = await recognition.provider.resolveShortlink(url);
      if (resolved.success && resolved.data) {
        // Re-validate the resolved URL
        const resolvedValidation = recognition.provider.validateUrl(resolved.data.resolvedUrl);
        playlistId = resolvedValidation.resourceId;
      }
    }

    if (!playlistId) {
      return {
        success: false,
        error: 'Could not extract playlist ID from URL',
        serviceType: recognition.serviceType,
      };
    }

    // Fetch the playlist
    const result = await recognition.provider.getPlaylist(playlistId);
    return {
      ...result,
      serviceType: recognition.serviceType,
    };
  }

  /**
   * Get tracks from any service by URL
   * Automatically detects the service from the URL
   */
  async getTracksFromUrl(url: string) {
    const recognition = this.recognizeUrl(url);

    if (!recognition.recognized || !recognition.provider) {
      return {
        success: false,
        error: 'URL not recognized as a supported music service',
      };
    }

    if (!recognition.validation?.isValid) {
      return {
        success: false,
        error: 'Invalid URL format',
        serviceType: recognition.serviceType,
      };
    }

    let playlistId = recognition.playlistId;
    if (!playlistId && recognition.provider.resolveShortlink) {
      const resolved = await recognition.provider.resolveShortlink(url);
      if (resolved.success && resolved.data) {
        const resolvedValidation = recognition.provider.validateUrl(resolved.data.resolvedUrl);
        playlistId = resolvedValidation.resourceId;
      }
    }

    if (!playlistId) {
      return {
        success: false,
        error: 'Could not extract playlist ID from URL',
        serviceType: recognition.serviceType,
      };
    }

    const result = await recognition.provider.getTracks(playlistId);
    return {
      ...result,
      serviceType: recognition.serviceType,
    };
  }

  /**
   * Get service configuration for display purposes
   */
  getServiceConfigs() {
    const configs: Record<string, any> = {};
    for (const [serviceType, provider] of this.providers) {
      configs[serviceType] = provider.config;
    }
    return configs;
  }
}

export default MusicServiceRegistry;
