import crypto from 'crypto';
import Cache from './cache';

/**
 * One-time `state` values for the logins that connect the API's own Spotify
 * and Tidal accounts. Whatever account completes such a login becomes the
 * account the whole API works with, so the callbacks only accept a state
 * issued here, by an admin route or by the re-authorisation alert. Before
 * this, anyone could open the authorise URL, log in with their own account
 * and replace ours.
 *
 * A state can carry a value for its callback (Tidal's PKCE verifier).
 */
export type OAuthProvider = 'spotify' | 'tidal';

/** Long enough for a re-authorisation alert to be tapped the next day. */
const STATE_TTL_SECONDS = 3 * 24 * 3600;

const STATE_RE = /^[A-Za-z0-9_-]{32}$/;

function stateKey(provider: OAuthProvider, state: string): string {
  return `oauth_state:${provider}:${state}`;
}

export async function issueOAuthState(
  provider: OAuthProvider,
  value = '1'
): Promise<string> {
  const state = crypto.randomBytes(24).toString('base64url');
  await Cache.getInstance().set(stateKey(provider, state), value, STATE_TTL_SECONDS);
  return state;
}

/** The value issued with `state`, once; null for an unknown, used or expired state. */
export async function consumeOAuthState(
  provider: OAuthProvider,
  state: unknown
): Promise<string | null> {
  if (typeof state !== 'string' || !STATE_RE.test(state)) return null;
  const cache = Cache.getInstance();
  const key = stateKey(provider, state);
  const value = await cache.get(key);
  if (value === null) return null;
  await cache.del(key);
  return value;
}
