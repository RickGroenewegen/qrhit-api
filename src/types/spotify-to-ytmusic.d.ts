declare module 'spotify-to-ytmusic' {
  interface SpotifyToYTMusicOptions {
    clientID: string;
    clientSecret: string;
    accessToken?: string;
    ytMusicUrl?: boolean;
  }

  type SpotifyToYTMusicFn = (trackId: string | string[]) => Promise<string>;

  const spotifyToYTMusic: (options: SpotifyToYTMusicOptions) => Promise<SpotifyToYTMusicFn>;
  export default spotifyToYTMusic;
}
