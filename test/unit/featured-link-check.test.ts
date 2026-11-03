import { describe, it, expect, vi } from 'vitest';
import {
  HttpRequest,
  HttpResponse,
  LinkProbeResult,
  ProbeContext,
  parseRetryAfter,
  probeLink,
} from '../../src/linkCheck/probes';
import {
  LINK_CHECK_RULES,
  LinkCheckDeps,
  LinkCheckPlaylist,
  LinkCheckReport,
  Strike,
  buildNotification,
  channelOf,
  fitPushover,
  runLinkCheck,
} from '../../src/linkCheck/run';

// ── probes ────────────────────────────────────────────────────────────────

function res(status: number, body: any = null, headers: Record<string, string> = {}): HttpResponse {
  return { status, body, headers };
}

function makeCtx(responses: HttpResponse[], over: Partial<ProbeContext> = {}) {
  const requests: HttpRequest[] = [];
  const http = vi.fn(async (request: HttpRequest) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${request.url}`);
    return next;
  });
  const ctx: ProbeContext = {
    http,
    tokens: {
      spotify: vi.fn(async () => 'sp-token'),
      apple: vi.fn(async () => 'apple-token'),
      tidal: vi.fn(async () => 'tidal-token'),
    },
    scraper: { url: 'https://scraper.example/', apiKey: 'key' },
    appleStorefronts: () => ['nl', 'us'],
    ...over,
  };
  return { ctx, requests };
}

const target = (serviceType: string, playlistId: string, featuredLocale: string | null = null) => ({
  serviceType,
  playlistId,
  featuredLocale,
});

describe('probeLink: Spotify', () => {
  it('is there on a 200 with the playlist id', async () => {
    const { ctx, requests } = makeCtx([res(200, { id: 'abc' })]);
    const result = await probeLink(target('spotify', 'abc'), ctx);
    expect(result).toMatchObject({ verdict: 'available', transient: false });
    expect(requests[0].url).toBe('https://api.spotify.com/v1/playlists/abc?fields=id');
    expect(requests[0].headers).toEqual({ Authorization: 'Bearer sp-token' });
  });

  it("is gone on a 404 in Spotify's own error format", async () => {
    const { ctx } = makeCtx([res(404, { error: { status: 404, message: 'Resource not found' } })]);
    const result = await probeLink(target('spotify', 'abc'), ctx);
    expect(result).toEqual({
      verdict: 'gone',
      transient: false,
      reason: 'Spotify answers 404 "Resource not found"',
    });
  });

  it('does not believe a 404 that is not from Spotify (a proxy page)', async () => {
    const { ctx } = makeCtx([res(404, '<html>Not Found</html>')]);
    const result = await probeLink(target('spotify', 'abc'), ctx);
    expect(result).toMatchObject({ verdict: 'unknown', transient: false });
  });

  it('reads a 429 as a rate limit with its Retry-After', async () => {
    const { ctx } = makeCtx([res(429, null, { 'retry-after': '7' })]);
    const result = await probeLink(target('spotify', 'abc'), ctx);
    expect(result).toMatchObject({ verdict: 'unknown', transient: true, rateLimited: true, retryAfterSeconds: 7 });
  });

  it.each([
    ['a 5xx', res(503)],
    ['no answer', { status: 0, headers: {}, body: null, error: 'ECONNABORTED' }],
    ['our token refused', res(401, { error: { status: 401, message: 'The access token expired' } })],
    ['a 403', res(403, { error: { status: 403, message: 'Forbidden' } })],
  ])('treats %s as transient, never as gone', async (_label, response) => {
    const { ctx } = makeCtx([response as HttpResponse]);
    const result = await probeLink(target('spotify', 'abc'), ctx);
    expect(result).toMatchObject({ verdict: 'unknown', transient: true });
  });

  it('asks nothing without a token, and counts it as ours', async () => {
    const { ctx, requests } = makeCtx([], {
      tokens: { spotify: async () => null, apple: async () => 'a', tidal: async () => 't' },
    });
    const result = await probeLink(target('spotify', 'abc'), ctx);
    expect(result).toMatchObject({ verdict: 'unknown', transient: true });
    expect(requests).toHaveLength(0);
  });

  it('asks the scraper, not the Web API, about a Spotify-owned playlist', async () => {
    const { ctx, requests } = makeCtx([
      res(404, { success: false, error: 'Playlist not found (NotFound)' }),
    ]);
    const result = await probeLink(target('spotify', '37i9dQZF1DXcBWIGoYBM5M'), ctx);
    expect(result).toMatchObject({ verdict: 'gone' });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://scraper.example/playlist',
      body: { playlistId: '37i9dQZF1DXcBWIGoYBM5M' },
      headers: { 'x-api-key': 'key', 'Content-Type': 'application/json' },
    });
  });

  it('does not read "no data" from the scraper as gone', async () => {
    const { ctx } = makeCtx([res(404, { success: false, error: 'Playlist not found (no data)' })]);
    const result = await probeLink(target('spotify', '37i9dQZF1DXcBWIGoYBM5M'), ctx);
    expect(result).toMatchObject({ verdict: 'unknown', transient: false });
  });

  it('leaves a Spotify-owned playlist alone without a scraper', async () => {
    const { ctx, requests } = makeCtx([], { scraper: null });
    const result = await probeLink(target('spotify', '37i9dQZF1DWXRqgorJj26U'), ctx);
    expect(result).toMatchObject({ verdict: 'unknown', transient: false });
    expect(requests).toHaveLength(0);
  });
});

describe('probeLink: Deezer', () => {
  it('is there on a playlist object', async () => {
    const { ctx, requests } = makeCtx([res(200, { id: 908622995, title: 'x' })]);
    expect(await probeLink(target('deezer', '908622995'), ctx)).toMatchObject({ verdict: 'available' });
    expect(requests[0].url).toBe('https://api.deezer.com/playlist/908622995?country=NL');
  });

  it('is gone on DataException "no data" (code 800), which Deezer sends with a 200', async () => {
    // Exactly what api.deezer.com answered for a made-up id on 2026-11-03.
    const { ctx } = makeCtx([res(200, { error: { type: 'DataException', message: 'no data', code: 800 } })]);
    expect(await probeLink(target('deezer', '98765432109876'), ctx)).toEqual({
      verdict: 'gone',
      transient: false,
      reason: 'Deezer answers DataException "no data" (code 800)',
    });
  });

  it('reads the quota error (code 4) as a rate limit of 5 s', async () => {
    const { ctx } = makeCtx([res(200, { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } })]);
    expect(await probeLink(target('deezer', '1'), ctx)).toMatchObject({
      verdict: 'unknown',
      transient: true,
      rateLimited: true,
      retryAfterSeconds: 5,
    });
  });

  it('does not read a permission error as gone', async () => {
    const { ctx } = makeCtx([res(200, { error: { type: 'OAuthException', message: 'x', code: 200 } })]);
    expect(await probeLink(target('deezer', '1'), ctx)).toMatchObject({ verdict: 'unknown', transient: false });
  });

  it('asks nothing for an id that is not a Deezer id', async () => {
    const { ctx, requests } = makeCtx([]);
    expect(await probeLink(target('deezer', 'pl.abc'), ctx)).toMatchObject({ verdict: 'unknown' });
    expect(requests).toHaveLength(0);
  });
});

describe('probeLink: Apple Music', () => {
  const notFound = res(404, { errors: [{ status: '404', code: '40400', title: 'Resource Not Found' }] });

  it('is gone only when every storefront answers 404', async () => {
    const { ctx, requests } = makeCtx([notFound, { ...notFound }]);
    const result = await probeLink(target('apple_music', 'pl.u-abc'), ctx);
    expect(result).toEqual({
      verdict: 'gone',
      transient: false,
      reason: 'Apple Music answers 404 in storefronts nl, us',
    });
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.music.apple.com/v1/catalog/nl/playlists/pl.u-abc',
      'https://api.music.apple.com/v1/catalog/us/playlists/pl.u-abc',
    ]);
  });

  it('is there when a later storefront has it', async () => {
    const { ctx } = makeCtx([notFound, res(200, { data: [{ id: 'pl.abc' }] })]);
    expect(await probeLink(target('apple_music', 'pl.abc'), ctx)).toMatchObject({ verdict: 'available' });
  });

  it('stops at an answer that could be a bad minute', async () => {
    const { ctx, requests } = makeCtx([notFound, res(503)]);
    expect(await probeLink(target('apple_music', 'pl.abc'), ctx)).toMatchObject({
      verdict: 'unknown',
      transient: true,
    });
    expect(requests).toHaveLength(2);
  });
});

describe('probeLink: Tidal', () => {
  it('is gone on a JSON:API 404', async () => {
    const { ctx, requests } = makeCtx([res(404, { errors: [{ code: 'NOT_FOUND', detail: 'Playlist not found' }] })]);
    expect(await probeLink(target('tidal', 'uuid-1'), ctx)).toMatchObject({
      verdict: 'gone',
      reason: 'Tidal answers 404 "Playlist not found"',
    });
    expect(requests[0].url).toBe('https://openapi.tidal.com/v2/playlists/uuid-1?countryCode=US');
  });

  it('is there on a 200 with data', async () => {
    const { ctx } = makeCtx([res(200, { data: { id: 'uuid-1', type: 'playlists' } })]);
    expect(await probeLink(target('tidal', 'uuid-1'), ctx)).toMatchObject({ verdict: 'available' });
  });
});

describe('probeLink: YouTube Music', () => {
  // The shapes www.youtube.com/youtubei/v1/browse answered on 2026-11-03.
  const trackingFor = (browseId: string) => ({
    serviceTrackingParams: [{ service: 'GFEEDBACK', params: [{ key: 'browse_id', value: browseId }] }],
  });

  it('is there when the page has contents', async () => {
    const { ctx, requests } = makeCtx([
      res(200, { responseContext: trackingFor('VLPLabc'), contents: { twoColumnBrowseResultsRenderer: {} } }),
    ]);
    expect(await probeLink(target('youtube_music', 'PLabc'), ctx)).toMatchObject({ verdict: 'available' });
    expect(requests[0].body).toMatchObject({ browseId: 'VLPLabc', context: { client: { clientName: 'WEB_REMIX' } } });
  });

  it('is gone on the empty noindex page that names our browse id', async () => {
    const { ctx } = makeCtx([
      res(200, {
        responseContext: trackingFor('VLPLzzz'),
        trackingParams: 'x',
        microformat: { microformatDataRenderer: { noindex: true } },
      }),
    ]);
    expect(await probeLink(target('youtube_music', 'PLzzz'), ctx)).toMatchObject({ verdict: 'gone' });
  });

  it('does not read an empty page for another browse id (a consent or bot page) as gone', async () => {
    const { ctx } = makeCtx([res(200, { microformat: { microformatDataRenderer: { noindex: true } } })]);
    expect(await probeLink(target('youtube_music', 'PLzzz'), ctx)).toMatchObject({
      verdict: 'unknown',
      transient: false,
    });
  });
});

describe('probeLink: other', () => {
  it('has no check for an unknown service', async () => {
    const { ctx } = makeCtx([]);
    expect(await probeLink(target('napster', 'x'), ctx)).toMatchObject({ verdict: 'unknown', transient: false });
  });

  it('counts a token lookup that throws as ours', async () => {
    const { ctx } = makeCtx([], {
      tokens: {
        spotify: async () => {
          throw new Error('settings table down');
        },
        apple: async () => 'a',
        tidal: async () => 't',
      },
    });
    expect(await probeLink(target('spotify', 'abc'), ctx)).toMatchObject({ verdict: 'unknown', transient: true });
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-03T02:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter('Tue, 03 Nov 2026 02:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
  });
});

// ── the run ───────────────────────────────────────────────────────────────

const NOW = new Date('2026-11-03T01:15:00Z');
const LAST_NIGHT: Strike = { firstAt: '2026-11-02T01:15:00.000Z', reason: 'Spotify answers 404' };
const THERE: LinkProbeResult = { verdict: 'available', transient: false, reason: 'Spotify answers 200' };
const GONE: LinkProbeResult = { verdict: 'gone', transient: false, reason: 'Spotify answers 404 "Resource not found"' };
const DOWN: LinkProbeResult = { verdict: 'unknown', transient: true, reason: 'Spotify answers 503' };

function pl(id: number, over: Partial<LinkCheckPlaylist> = {}): LinkCheckPlaylist {
  return {
    id,
    playlistId: `sp${id}`,
    serviceType: 'spotify',
    slug: `list-${id}`,
    name: `List ${id}`,
    featuredLocale: null,
    linkBroken: false,
    ...over,
  };
}

/** answers: per playlist id, one answer for every question or a queue. */
function makeRun(
  playlists: LinkCheckPlaylist[],
  answers: Record<number, LinkProbeResult | LinkProbeResult[]> = {},
  strikes: Record<number, Strike> = {}
) {
  const store = new Map<number, Strike>(Object.entries(strikes).map(([k, v]) => [Number(k), v]));
  const asked: number[] = [];
  const deps = {
    loadPlaylists: vi.fn(async () => playlists),
    probe: vi.fn(async (p: LinkCheckPlaylist) => {
      asked.push(p.id);
      const a = answers[p.id] ?? THERE;
      if (Array.isArray(a)) return a.length > 1 ? a.shift()! : a[0];
      return a;
    }),
    strikes: {
      get: vi.fn(async (id: number) => store.get(id) ?? null),
      set: vi.fn(async (id: number, s: Strike) => {
        store.set(id, s);
      }),
      clear: vi.fn(async (id: number) => {
        store.delete(id);
      }),
    },
    markBroken: vi.fn(async () => {}),
    clearBroken: vi.fn(async () => {}),
    markChecked: vi.fn(async () => {}),
    afterFlagChange: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    now: () => NOW,
    log: vi.fn(),
  } satisfies LinkCheckDeps;
  return { deps, store, asked };
}

const ids = (entries: { id: number }[]) => entries.map((e) => e.id);

describe('runLinkCheck', () => {
  it('records a first gone answer as a strike and marks nothing', async () => {
    const { deps, store, asked } = makeRun([pl(1), pl(2)], { 1: GONE });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(ids(report.firstStrikes)).toEqual([1]);
    expect(report.flagged).toEqual([]);
    expect(store.get(1)).toEqual({ firstAt: NOW.toISOString(), reason: GONE.reason });
    expect(deps.markBroken).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    // A gone answer is asked a second time before it counts.
    expect(asked).toEqual([1, 1, 2]);
    expect(deps.sleep).toHaveBeenCalledWith(LINK_CHECK_RULES.confirmDelayMs);
  });

  it('marks a playlist broken on the second night, then tells Rick', async () => {
    // Ten featured playlists: one of them is exactly the 10% one night may mark.
    const playlists = Array.from({ length: 10 }, (_, i) => pl(i + 1));
    const { deps, store } = makeRun(playlists, { 1: GONE }, { 1: LAST_NIGHT });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(ids(report.flagged)).toEqual([1]);
    expect(deps.markBroken).toHaveBeenCalledWith([1], NOW);
    expect(store.has(1)).toBe(false);
    expect(deps.afterFlagChange).toHaveBeenCalledTimes(1);
    expect(deps.markChecked).toHaveBeenCalledWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], NOW);

    expect(deps.notify).toHaveBeenCalledTimes(1);
    const notice = deps.notify.mock.calls[0][0] as { title: string; message: string };
    expect(notice.title).toBe('Featured links: 1 broken');
    expect(notice.message).toContain('List 1 (list-1), Spotify');
    expect(notice.message).toContain('https://open.spotify.com/playlist/sp1');
    expect(notice.message).toContain('Spotify answers 404 "Resource not found"');
  });

  it('waits for another night when the second gone answer comes within 12 hours', async () => {
    const earlier: Strike = { firstAt: '2026-11-02T20:00:00.000Z', reason: 'x' };
    const { deps, store } = makeRun([pl(1)], { 1: GONE }, { 1: earlier });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(ids(report.waiting)).toEqual([1]);
    expect(report.flagged).toEqual([]);
    expect(store.get(1)).toEqual(earlier);
  });

  it('believes the second look when it finds the playlist after all', async () => {
    const { deps, store } = makeRun([pl(1)], { 1: [GONE, THERE] }, { 1: LAST_NIGHT });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(report.available).toBe(1);
    expect(report.flagged).toEqual([]);
    expect(store.has(1)).toBe(false);
  });

  it('counts gone-then-no-answer as no answer', async () => {
    const { deps } = makeRun([pl(1)], { 1: [GONE, DOWN] }, { 1: LAST_NIGHT });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(report.flagged).toEqual([]);
    expect(report.unknown).toBe(1);
    expect(deps.markChecked).not.toHaveBeenCalled();
  });

  it('clears the flag on one good answer and says so', async () => {
    const { deps } = makeRun([pl(1, { linkBroken: true }), pl(2)]);
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(ids(report.recovered)).toEqual([1]);
    expect(deps.clearBroken).toHaveBeenCalledWith([1]);
    expect(deps.afterFlagChange).toHaveBeenCalledTimes(1);
    const notice = deps.notify.mock.calls[0][0] as { title: string; message: string };
    expect(notice.title).toBe('Featured links: 1 working again');
    expect(notice.message).toContain('Working again');
  });

  it('leaves a broken playlist that is still gone as it is', async () => {
    const { deps } = makeRun([pl(1, { linkBroken: true })], { 1: GONE });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(ids(report.stillBroken)).toEqual([1]);
    expect(deps.markBroken).not.toHaveBeenCalled();
    expect(deps.strikes.set).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('marks none when more than five are due in one night, keeps their strikes, and tells Rick', async () => {
    const playlists = Array.from({ length: 100 }, (_, i) => pl(i + 1));
    const answers: Record<number, LinkProbeResult> = {};
    const strikes: Record<number, Strike> = {};
    for (let id = 1; id <= 6; id++) {
      answers[id] = GONE;
      strikes[id] = LAST_NIGHT;
    }
    const { deps, store } = makeRun(playlists, answers, strikes);
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(report.flagged).toEqual([]);
    expect(ids(report.capped)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(deps.markBroken).not.toHaveBeenCalled();
    expect(deps.afterFlagChange).not.toHaveBeenCalled();
    expect(store.get(1)).toEqual(LAST_NIGHT);

    const notice = deps.notify.mock.calls[0][0] as { title: string; message: string };
    expect(notice.title).toBe('Featured link check: 6 look gone, none marked');
    expect(notice.message).toContain('npm run link-check -- --write --force');
    expect(notice.message).toContain('List 6 (list-6)');
  });

  it('marks five of a hundred (the cap is "more than")', async () => {
    const playlists = Array.from({ length: 100 }, (_, i) => pl(i + 1));
    const answers: Record<number, LinkProbeResult> = {};
    const strikes: Record<number, Strike> = {};
    for (let id = 1; id <= 5; id++) {
      answers[id] = GONE;
      strikes[id] = LAST_NIGHT;
    }
    const { deps } = makeRun(playlists, answers, strikes);
    const report = await runLinkCheck(deps, { dryRun: false });
    expect(ids(report.flagged)).toEqual([1, 2, 3, 4, 5]);
  });

  it('caps at 10% of a small catalogue', async () => {
    const playlists = Array.from({ length: 30 }, (_, i) => pl(i + 1));
    const answers: Record<number, LinkProbeResult> = { 1: GONE, 2: GONE, 3: GONE, 4: GONE };
    const strikes: Record<number, Strike> = { 1: LAST_NIGHT, 2: LAST_NIGHT, 3: LAST_NIGHT, 4: LAST_NIGHT };
    const { deps } = makeRun(playlists, answers, strikes);
    const report = await runLinkCheck(deps, { dryRun: false });
    expect(report.flagged).toEqual([]);
    expect(report.capped).toHaveLength(4);
  });

  it('holds back one of two: more than 10% (the rule is literal, it only binds below 50 playlists)', async () => {
    const { deps } = makeRun([pl(1), pl(2)], { 1: GONE }, { 1: LAST_NIGHT });
    const report = await runLinkCheck(deps, { dryRun: false });
    expect(report.flagged).toEqual([]);
    expect(ids(report.capped)).toEqual([1]);
  });

  it('marks them all anyway with ignoreCap (--force)', async () => {
    const playlists = Array.from({ length: 10 }, (_, i) => pl(i + 1));
    const { deps } = makeRun(
      playlists,
      { 1: GONE, 2: GONE },
      { 1: LAST_NIGHT, 2: LAST_NIGHT }
    );
    const report = await runLinkCheck(deps, { dryRun: false, ignoreCap: true });
    expect(ids(report.flagged)).toEqual([1, 2]);
    expect(deps.markBroken).toHaveBeenCalledWith([1, 2], NOW);
  });

  it('changes nothing in a dry run, but reports what it would do', async () => {
    const playlists = [pl(1), pl(2), pl(3, { linkBroken: true }), ...Array.from({ length: 7 }, (_, i) => pl(i + 4))];
    const { deps } = makeRun(playlists, { 1: GONE, 2: GONE }, { 1: LAST_NIGHT });
    const report = await runLinkCheck(deps, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(ids(report.flagged)).toEqual([1]);
    expect(ids(report.firstStrikes)).toEqual([2]);
    expect(ids(report.recovered)).toEqual([3]);
    for (const write of [
      deps.markBroken,
      deps.clearBroken,
      deps.markChecked,
      deps.afterFlagChange,
      deps.notify,
      deps.strikes.set,
      deps.strikes.clear,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('stops asking a service after five answers in a row that could be us, and discards its gone answers', async () => {
    const spotify = Array.from({ length: 10 }, (_, i) => pl(i + 1));
    const deezer = pl(20, { serviceType: 'deezer', playlistId: '20' });
    const answers: Record<number, LinkProbeResult> = {
      1: GONE,
      2: DOWN,
      3: DOWN,
      4: DOWN,
      5: DOWN,
      6: DOWN,
      20: GONE,
    };
    const { deps, store, asked } = makeRun([...spotify, deezer], answers, { 1: LAST_NIGHT });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(report.stopped).toEqual([
      { channel: 'spotify', reason: expect.stringContaining('5 answers in a row'), skipped: 4 },
    ]);
    expect(asked).not.toContain(7);
    // The Spotify gone answer from before the stop does not count...
    expect(report.flagged).toEqual([]);
    expect(store.get(1)).toEqual(LAST_NIGHT);
    // ...but Deezer is asked as usual.
    expect(ids(report.firstStrikes)).toEqual([20]);
    expect(report.unknown).toBe(10);
  });

  it('waits out a short Retry-After once and asks again', async () => {
    const limited: LinkProbeResult = { ...DOWN, rateLimited: true, retryAfterSeconds: 10 };
    const { deps, asked } = makeRun([pl(1)], { 1: [limited, THERE] });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(report.available).toBe(1);
    expect(asked).toEqual([1, 1]);
    expect(deps.sleep).toHaveBeenCalledWith(10500);
  });

  it('stops asking a service that wants a long wait', async () => {
    const limited: LinkProbeResult = { ...DOWN, rateLimited: true, retryAfterSeconds: 3600 };
    const { deps, asked } = makeRun([pl(1), pl(2), pl(3)], { 1: limited });
    const report = await runLinkCheck(deps, { dryRun: false });

    expect(asked).toEqual([1]);
    expect(report.stopped[0]).toMatchObject({ channel: 'spotify', skipped: 2 });
    expect(deps.sleep).not.toHaveBeenCalledWith(3600 * 1000 + 500);
  });

  it('paces the requests per service', async () => {
    const { deps } = makeRun([pl(1), pl(2), pl(3, { serviceType: 'deezer', playlistId: '3' })]);
    await runLinkCheck(deps, { dryRun: false });
    // One pause between the two Spotify playlists; none after the last of a service.
    expect(deps.sleep.mock.calls.map((c) => c[0])).toEqual([2000]);
  });

  it('asks Spotify-owned playlists apart, so a dead scraper does not stop the Web API checks', () => {
    expect(channelOf({ serviceType: 'spotify', playlistId: '37i9dQZF1DXcBWIGoYBM5M' })).toBe('spotify-scraper');
    expect(channelOf({ serviceType: 'spotify', playlistId: '4rOoJ6Egrf8K2IrywzwOMk' })).toBe('spotify');
    expect(channelOf({ serviceType: 'apple_music', playlistId: 'pl.abc' })).toBe('apple_music');
  });

  it('writes nothing when a strike cannot be read', async () => {
    const { deps } = makeRun([pl(1), pl(2, { linkBroken: true })], { 1: GONE });
    deps.strikes.get.mockRejectedValueOnce(new Error('Redis down'));
    await expect(runLinkCheck(deps, { dryRun: false })).rejects.toThrow('Redis down');
    expect(deps.clearBroken).not.toHaveBeenCalled();
    expect(deps.markChecked).not.toHaveBeenCalled();
  });
});

describe('buildNotification', () => {
  const base = (): LinkCheckReport => ({
    dryRun: false,
    featured: 1,
    checked: 1,
    available: 1,
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
  });

  it('has nothing to say for a quiet night, first strikes included', () => {
    const report = base();
    report.firstStrikes = [
      { id: 1, playlistId: 'a', serviceType: 'spotify', slug: 's', name: 'n', link: 'l', reason: 'r' },
    ];
    expect(buildNotification(report)).toBeNull();
  });

  it('stays within Pushover’s 1024 characters', () => {
    const report = base();
    report.flagged = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      playlistId: `p${i}`,
      serviceType: 'youtube_music',
      slug: `a-very-long-slug-for-a-playlist-${i}`.repeat(3),
      name: `A playlist with a long name ${i}`.repeat(2),
      link: `https://music.youtube.com/playlist?list=PL${'x'.repeat(32)}`,
      reason: 'YouTube Music answers an empty playlist page (no contents, noindex)',
    }));
    const notice = buildNotification(report)!;
    expect(notice.message.length).toBeLessThanOrEqual(1024);
    expect(notice.message).toContain('more in the API log');
  });

  it('fitPushover leaves a short message alone', () => {
    expect(fitPushover('short')).toBe('short');
  });
});
