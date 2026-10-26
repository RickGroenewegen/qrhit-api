/**
 * The video id of a plain YouTube link, or null. music.youtube.com is a music
 * service link, not a video, and is left to the native-link handling.
 * Dependency-free so it can be tested on its own.
 */
export function youtubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const id = /^[a-zA-Z0-9_-]{11}$/;
  if (host === 'youtu.be') {
    const candidate = parsed.pathname.split('/')[1] || '';
    return id.test(candidate) ? candidate : null;
  }
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) return null;
  const watch = parsed.searchParams.get('v');
  if (parsed.pathname === '/watch' && watch && id.test(watch)) return watch;
  const path = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
  return path ? path[1] : null;
}
