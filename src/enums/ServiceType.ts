/**
 * Enum representing supported music streaming services.
 * Each playlist is exclusive to one service type.
 */
export enum ServiceType {
  SPOTIFY = 'spotify',
  YOUTUBE_MUSIC = 'youtube_music',
  APPLE_MUSIC = 'apple_music',
  DEEZER = 'deezer',
  TIDAL = 'tidal',
}

/**
 * Display names for each service type
 */
export const ServiceTypeDisplayNames: Record<ServiceType, string> = {
  [ServiceType.SPOTIFY]: 'Spotify',
  [ServiceType.YOUTUBE_MUSIC]: 'YouTube Music',
  [ServiceType.APPLE_MUSIC]: 'Apple Music',
  [ServiceType.DEEZER]: 'Deezer',
  [ServiceType.TIDAL]: 'Tidal',
};

/**
 * Check if a string is a valid ServiceType
 */
export function isValidServiceType(value: string): value is ServiceType {
  return Object.values(ServiceType).includes(value as ServiceType);
}
