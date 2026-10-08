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
 * Check if a string is a valid ServiceType
 */
export function isValidServiceType(value: string): value is ServiceType {
  return Object.values(ServiceType).includes(value as ServiceType);
}
