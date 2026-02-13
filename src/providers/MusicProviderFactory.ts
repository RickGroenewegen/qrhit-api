import { ServiceType } from '../enums/ServiceType';
import { IMusicProvider } from '../interfaces/IMusicProvider';
import SpotifyProvider from './SpotifyProvider';
import YouTubeMusicProvider from './YouTubeMusicProvider';
import TidalProvider from './TidalProvider';
import DeezerProvider from './DeezerProvider';
import AppleMusicProvider from './AppleMusicProvider';

/**
 * Maps short service names (used in API requests) to database column names
 */
export const serviceColumnMap: Record<string, string> = {
  spotify: 'spotifyLink',
  youtube: 'youtubeMusicLink',
  deezer: 'deezerLink',
  apple: 'appleMusicLink',
  tidal: 'tidalLink',
  amazon: 'amazonMusicLink',
};

export const serviceCheckedColumnMap: Record<string, string> = {
  spotify: 'spotifyCheckedBySearch',
  youtube: 'youtubeCheckedBySearch',
  deezer: 'deezerCheckedBySearch',
  apple: 'appleCheckedBySearch',
  tidal: 'tidalCheckedBySearch',
  amazon: 'amazonCheckedBySearch',
};

/**
 * Maps short service names (used in API requests) to ServiceType enum values
 */
export const serviceTypeMap: Record<string, string> = {
  spotify: 'spotify',
  youtube: 'youtube_music',
  deezer: 'deezer',
  apple: 'apple_music',
  tidal: 'tidal',
};

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
   * @param serviceType The service type (spotify, youtube_music, tidal, etc.)
   * @returns The music provider instance, defaults to Spotify if unknown
   */
  getProvider(serviceType?: string): IMusicProvider {
    switch (serviceType) {
      case ServiceType.YOUTUBE_MUSIC:
        return YouTubeMusicProvider.getInstance();
      case ServiceType.TIDAL:
        return TidalProvider.getInstance();
      case ServiceType.DEEZER:
        return DeezerProvider.getInstance();
      case ServiceType.APPLE_MUSIC:
        return AppleMusicProvider.getInstance();
      case ServiceType.SPOTIFY:
      default:
        return SpotifyProvider.getInstance();
    }
  }

  /**
   * Check if a service type is supported
   */
  isSupported(serviceType: string): boolean {
    return [ServiceType.SPOTIFY, ServiceType.YOUTUBE_MUSIC, ServiceType.TIDAL, ServiceType.DEEZER, ServiceType.APPLE_MUSIC].includes(serviceType as ServiceType);
  }
}

export default MusicProviderFactory;
