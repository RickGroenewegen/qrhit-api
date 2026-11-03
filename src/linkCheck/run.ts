import { color, white } from 'console-log-colors';
import {
  GoneKind,
  LinkProbeResult,
  ProbeOptions,
  SERVICE_LABELS,
  isSpotifyOwnedPlaylist,
  playlistLink,
} from './probes';

/**
 * One run of the featured link check, everything it touches passed in so the
 * rules can be tested without a database, Redis or a music service.
 *
 * - Every featured playlist is asked once, one service at a time, with a
 *   pause between requests. A "gone" is asked again after a few seconds and
 *   only counts when the second answer agrees.
 * - A playlist is marked `linkBroken` on the second night it is found gone:
 *   the first gone answer is a strike in Redis, and a gone answer at least
 *   12 hours after the strike marks it. One answer that it is there clears
 *   the strike, and clears `linkBroken` too.
 * - A 429 is waited out once when its Retry-After is short, otherwise the
 *   service is not asked again tonight. So is a service that gives five
 *   answers in a row that could be us or a bad minute; its gone answers of
 *   this run then count for nothing.
 * - More than five playlists (or 10% of the featured ones) to mark in one
 *   night marks none: that is a broken service or a broken us, not a
 *   catalogue that died overnight. Rick gets the list instead.
 * - A refusal (a private playlist, or our access) is told apart with a
 *   control: the last playlist of the same service that answered "there" in
 *   this run. One refused before any playlist answered is asked again at the
 *   end of its service, when there is a control. Private goes through the
 *   same two nights, cap and recovery as not found.
 *
 * Nothing is written until every playlist has been asked, and a dry run
 * writes nothing at all (no flag, no strike, no notification).
 */

export interface LinkCheckPlaylist {
  id: number;
  playlistId: string;
  serviceType: string;
  slug: string;
  name: string;
  featuredLocale: string | null;
  linkBroken: boolean;
}

/** The first night a playlist was found gone. */
export interface Strike {
  firstAt: string;
  reason: string;
}

export interface StrikeStore {
  get(playlistId: number): Promise<Strike | null>;
  set(playlistId: number, strike: Strike): Promise<void>;
  clear(playlistId: number): Promise<void>;
}

export interface LinkCheckNotice {
  title: string;
  message: string;
}

export interface LinkCheckDeps {
  loadPlaylists(): Promise<LinkCheckPlaylist[]>;
  probe(playlist: LinkCheckPlaylist, options?: ProbeOptions): Promise<LinkProbeResult>;
  strikes: StrikeStore;
  markBroken(ids: number[], at: Date): Promise<void>;
  clearBroken(ids: number[]): Promise<void>;
  markChecked(ids: number[], at: Date): Promise<void>;
  /**
   * After a flag changed: drops the product page answers and playlist caches
   * of those playlists and the cached lists, rebuilds the sitemap and the feed.
   */
  afterFlagChange(changed: { playlistId: string; slug: string }[]): Promise<void>;
  notify(notice: LinkCheckNotice): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(line: string): void;
}

export interface LinkCheckOptions {
  /** Ask the services and report; change nothing. */
  dryRun: boolean;
  /** Mark everything that is due even above the cap (by hand, after a look). */
  ignoreCap?: boolean;
}

export interface LinkCheckEntry {
  id: number;
  playlistId: string;
  serviceType: string;
  slug: string;
  name: string;
  link: string;
  reason: string;
  /** For a gone playlist: when it was first found gone. */
  since?: string;
  /** For a gone playlist: not found, or private. */
  kind?: GoneKind;
}

export interface LinkCheckReport {
  dryRun: boolean;
  /** Featured playlists in the catalogue. */
  featured: number;
  /** Playlists that got a definite answer (there or gone). */
  checked: number;
  available: number;
  gone: number;
  /** No definite answer, including the ones a stopped service never got to. */
  unknown: number;
  /** Marked broken now (would be, in a dry run). */
  flagged: LinkCheckEntry[];
  /** Were broken, are there again. */
  recovered: LinkCheckEntry[];
  /** Gone for the first time: marked if the next night agrees. */
  firstStrikes: LinkCheckEntry[];
  /** Gone again within 12 hours of the first time: waits for another night. */
  waiting: LinkCheckEntry[];
  /** Already broken and still gone. */
  stillBroken: LinkCheckEntry[];
  /** Due to be marked, but more than the cap: none marked. */
  capped: LinkCheckEntry[];
  /** Answers that were neither there nor gone. */
  unknowns: LinkCheckEntry[];
  /** Services the run stopped asking. */
  stopped: { channel: string; reason: string; skipped: number }[];
}

