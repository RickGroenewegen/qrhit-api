import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { getISOWeek, getISOWeekYear } from 'date-fns';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import Spotify from '../../src/spotify';
import { Music } from '../../src/music';

/**
 * Public music + voting (hitlist) routes: company list lookup by slug,
 * vote submission incl. async track processing, verification, track link
 * resolution (/qrlink), featured playlists, URL recognition and Top40.
 *
 * Spotify and the multi-source year detection are mocked at the class
 * boundary — everything else (DB writes, scoring, card names) is real.
 */
describe('music and hitlist routes', () => {
  let app: FastifyInstance;
  let companyId: number;
  let listId: number;

  const spotifyTrack = (n: number) => ({
    trackId: `sp-track-${n}`,
    id: `sp-track-${n}`,
    artist: `Artist ${n}`,
    name: `Song ${n}`,
    album: `Album ${n}`,
    preview: null,
    isrc: `NLZ54190${100 + n}`,
    releaseDate: '1999-05-01',
    link: `https://open.spotify.com/track/sp-track-${n}`,
  });

  beforeAll(async () => {
    vi.spyOn(Spotify.prototype, 'getTracksByIds').mockImplementation(
      async (ids: string[]) => ({
        success: true,
        data: ids.map((id) => spotifyTrack(Number(id.replace('sp-track-', '')))),
      })
    );
    vi.spyOn(Spotify.prototype, 'searchTracks').mockResolvedValue({
      success: true,
      data: {
        tracks: [spotifyTrack(1)],
        totalCount: 1,
        offset: 0,
        limit: 10,
        hasMore: false,
      },
    } as any);
    vi.spyOn(Music.prototype, 'getReleaseDate').mockResolvedValue({
      year: 1999,
      sources: { spotify: 1999, discogs: null, ai: null, mb: null, openPerplex: null },
      googleResults: '[]',
      standardDeviation: 0,
    });

    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    const company = await prisma().company.create({
      data: { name: 'Voting Company BV' },
    });
    companyId = company.id;
    const list = await prisma().companyList.create({
      data: {
        companyId,
        name: 'Personeelsfeest',
        slug: 'personeelsfeest',
        numberOfTracks: 5,
        numberOfCards: 10,
        status: 'open',
        languages: 'nl,en',
      },
    });
    listId = list.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('voting portal lookup', () => {
    it('returns the company list by slug', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist',
        payload: { domain: 'qrvote.io', hash: '', slug: 'personeelsfeest' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Personeelsfeest');
      expect(body.data.companyName ?? body.data.Company?.name).toBeTruthy();
    });

    it('errors for an unknown slug', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist',
        payload: { domain: 'qrvote.io', hash: '', slug: 'bestaat-niet' },
      });
      expect(res.json().success).toBe(false);
    });
  });

  describe('vote submission', () => {
    const submissionHash = 'hitlist-submission-hash-1';

    it('rejects a submission without hash or list id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/submit',
        payload: {
          hitlist: [{ trackId: 'sp-track-1', position: 1 }],
        },
      });
      expect(res.json().success).toBe(false);
    });

    it('errors for an unknown company list', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/submit',
        payload: {
          hitlist: [{ trackId: 'sp-track-1', position: 1 }],
          companyListId: 999999,
          submissionHash: 'whatever-hash',
        },
      });
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Company list not found');
    });

    it('accepts a submission, builds the card name and stores the tracks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/submit',
        payload: {
          hitlist: [
            { trackId: 'sp-track-1', position: 1 },
            { trackId: 'sp-track-2', position: 2 },
            { trackId: 'sp-track-3', position: 3 },
          ],
          companyListId: listId,
          submissionHash,
          firstname: 'jan',
          lastname: 'van der velde',
          email: 'jan.voter@test.qrsong.io',
          locale: 'nl',
          agreeToUseName: true,
          marketingEmails: false,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const submission = await prisma().companyListSubmission.findUnique({
        where: { hash: submissionHash },
      });
      expect(submission).toBeTruthy();
      expect(submission!.status).toBe('pending_verification');
      // Dutch tussenvoegsel handling: "jan" + "van der velde" -> "Jan van der V."
      expect(submission!.cardName).toBe('Jan van der V.');

      // Track processing happens async after the response; poll briefly.
      let rows: any[] = [];
      for (let i = 0; i < 50; i++) {
        rows = await prisma().companyListSubmissionTrack.findMany({
          where: { companyListSubmissionId: submission!.id },
        });
        if (rows.length === 3) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(rows).toHaveLength(3);

      // The mocked year pipeline marked new tracks as checked with year 1999.
      const track = await prisma().track.findUnique({
        where: { trackId: 'sp-track-1' },
      });
      expect(track).toBeTruthy();
      expect(track!.year).toBe(1999);
      expect(track!.manuallyChecked).toBe(true);
    });

    it('blocks a second submission with the same email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/submit',
        payload: {
          hitlist: [{ trackId: 'sp-track-1', position: 1 }],
          companyListId: listId,
          submissionHash: 'another-hash-same-email',
          email: 'jan.voter@test.qrsong.io',
        },
      });
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('playlistAlreadySubmitted');
    });

    it('rejects submissions outside the voting window', async () => {
      await prisma().companyList.update({
        where: { id: listId },
        data: { endAt: new Date(Date.now() - 86400000) },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/submit',
        payload: {
          hitlist: [{ trackId: 'sp-track-1', position: 1 }],
          companyListId: listId,
          submissionHash: 'late-hash',
        },
      });
      expect(res.json().error).toBe('votingClosed');
      await prisma().companyList.update({
        where: { id: listId },
        data: { endAt: null },
      });
    });

    it('verifies the submission by verification hash', async () => {
      const submission = await prisma().companyListSubmission.findUnique({
        where: { hash: submissionHash },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/verify',
        payload: { hash: submission!.verificationHash },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const verified = await prisma().companyListSubmission.findUnique({
        where: { hash: submissionHash },
      });
      expect(verified!.verified).toBe(true);
    });

    it('fails verification with a bogus hash', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/verify',
        payload: { hash: 'bogus' },
      });
      expect(res.json().success).toBe(false);
    });

    it('requires a hash for verification', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/verify',
        payload: {},
      });
      expect(res.json().success).toBe(false);
    });
  });

  describe('hitlist search and tracks', () => {
    it('rejects a too-short search string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/search',
        payload: { searchString: 'a' },
      });
      expect(res.json().success).toBe(false);
    });

    it('returns spotify search results', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/search',
        payload: { searchString: 'Song 1' },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.tracks[0].name).toBe('Song 1');
    });

    it('rejects /hitlist/tracks without ids', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/tracks',
        payload: { trackIds: [] },
      });
      expect(res.json().success).toBe(false);
    });

    it('returns track details by ids', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/hitlist/tracks',
        payload: { trackIds: ['sp-track-7'] },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data[0].artist).toBe('Artist 7');
    });
  });

  describe('top 40 number one', () => {
    it('returns the #1 for a chart week', async () => {
      const date = new Date('2000-06-15');
      await prisma().top40Chart.create({
        data: {
          year: getISOWeekYear(date),
          weekNumber: getISOWeek(date),
          position: 1,
          artist: 'Anouk',
          title: 'Girl',
          externalId: 'tw-1',
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/hitlist/number-one/2000-06-15',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.artist).toBe('Anouk');
      expect(body.title).toBe('Girl');
    });
  });

  describe('music service registry', () => {
    it('recognizes a spotify playlist url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/music/recognize-url',
        payload: {
          url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
        },
      });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.serviceType).toBe('spotify');
      expect(body.data.playlistId).toBe('37i9dQZF1DXcBWIGoYBM5M');
    });

    it('rejects a missing url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/music/recognize-url',
        payload: {},
      });
      expect(res.json().success).toBe(false);
    });

    it('rejects an unrecognized url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/music/recognize-url',
        payload: { url: 'https://example.com/some/page' },
      });
      expect(res.json().success).toBe(false);
    });

    it('lists available services including spotify', async () => {
      const res = await app.inject({ method: 'GET', url: '/music/services' });
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.services).toContain('spotify');
    });
  });

  describe('featured playlists', () => {
    beforeAll(async () => {
      await prisma().playlist.create({
        data: {
          playlistId: 'featured-public-1',
          name: 'NL Hits',
          slug: 'nl-hits',
          image: 'img.png',
          featured: true,
          featuredLocale: 'nl',
          description_nl: 'De beste NL hits',
          score: 10,
        },
      });
      await prisma().playlist.create({
        data: {
          playlistId: 'featured-hidden-1',
          name: 'Hidden List',
          slug: 'hidden-list',
          image: 'img.png',
          featured: true,
          featuredHidden: true,
        },
      });
    });

    it('returns featured playlists for a locale', async () => {
      const res = await app.inject({ method: 'GET', url: '/featured/nl' });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.some((p: any) => p.playlistId === 'featured-public-1')).toBe(
        true
      );
      expect(data.some((p: any) => p.playlistId === 'featured-hidden-1')).toBe(
        false
      );
    });

    it('returns all featured playlists with ?all=true', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/featured/de?all=true',
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.some((p: any) => p.playlistId === 'featured-public-1')).toBe(
        true
      );
    });
  });

  describe('track links (/qrlink)', () => {
    let dbTrackId: number;

    beforeAll(async () => {
      const track = await prisma().track.create({
        data: {
          trackId: 'qrlink-track',
          name: 'Linked Song',
          artist: 'Linker',
          spotifyLink: 'https://open.spotify.com/track/qrlink',
          youtubeMusicLink: 'https://music.youtube.com/watch?v=abc',
          deezerLink: 'https://www.deezer.com/track/123',
        },
      });
      dbTrackId = track.id;
    });

    it('returns all known service links for a track', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/qrlink/${dbTrackId}`,
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone; like Mac OS X)' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.link).toBe('https://open.spotify.com/track/qrlink');
      expect(body.ym).toBe('https://music.youtube.com/watch?v=abc');
      expect(body.dz).toBe('https://www.deezer.com/track/123');
      expect(body.am).toBeNull();
    });

    it('serves the onboarding page on /qr/:trackId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/qr/${dbTrackId}`,
        headers: { 'accept-language': 'nl-NL,nl;q=0.9' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  describe('playlist link coverage', () => {
    it('400s an invalid playlist id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/playlist/abc/link-coverage',
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s an unknown slug', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/playlist/slug/does-not-exist/link-coverage',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns coverage for a playlist by slug', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/playlist/slug/nl-hits/link-coverage',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });
});
