export interface Playlist {
  id: string;
  playlistId: string;
  name: string;
  description: string;
  numberOfTracks: number;
  image: string;
  customImage?: string | null;
  design?: any;
  featured?: boolean;
  decadePercentage0?: number;
  decadePercentage1900?: number;
  decadePercentage1950?: number;
  decadePercentage1960?: number;
  decadePercentage1970?: number;
  decadePercentage1980?: number;
  decadePercentage1990?: number;
  decadePercentage2000?: number;
  decadePercentage2010?: number;
  decadePercentage2020?: number;
}
