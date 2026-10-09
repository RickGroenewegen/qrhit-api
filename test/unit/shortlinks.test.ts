import { describe, it, expect } from 'vitest';
import {
  isUrlOnHosts,
  SHORTLINK_HOSTS,
  SPOTIFY_REDIRECT_HOSTS,
} from '../../src/shortlinks';

describe('isUrlOnHosts', () => {
  it('accepts the services own shortlink hosts', () => {
    expect(isUrlOnHosts('https://spotify.link/abc', SHORTLINK_HOSTS.spotify)).toBe(true);
    expect(isUrlOnHosts('https://spotify.app.link/abc?x=1', SHORTLINK_HOSTS.spotify)).toBe(true);
    expect(isUrlOnHosts('https://apple.co/xyz', SHORTLINK_HOSTS.appleMusic)).toBe(true);
    expect(
      isUrlOnHosts('https://music.apple.com/nl/playlist/top/pl.1?ls', SHORTLINK_HOSTS.appleMusic)
    ).toBe(true);
    expect(isUrlOnHosts('https://link.deezer.com/s/abc', SHORTLINK_HOSTS.deezer)).toBe(true);
    expect(isUrlOnHosts('https://deezer.page.link/x', SHORTLINK_HOSTS.deezer)).toBe(true);
  });

  it('accepts open.spotify.com as a redirect target', () => {
    expect(
      isUrlOnHosts('https://open.spotify.com/playlist/PL99', SPOTIFY_REDIRECT_HOSTS)
    ).toBe(true);
  });

  it('refuses internal and foreign addresses', () => {
    const hosts = SHORTLINK_HOSTS.spotify;
    expect(isUrlOnHosts('http://169.254.169.254/latest/meta-data/', hosts)).toBe(false);
    expect(isUrlOnHosts('http://localhost:3004/admin', hosts)).toBe(false);
    expect(isUrlOnHosts('http://10.0.0.5/', hosts)).toBe(false);
    expect(isUrlOnHosts('https://evil.example/spotify.link/', hosts)).toBe(false);
  });

  it('refuses look-alike hosts, ports, credentials and other schemes', () => {
    const hosts = SHORTLINK_HOSTS.appleMusic;
    expect(isUrlOnHosts('https://apple.co.evil.example/x', hosts)).toBe(false);
    expect(isUrlOnHosts('https://notapple.co/x', hosts)).toBe(false);
    expect(isUrlOnHosts('https://apple.co@169.254.169.254/x', hosts)).toBe(false);
    expect(isUrlOnHosts('https://user:pw@apple.co/x', hosts)).toBe(false);
    expect(isUrlOnHosts('https://apple.co:8443/x', hosts)).toBe(false);
    expect(isUrlOnHosts('file:///etc/passwd', hosts)).toBe(false);
    expect(isUrlOnHosts('not a url', hosts)).toBe(false);
  });
});
