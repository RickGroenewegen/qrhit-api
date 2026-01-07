import { ServiceType } from '../enums/ServiceType';
import { IMusicProvider } from '../interfaces/IMusicProvider';
import SpotifyProvider from './SpotifyProvider';
import YouTubeMusicProvider from './YouTubeMusicProvider';

/**
 * Factory for creating music provider instances based on service type.
 * Uses singleton pattern to ensure only one instance of each provider exists.
 */
class MusicProviderFactory {
  private static instance: MusicProviderFactory;

  private constructor() {}

  public static getInstance(): MusicProviderFactory {
    if (!MusicProviderFactory.instance) {
      MusicProviderFactory.instance = new MusicProviderFactory();
    }
    return MusicProviderFactory.instance;
  }

  /**
   * Get the appropriate music provider for a service type
   * @param serviceType The service type (spotify, youtube_music, etc.)
   * @returns The music provider instance, defaults to Spotify if unknown
   */
  getProvider(serviceType?: string): IMusicProvider {
    switch (serviceType) {
      case ServiceType.YOUTUBE_MUSIC:
        return YouTubeMusicProvider.getInstance();
      case ServiceType.SPOTIFY:
      default:
        return SpotifyProvider.getInstance();
    }
  }

  /**
   * Check if a service type is supported
   */
  isSupported(serviceType: string): boolean {
    return [ServiceType.SPOTIFY, ServiceType.YOUTUBE_MUSIC].includes(serviceType as ServiceType);
  }
}

export default MusicProviderFactory;
