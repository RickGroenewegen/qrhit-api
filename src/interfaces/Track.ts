export interface Track {
  id: string;
  name: string;
  artist: string;
  releaseDate: string;
  isrc: string;
  image: string;
  album: string;
  preview: string;
  spotifyLink: string;
  trueYear?: number;
}
