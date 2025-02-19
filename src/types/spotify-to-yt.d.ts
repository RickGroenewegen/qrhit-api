declare module 'spotify-to-yt' {
  interface SpotifyToYT {
    setCredentials(clientId: string, clientSecret: string): void;
    trackGet(url: string): Promise<{
      url: string;
      title: string;
      info?: any;
    }>;
    playListGet(url: string): Promise<{
      songs: string[];
      info?: any;
    }>;
    isTrackOrPlaylist(url: string): Promise<'track' | 'playlist'>;
    validateURL(url: string): Promise<boolean>;
    trackSearch(term: string): Promise<{
      url: string;
      title: string;
      info?: any;
    }>;
  }

  const spotifyToYT: SpotifyToYT;
  export default spotifyToYT;
}
