import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// DeckPrompt only logs; keep the real logger out of the test output.
vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import DeckPrompt from '../../src/deckPrompt';

const ENV_KEYS = ['DECK_PROMPT_HOSTS', 'DECK_PROMPT_SPOTIFY_DIRECT'];

/** Reset the singleton so each test exercises a fresh constructor/env. */
function freshPrompt(): DeckPrompt {
  (DeckPrompt as any).instance = undefined;
  return DeckPrompt.getInstance();
}

describe('DeckPrompt', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    (DeckPrompt as any).instance = undefined;
  });

  describe('direct Spotify track links', () => {
    it('prompts on a plain track URL', () => {
      const result = freshPrompt().evaluate(
        'https://open.spotify.com/track/4c1LnEyVW8evh46XomFZ7u'
      );
      expect(result.prompt).toBe(true);
      expect(result.reason).toBe('spotify-direct');
    });

    it('prompts on a track URL carrying a print-at-home metadata payload', () => {
      // Format used by PDF decks: trackId|title|artist|year|design
      const result = freshPrompt().evaluate(
        'https://open.spotify.com/track/4c1LnEyVW8evh46XomFZ7u|NCIS|Numeriklab|2003|bw-ink-saver'
      );
      expect(result.prompt).toBe(true);
      expect(result.reason).toBe('spotify-direct');
    });

    it('prompts on an internationalised track URL', () => {
      const result = freshPrompt().evaluate(
        'https://open.spotify.com/intl-nl/track/4c1LnEyVW8evh46XomFZ7u'
      );
      expect(result.prompt).toBe(true);
    });

    it('prompts on a spotify:track: URI', () => {
      const result = freshPrompt().evaluate(
        'spotify:track:4c1LnEyVW8evh46XomFZ7u'
      );
      expect(result.prompt).toBe(true);
      expect(result.reason).toBe('spotify-direct');
    });

    it('stays silent on playlist and album links', () => {
      const guard = freshPrompt();
      expect(
        guard.evaluate(
          'https://open.spotify.com/playlist/5hAC4oIL7LG6TVgaUBVpKs'
        ).prompt
      ).toBe(false);
      expect(
        guard.evaluate('https://open.spotify.com/album/5hAC4oIL7LG6TVgaUBVpKs')
          .prompt
      ).toBe(false);
    });

    it('can be turned off without touching the host list', () => {
      process.env['DECK_PROMPT_SPOTIFY_DIRECT'] = 'false';
      const guard = freshPrompt();
      expect(
        guard.evaluate('https://open.spotify.com/track/4c1LnEyVW8evh46XomFZ7u')
          .prompt
      ).toBe(false);
      // Host-based rules keep working.
      expect(guard.evaluate('https://hitify.app/p/abc123').prompt).toBe(true);
    });
  });

  describe('known card services', () => {
    it('prompts on hitify.app links', () => {
      const result = freshPrompt().evaluate('https://hitify.app/p/abc123');
      expect(result.prompt).toBe(true);
      expect(result.reason).toBe('known-service');
      expect(result.service).toBe('hitify.app');
    });

    it('matches subdomains of a configured host', () => {
      expect(freshPrompt().evaluate('https://www.hitify.app/p/abc').prompt).toBe(
        true
      );
    });

    it('accepts extra hosts from DECK_PROMPT_HOSTS', () => {
      process.env['DECK_PROMPT_HOSTS'] = 'example-cards.com, other.test';
      const guard = freshPrompt();
      expect(guard.evaluate('https://example-cards.com/c/1').prompt).toBe(true);
      expect(guard.evaluate('https://other.test/c/1').prompt).toBe(true);
    });
  });

  describe('everything else stays silent', () => {
    it.each([
      ['a QRSong card', 'https://www.qrsong.io/qr2/1234/5678'],
      ['a Hitster card', 'https://hitstergame.com/nl/aaaa0027/00153'],
      ['an unrelated URL', 'https://example.com/whatever'],
      ['a bare Spotify id', '4c1LnEyVW8evh46XomFZ7u'],
      ['empty input', ''],
    ])('does not prompt on %s', (_label, url) => {
      expect(freshPrompt().evaluate(url).prompt).toBe(false);
    });

    it('does not throw on non-string input', () => {
      expect(freshPrompt().evaluate(null as any).prompt).toBe(false);
      expect(freshPrompt().evaluate(undefined as any).prompt).toBe(false);
    });
  });
});