export const LINK_CHECK_RULES = {
  /** More than this many to mark in one run marks none. */
  maxFlagsPerRun: 5,
  /** ...and so does more than this share of the featured playlists. */
  maxFlagShare: 0.1,
  /** A second gone answer counts only this long after the first (another night). */
  minStrikeGapMs: 12 * 60 * 60 * 1000,
  /** A strike nobody confirms is forgotten after this; long enough to span a night with no answer. */
  strikeTtlSeconds: 60 * 60 * 60,
  /** The pause before asking a "gone" playlist again within the run. */
  confirmDelayMs: 5000,
  /** This many answers in a row that could be us or a bad minute stop a service. */
  maxTransientInARow: 5,
  /** A Retry-After up to this long is waited out once; a longer one stops the service. */
  maxRetryAfterSeconds: 120,
  /** The wait after a 429 without Retry-After. */
  defaultBackoffSeconds: 30,
} as const;

/** Pause after each playlist, per service: sequential and well under every limit. */
export const CHANNEL_DELAY_MS: Record<string, number> = {
  spotify: 2000,
  'spotify-scraper': 3000,
  deezer: 1000,
  apple_music: 1500,
  tidal: 1500,
  youtube_music: 2000,
};
const DEFAULT_DELAY_MS = 2000;

const CHANNEL_ORDER = ['spotify', 'spotify-scraper', 'deezer', 'apple_music', 'tidal', 'youtube_music'];

const CHANNEL_LABELS: Record<string, string> = {
  ...SERVICE_LABELS,
  'spotify-scraper': 'Spotify (scraper)',
};

/** Pushover cuts a message at 1024 characters. */
const PUSHOVER_MAX = 1024;

export function channelOf(playlist: Pick<LinkCheckPlaylist, 'serviceType' | 'playlistId'>): string {
  if (playlist.serviceType === 'spotify' && isSpotifyOwnedPlaylist(playlist.playlistId)) {
    return 'spotify-scraper';
  }
  return playlist.serviceType || 'spotify';
}

function label(channel: string): string {
  return CHANNEL_LABELS[channel] || channel;
}

type Level = 'info' | 'success' | 'warn' | 'error';
const LEVEL_COLOR: Record<Level, (text: string) => string> = {
  info: color.blue.bold,
  success: color.green.bold,
  warn: color.yellow.bold,
  error: color.red.bold,
};

/** `paint('warn')\`text ${param}\``: text in the level colour, params white. */
function paint(level: Level) {
  const c = LEVEL_COLOR[level];
  return (strings: TemplateStringsArray, ...values: unknown[]): string => {
    let line = c('[') + white.bold('link-check') + c('] ');
    strings.forEach((text, i) => {
      if (text) line += c(text);
      if (i < values.length) line += white.bold(String(values[i]));
    });
    return line;
  };
}

function entry(playlist: LinkCheckPlaylist, result: LinkProbeResult, since?: string): LinkCheckEntry {
  return {
    id: playlist.id,
    playlistId: playlist.playlistId,
    serviceType: playlist.serviceType,
    slug: playlist.slug,
    name: playlist.name,
    link: playlistLink(playlist.serviceType, playlist.playlistId),
    reason: result.reason,
    ...(since ? { since } : {}),
    ...(result.verdict === 'gone' && result.goneKind ? { kind: result.goneKind } : {}),
  };
}

interface Asked {
  result: LinkProbeResult;
  /** Why the service is not asked again tonight. */
  stop?: string;
}

/** One question, with a 429 waited out once when the service asks for a short wait. */
async function ask(
  deps: LinkCheckDeps,
  playlist: LinkCheckPlaylist,
  channel: string,
  options: ProbeOptions
): Promise<Asked> {
  const result = await deps.probe(playlist, options);
  if (!result.rateLimited) return { result };

  const wait = result.retryAfterSeconds ?? LINK_CHECK_RULES.defaultBackoffSeconds;
  if (wait > LINK_CHECK_RULES.maxRetryAfterSeconds) {
    return { result, stop: `${label(channel)} asks us to wait ${wait} s (429 Retry-After)` };
  }
  deps.log(paint('warn')`${label(channel)} answers 429, waiting ${wait} s before asking again`);
  await deps.sleep(wait * 1000 + 500);
  const again = await deps.probe(playlist, options);
  if (again.rateLimited) {
    return { result: again, stop: `${label(channel)} still answers 429 after waiting ${wait} s` };
  }
  return { result: again };
}

