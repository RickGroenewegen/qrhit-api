/**
 * The hosts the shortlink resolvers may fetch. They follow a URL a visitor
 * sends, so without this list the API would fetch any address it was given,
 * the server's own network and the cloud metadata service included (SSRF).
 */
export const SHORTLINK_HOSTS = {
  spotify: ['spotify.link', 'spotify.app.link'],
  appleMusic: ['apple.co', 'music.apple.com'],
  deezer: ['link.deezer.com', 'deezer.page.link'],
};

/** Hosts a Spotify shortlink may redirect through on its way to the playlist. */
export const SPOTIFY_REDIRECT_HOSTS = ['spotify.link', 'spotify.app.link', 'spotify.com'];

/**
 * True when the URL is plain http(s) on one of the hosts (or a subdomain of
 * one), on the default port and without credentials in it.
 */
export function isUrlOnHosts(url: string, hosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }
  if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}
