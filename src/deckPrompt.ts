import { color } from 'console-log-colors';
import Logger from './logger';
import { OWN_CARD_PATH } from './config/constants';

/**
 * Decides whether a scanned code should trigger the "get your own QRSong deck"
 * prompt in the app.
 *
 * The app never makes this call itself. It only knows that a scan was not one
 * of its own cards (no `/qr/` or `/qr2/` match) and asks here; every rule about
 * which foreign cards are worth prompting on lives in this file, so the
 * behaviour can be changed without shipping a new app build.
 *
 * Matching is deliberately conservative: a scan we do not recognise stays
 * silent rather than nagging someone mid-game.
 */

export type DeckPromptReason = 'spotify-direct' | 'known-service';

export interface DeckPromptResult {
  prompt: boolean;
  reason?: DeckPromptReason;
  // Which service the card came from, when we can tell. Purely informational;
  // the app does not name the competitor in its copy.
  service?: string;
}

// Hosts whose cards should trigger the prompt. Extend via
// `DECK_PROMPT_HOSTS` (comma-separated) to add a service without a deploy.
const DEFAULT_PROMPT_HOSTS = ['hitify.app'];

// Our own cards for playlists whose tracks are not in the database wrap the
// streaming link in OWN_CARD_PATH (/qr_url2?link=...), so they arrive here as a
// link to our own API rather than as a bare service link. Recognised
// explicitly, because otherwise a wrapped Spotify link would be
// indistinguishable from a print-at-home deck and we would offer a deck to
// someone already holding one.

class DeckPrompt {
  private static instance: DeckPrompt;
  private logger = new Logger();

  private readonly promptHosts: string[];
  private readonly spotifyDirectEnabled: boolean;

  private constructor() {
    const fromEnv = (process.env['DECK_PROMPT_HOSTS'] || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    this.promptHosts = [...DEFAULT_PROMPT_HOSTS, ...fromEnv];

    // Direct Spotify links are the format used by print-at-home PDF decks, so
    // they are on by default. Set DECK_PROMPT_SPOTIFY_DIRECT=false to stop
    // prompting on them without touching the host list.
    this.spotifyDirectEnabled =
      (process.env['DECK_PROMPT_SPOTIFY_DIRECT'] || 'true').toLowerCase() !==
      'false';
  }

  public static getInstance(): DeckPrompt {
    if (!DeckPrompt.instance) {
      DeckPrompt.instance = new DeckPrompt();
    }
    return DeckPrompt.instance;
  }

  /**
   * @param scanned The raw contents of the scanned QR code.
   */
  public evaluate(scanned: string): DeckPromptResult {
    if (!scanned || typeof scanned !== 'string') {
      return { prompt: false };
    }

    const value = scanned.trim();

    // Our own preview cards, whatever service they point at.
    if (this.isOwnCard(value)) {
      return { prompt: false };
    }

    // `spotify:track:...` URIs never parse as a URL, so check them first.
    if (this.spotifyDirectEnabled && /^spotify:track:[a-zA-Z0-9]+/i.test(value)) {
      return { prompt: true, reason: 'spotify-direct', service: 'spotify' };
    }

    const hostname = this.hostnameOf(value);
    if (!hostname) {
      return { prompt: false };
    }

    // Direct Spotify track links. Note the path check: a playlist or album link
    // is not a card, so it must not trigger the prompt. Anything trailing the
    // track id (the `|title|artist|year|design` payload some print-at-home
    // decks append) is ignored by the pattern.
    if (
      this.spotifyDirectEnabled &&
      hostname === 'open.spotify.com' &&
      /^(?:\/intl-[a-z]{2})?\/track\/[a-zA-Z0-9]+/i.test(this.pathnameOf(value))
    ) {
      return { prompt: true, reason: 'spotify-direct', service: 'spotify' };
    }

    const matchedHost = this.promptHosts.find(
      (host) => hostname === host || hostname.endsWith('.' + host)
    );
    if (matchedHost) {
      return { prompt: true, reason: 'known-service', service: matchedHost };
    }

    return { prompt: false };
  }

  /**
   * Logs a prompt so the rules can be tuned against real scans. Only the
   * positives are logged: the app asks on every scan that was not one of our
   * own cards, so logging the misses would drown the output.
   */
  public log(scanned: string, result: DeckPromptResult): void {
    if (!result.prompt) return;

    this.logger.log(
      color.blue.bold(
        'Deck prompt shown: ' +
          color.white.bold(`url="${scanned}"`) +
          color.blue.bold(', reason=') +
          color.white.bold(result.reason || 'unknown') +
          color.blue.bold(', service=') +
          color.white.bold(result.service || 'unknown')
      )
    );
  }

  /**
   * True when the scan is one of our own wrapped cards. Matched on the path
   * rather than as a substring, so a competitor cannot suppress the prompt by
   * putting "/qr_url2" in a track title.
   */
  private isOwnCard(value: string): boolean {
    return this.pathnameOf(value) === OWN_CARD_PATH;
  }

  private hostnameOf(value: string): string | null {
    try {
      const normalized = /^https?:\/\//i.test(value) ? value : 'https://' + value;
      return new URL(normalized).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private pathnameOf(value: string): string {
    try {
      const normalized = /^https?:\/\//i.test(value) ? value : 'https://' + value;
      return new URL(normalized).pathname;
    } catch {
      return '';
    }
  }
}

export default DeckPrompt;