/**
 * A gone answer is asked once more before it is believed: a 404 can be a bad
 * second at the service. Only two gone answers make a gone.
 */
async function askAndConfirm(
  deps: LinkCheckDeps,
  playlist: LinkCheckPlaylist,
  channel: string,
  options: ProbeOptions
): Promise<Asked> {
  const first = await ask(deps, playlist, channel, options);
  if (first.stop || first.result.verdict !== 'gone') return first;

  await deps.sleep(LINK_CHECK_RULES.confirmDelayMs);
  const second = await ask(deps, playlist, channel, options);
  if (second.result.verdict === 'gone' && !second.stop) return first;
  if (second.result.verdict === 'available') return second;
  return {
    result: {
      verdict: 'unknown',
      transient: second.result.transient,
      reason: `${first.result.reason}, then ${second.result.reason}`,
    },
    stop: second.stop,
  };
}

export async function runLinkCheck(deps: LinkCheckDeps, options: LinkCheckOptions): Promise<LinkCheckReport> {
  const started = deps.now().getTime();
  const would = options.dryRun ? 'would be ' : '';
  const playlists = await deps.loadPlaylists();

  const report: LinkCheckReport = {
    dryRun: options.dryRun,
    featured: playlists.length,
    checked: 0,
    available: 0,
    gone: 0,
    unknown: 0,
    flagged: [],
    recovered: [],
    firstStrikes: [],
    waiting: [],
    stillBroken: [],
    capped: [],
    unknowns: [],
    stopped: [],
  };

  deps.log(
    paint('info')`Checking ${playlists.length} featured playlists${
      options.dryRun ? ' (dry run: nothing is changed)' : ''
    }`
  );

  // One service at a time, so "in a row" means in a row for that service.
  const groups = new Map<string, LinkCheckPlaylist[]>();
  for (const playlist of [...playlists].sort((a, b) => a.id - b.id)) {
    const channel = channelOf(playlist);
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel)!.push(playlist);
  }
  const channels = [
    ...CHANNEL_ORDER.filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((c) => !CHANNEL_ORDER.includes(c)),
  ];

  const outcomes: { playlist: LinkCheckPlaylist; result: LinkProbeResult }[] = [];
  for (const channel of channels) {
    const list = groups.get(channel)!;
    const delay = CHANNEL_DELAY_MS[channel] ?? DEFAULT_DELAY_MS;
    const asked: { playlist: LinkCheckPlaylist; result: LinkProbeResult }[] = [];
    let inARow = 0;
    let stop: string | undefined;
    // The last playlist of this service that answered "there": the control
    // that tells a private playlist from our own access being refused.
    let control: string | null = null;
    // Refused before there was a control: asked again at the end.
    const deferred: number[] = [];

    const take = (index: number, answer: Asked): boolean => {
      asked[index].result = answer.result;
      if (answer.result.verdict === 'available') control = asked[index].playlist.playlistId;
      if (answer.stop) {
        stop = answer.stop;
        return false;
      }
      inARow = answer.result.transient ? inARow + 1 : 0;
      if (inARow >= LINK_CHECK_RULES.maxTransientInARow) {
        stop = `${inARow} answers in a row without a definite answer, the last: ${answer.result.reason}`;
        return false;
      }
      return true;
    };

    for (let i = 0; i < list.length; i++) {
      const playlist = list[i];
      const answer = await askAndConfirm(deps, playlist, channel, { controlPlaylistId: control });
      asked.push({ playlist, result: answer.result });
      if (answer.result.needsControl) deferred.push(asked.length - 1);
      if (!take(asked.length - 1, answer)) break;
      if (i < list.length - 1) await deps.sleep(delay);
    }

    if (!stop && deferred.length > 0 && control) {
      deps.log(
        paint('info')`Asking ${deferred.length} refused ${label(channel)} playlists again, with a control`
      );
      for (const index of deferred) {
        await deps.sleep(delay);
        const answer = await askAndConfirm(deps, asked[index].playlist, channel, { controlPlaylistId: control });
        if (!take(index, answer)) break;
      }
    }

    if (stop) {
      const skipped = list.length - asked.length;
      report.stopped.push({ channel, reason: stop, skipped });
      report.unknown += skipped;
      // The service or our side is not right tonight: its gone answers
      // count for nothing. A "there" is still a "there".
      for (const item of asked) {
        if (item.result.verdict === 'gone') {
          item.result = {
            verdict: 'unknown',
            transient: true,
            reason: `${item.result.reason} (not counted: the check of ${label(channel)} stopped)`,
          };
        }
      }
      deps.log(
        paint('warn')`Stopped asking ${label(channel)}, ${skipped} not checked: ${stop}`
      );
    }
    outcomes.push(...asked);
  }

  // Decide. Reading strikes is all a dry run does with Redis.
  const at = deps.now();
  const checkedIds: number[] = [];
  const clearStrikes: number[] = [];
  const newStrikes: { id: number; strike: Strike }[] = [];
  const due: { playlist: LinkCheckPlaylist; strike: Strike; entry: LinkCheckEntry }[] = [];

  for (const { playlist, result } of outcomes) {
    if (result.verdict === 'available') {
      report.available++;
      checkedIds.push(playlist.id);
      clearStrikes.push(playlist.id);
      if (playlist.linkBroken) report.recovered.push(entry(playlist, result));
    } else if (result.verdict === 'gone') {
      report.gone++;
      checkedIds.push(playlist.id);
      if (playlist.linkBroken) {
        report.stillBroken.push(entry(playlist, result));
        continue;
      }
      const strike = await deps.strikes.get(playlist.id);
      const strikeAt = strike ? Date.parse(strike.firstAt) : NaN;
      if (!strike || !Number.isFinite(strikeAt)) {
        report.firstStrikes.push(entry(playlist, result));
        newStrikes.push({ id: playlist.id, strike: { firstAt: at.toISOString(), reason: result.reason } });
      } else if (at.getTime() - strikeAt >= LINK_CHECK_RULES.minStrikeGapMs) {
        due.push({ playlist, strike, entry: entry(playlist, result, strike.firstAt) });
      } else {
        report.waiting.push(entry(playlist, result, strike.firstAt));
      }
    } else {
      report.unknown++;
      report.unknowns.push(entry(playlist, result));
    }
  }
  report.checked = checkedIds.length;

  const overCap =
    due.length > LINK_CHECK_RULES.maxFlagsPerRun ||
    due.length > playlists.length * LINK_CHECK_RULES.maxFlagShare;
  const capped = overCap && !options.ignoreCap;
  if (capped) {
    report.capped = due.map((d) => d.entry);
  } else {
    report.flagged = due.map((d) => d.entry);
  }

  if (!options.dryRun) {
    if (report.flagged.length > 0) {
      await deps.markBroken(report.flagged.map((e) => e.id), at);
    }
    if (report.recovered.length > 0) {
      await deps.clearBroken(report.recovered.map((e) => e.id));
    }
    if (checkedIds.length > 0) {
      await deps.markChecked(checkedIds, at);
    }
    for (const { id, strike } of newStrikes) {
      await deps.strikes.set(id, strike);
    }
    for (const d of due) {
      // Marked: the strike has done its job. Held back by the cap: keep it
      // alive, so tomorrow's run sees the same two nights.
      if (capped) await deps.strikes.set(d.playlist.id, d.strike);
      else await deps.strikes.clear(d.playlist.id);
    }
    for (const id of clearStrikes) {
      await deps.strikes.clear(id);
    }
    if (report.flagged.length > 0 || report.recovered.length > 0) {
      await deps.afterFlagChange([...report.flagged, ...report.recovered]);
    }
  }

  for (const e of report.flagged) {
    deps.log(
      paint('warn')`${e.name} (${e.slug}, ${label(e.serviceType)}) ${would}marked broken, gone since ${
        e.since?.slice(0, 10)
      }: ${e.reason} ${e.link}`
    );
  }
  for (const e of report.recovered) {
    deps.log(paint('success')`${e.name} (${e.slug}, ${label(e.serviceType)}) works again${options.dryRun ? ' (would be cleared)' : ''}: ${e.reason}`);
  }
  for (const e of report.firstStrikes) {
    deps.log(
      paint('warn')`${e.name} (${e.slug}, ${label(e.serviceType)}) gone for the first time${
        options.dryRun ? '' : ', marked broken if the next night agrees'
      }: ${e.reason} ${e.link}`
    );
  }
  for (const e of report.waiting) {
    deps.log(paint('warn')`${e.name} (${e.slug}) gone again, first seen at ${e.since}: waits for another night`);
  }
  for (const e of report.stillBroken) {
    deps.log(paint('info')`${e.name} (${e.slug}, ${label(e.serviceType)}) still gone: ${e.reason}`);
  }
  for (const e of report.unknowns) {
    deps.log(paint('warn')`${e.name} (${e.slug}, ${label(e.serviceType)}) no definite answer: ${e.reason}`);
  }
  if (capped) {
    deps.log(
      paint('error')`${due.length} playlists are gone two nights in a row, more than the cap of ${
        LINK_CHECK_RULES.maxFlagsPerRun
      } or ${LINK_CHECK_RULES.maxFlagShare * 100}%: none marked. Look at them, then: npm run link-check -- --write --force`
    );
  }

  const seconds = Math.round((deps.now().getTime() - started) / 1000);
  deps.log(
    paint(report.flagged.length > 0 || capped ? 'warn' : 'success')`Done in ${seconds} s: ${
      report.checked
    } of ${report.featured} answered (${report.available} there, ${report.gone} gone), ${
      report.unknown
    } without an answer; ${report.flagged.length} ${would}marked broken, ${
      report.recovered.length
    } working again, ${report.firstStrikes.length} first strikes${options.dryRun ? ' (dry run)' : ''}`
  );

  if (!options.dryRun) {
    const notice = buildNotification(report);
    if (notice) await deps.notify(notice);
  }

  return report;
}

