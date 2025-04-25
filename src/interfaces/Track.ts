export interface Track {
  id: string;
  name: string;
  artist: string;
  releaseDate: string;
  isrc: string;
  image: string;
  album: string;
  preview: string;
  link: string; // Add the missing link property
  spotifyLink: string; // Keep existing spotifyLink if it's used elsewhere, otherwise consider removing/renaming
  trueYear?: number;
  extraNameAttribute?: string; // Add missing optional properties
  extraArtistAttribute?: string; // Add missing optional properties
}
