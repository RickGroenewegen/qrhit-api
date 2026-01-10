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
}