function listed(entries: LinkCheckEntry[]): string {
  return entries
    .map((e) => `• ${e.name} (${e.slug}), ${label(e.serviceType)}\n  ${e.link}\n  ${e.reason}`)
    .join('\n');
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Keeps a Pushover message whole up to its limit, cut at a line otherwise. */
export function fitPushover(message: string, max: number = PUSHOVER_MAX): string {
  if (message.length <= max) return message;
  const tail = '\n… more in the API log ([link-check])';
  const room = message.slice(0, max - tail.length);
  const cut = room.lastIndexOf('\n');
  return (cut > 0 ? room.slice(0, cut) : room) + tail;
}

/**
 * One Pushover per run: what was marked broken and what works again, or that
 * the cap held everything back. Null when there is nothing to tell.
 */
export function buildNotification(report: LinkCheckReport): LinkCheckNotice | null {
  const sections: string[] = [];
  let title: string;

  if (report.capped.length > 0) {
    title = `Featured link check: ${report.capped.length} look gone, none marked`;
    sections.push(
      `${plural(report.capped.length, 'featured playlist')} answered "gone" two nights in a row. ` +
        `That is more than one night may mark (${LINK_CHECK_RULES.maxFlagsPerRun}, or ${
          LINK_CHECK_RULES.maxFlagShare * 100
        }%), which usually means our side or the service is broken, so none were marked. ` +
        `If they really are gone: npm run link-check -- --write --force`,
      listed(report.capped)
    );
  } else if (report.flagged.length > 0 || report.recovered.length > 0) {
    const parts: string[] = [];
    const privates = report.flagged.filter((e) => e.kind === 'private').length;
    if (report.flagged.length > 0) {
      parts.push(`${report.flagged.length} broken${privates > 0 ? ` (${privates} private)` : ''}`);
    }
    if (report.recovered.length > 0) parts.push(`${report.recovered.length} working again`);
    title = `Featured links: ${parts.join(', ')}`;
  } else {
    return null;
  }

  if (report.flagged.length > 0) {
    sections.push(
      'Gone two nights in a row, now left out of the product feeds and the playlist lists ' +
        '(still featured, the product page stays):\n' +
        listed(report.flagged)
    );
  }
  if (report.recovered.length > 0) {
    sections.push('Working again, back in the feeds and lists:\n' + listed(report.recovered));
  }
  if (report.stopped.length > 0) {
    sections.push(
      'Not fully checked tonight: ' +
        report.stopped.map((s) => `${label(s.channel)} (${s.reason})`).join('; ')
    );
  }

  return { title, message: fitPushover(sections.join('\n\n')) };
}
