import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';

/**
 * Playlist suggestions document: the unauthenticated HTML view the Lambda
 * screenshots, plus the admin genre list and live count endpoints.
 */
describe('playlist suggestions document', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let popGenreId: number;
  let rockGenreId: number;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    const admin = await createTestUser({ groups: ['admin'] });
    headers = authHeader(admin.token);

    const genreNames = (name: string) => ({
      name_en: name,
      name_nl: name,
      name_de: name,
      name_fr: name,
      name_es: name,
      name_it: name,
      name_pt: name,
      name_pl: name,
      name_jp: name,
    });
    const pop = await prisma().genre.create({ data: { slug: 'pop', ...genreNames('Pop') } });
    const rock = await prisma().genre.create({ data: { slug: 'rock', ...genreNames('Rock') } });
    popGenreId = pop.id;
    rockGenreId = rock.id;

    const base = {
      featured: true,
      image: 'https://i.scdn.co/image/x',
      price: 0,
      priceDigital: 0,
      priceSheets: 0,
    };
    await prisma().playlist.createMany({
      data: [
        {
          ...base,
          playlistId: 'sugg-nl-50',
          name: 'Nederlandse Hits',
          slug: 'nederlandse-hits',
          featuredLocale: 'nl',
          numberOfTracks: 50,
          score: 90,
          genreId: popGenreId,
          description_en: 'Fifty Dutch classics.',
          description_de: 'Fünfzig niederländische Klassiker.',
        },
        {
          ...base,
          playlistId: 'sugg-denl-120',
          name: 'Schlager und Nederpop',
          slug: 'schlager-nederpop',
          featuredLocale: 'de,nl',
          numberOfTracks: 120,
          score: 50,
          genreId: rockGenreId,
          description_en: 'Big in two markets.',
        },
        {
          ...base,
          playlistId: 'sugg-intl-250',
          name: 'Global Party',
          slug: 'global-party',
          featuredLocale: null,
          numberOfTracks: 250,
          score: 70,
          genreId: popGenreId,
          description_en: 'Party hits from everywhere.',
        },
        {
          ...base,
          playlistId: 'sugg-hidden',
          name: 'Hidden Gems',
          slug: 'hidden-gems',
          featuredLocale: null,
          featuredHidden: true,
          numberOfTracks: 300,
          score: 99,
          genreId: popGenreId,
        },
        {
          ...base,
          playlistId: 'sugg-pending',
          name: 'Pending Promo',
          slug: 'pending-promo',
          featuredLocale: null,
          promotionalActive: true,
          promotionalAccepted: false,
          numberOfTracks: 300,
          score: 99,
          genreId: popGenreId,
        },
      ],
    });
    // The featured list is cached per day; make sure the seed is what renders.
    await flushTestRedis();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('GET /vibe/playlist-suggestions', () => {
    it('renders the document in the requested language', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions?locale=de&cardCount=48',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('lang="de"');
      // Description comes from the document language column.
      expect(res.body).toContain('Fünfzig niederländische Klassiker.');
      // English fallback when the German column is empty.
      expect(res.body).toContain('Party hits from everywhere.');
    });

    it('lists only playlists with enough tracks for the box', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions?locale=en&cardCount=200',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Global Party');
      expect(res.body).not.toContain('Nederlandse Hits');
      expect(res.body).not.toContain('Schlager und Nederpop');
    });

    it('filters on locale but always keeps international playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions?locale=en&cardCount=48&locales=de',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Schlager und Nederpop');
      expect(res.body).toContain('Global Party');
      expect(res.body).not.toContain('Nederlandse Hits');
    });

    it('filters on genre', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/playlist-suggestions?locale=en&cardCount=48&genreIds=${rockGenreId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Schlager und Nederpop');
      expect(res.body).not.toContain('Global Party');
    });

    it('never shows hidden or pending promotional playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions?locale=en&cardCount=48',
      });
      expect(res.body).not.toContain('Hidden Gems');
      expect(res.body).not.toContain('Pending Promo');
    });

    it('links every playlist to Spotify and notes when we make a selection', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions?locale=en&cardCount=96',
      });
      expect(res.body).toContain('https://open.spotify.com/playlist/sugg-intl-250');
      // Said once in the intro as soon as any listed playlist has more tracks than the box.
      expect(res.body).toContain('We select the 96 best-fitting tracks');
      expect(res.body).toContain('250 tracks');
      // A selection where every playlist fits exactly has no such note.
      const exact = await app.inject({
        method: 'GET',
        url: `/vibe/playlist-suggestions?locale=en&cardCount=48&genreIds=${rockGenreId}`,
      });
      expect(exact.body).toContain('Schlager und Nederpop');
      expect(exact.body).toContain('We select the 48 best-fitting tracks');
      const none = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions?locale=en&cardCount=200&genreIds=999999',
      });
      expect(none.body).toContain('No playlists match this selection.');
      expect(none.body).not.toContain('best-fitting tracks');
    });

    it('points every card at the cached artwork route and 404s for unknown playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions?locale=en&cardCount=48',
      });
      expect(res.body).toContain('/vibe/playlist-suggestions/art/sugg-intl-250');
      expect(res.body).not.toContain('https://i.scdn.co/image/x');

      const art = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions/art/does-not-exist',
      });
      expect(art.statusCode).toBe(404);
    });

    it('rejects an unsupported card count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/playlist-suggestions?cardCount=100',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid cardCount' });
    });
  });

  describe('admin endpoints', () => {
    it('requires an admin for the genre list and the count', async () => {
      expect((await app.inject({ method: 'GET', url: '/admin/genres' })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/admin/playlist-suggestions/count' })).statusCode
      ).toBe(401);
    });

    it('lists genres with the number of visible featured playlists', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/genres', headers });
      expect(res.statusCode).toBe(200);
      const genres = res.json().data as { id: number; name: string; featuredCount: number }[];
      const pop = genres.find((g) => g.id === popGenreId);
      const rock = genres.find((g) => g.id === rockGenreId);
      // Hidden Gems is excluded; Pending Promo is still featured and not hidden.
      expect(pop?.featuredCount).toBe(3);
      expect(rock?.featuredCount).toBe(1);
      expect(genres.map((g) => g.name)).toEqual(['Pop', 'Rock']);
    });

    it('counts the matching playlists for the modal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/playlist-suggestions/count?cardCount=96&locales=nl',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, count: 2 });
    });

    it('requires an admin for the PDF and validates the body', async () => {
      const anon = await app.inject({
        method: 'POST',
        url: '/vibe/playlist-suggestions/pdf',
        payload: { cardCount: 96 },
      });
      expect(anon.statusCode).toBe(401);

      const bad = await app.inject({
        method: 'POST',
        url: '/vibe/playlist-suggestions/pdf',
        headers,
        payload: { cardCount: 100 },
      });
      expect(bad.statusCode).toBe(400);
    });
  });
});
