import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import { verifyToken } from '../../src/auth';

/**
 * Integration coverage for the admin panel routes in adminRoutes.ts and the
 * data-layer modules they call (discounts, tracks, featured/promotional
 * playlists, broken/unknown links, settings, shipping config, charts...).
 */
describe('admin routes', () => {
  let app: FastifyInstance;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let headers: Record<string, string>;
  let customer: Awaited<ReturnType<typeof createTestUser>>;
  let trackId: number;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    admin = await createTestUser({ groups: ['admin'] });
    customer = await createTestUser({ groups: ['users'] });
    headers = authHeader(admin.token);

    const track = await prisma().track.create({
      data: {
        trackId: 'admin-track-1',
        name: 'Dancing Queen',
        artist: 'ABBA',
        year: 1976,
      },
    });
    trackId = track.id;
    await prisma().track.create({
      data: {
        trackId: 'admin-track-2',
        name: 'Waterloo',
        artist: 'ABBA',
        year: 1974,
        spotifyLink: 'https://open.spotify.com/track/xyz',
      },
    });
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('discount management', () => {
    let discountId: number;

    it('rejects an invalid amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/discount/create',
        headers,
        payload: { amount: -5 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid amount');
    });

    it('creates a discount with a manual code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/discount/create',
        headers,
        payload: {
          amount: 25,
          code: 'summer-sale',
          description: 'Summer promo',
          digital: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().code).toBe('SUMMER-SALE');
      const row = await prisma().discountCode.findUnique({
        where: { code: 'SUMMER-SALE' },
      });
      expect(row!.amount).toBe(25);
      expect(row!.digital).toBe(true);
      discountId = row!.id;
    });

    it('refuses a duplicate manual code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/discount/create',
        headers,
        payload: { amount: 10, code: 'SUMMER-SALE' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Discount code already exists');
    });

    it('generates a random code when none is given', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/discount/create',
        headers,
        payload: { amount: 10 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    });

    it('lists all discounts', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/discount/all',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { discounts } = res.json();
      expect(discounts.length).toBeGreaterThanOrEqual(2);
    });

    it('searches discounts by term', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/discount/search',
        headers,
        payload: { searchTerm: 'SUMMER' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.discounts[0].code).toBe('SUMMER-SALE');
    });

    it('updates a discount', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/admin/discount/${discountId}`,
        headers,
        payload: { amount: 50, description: 'Bigger promo' },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().discountCode.findUnique({
        where: { id: discountId },
      });
      expect(row!.amount).toBe(50);
      expect(row!.description).toBe('Bigger promo');
    });

    it('rejects an update with an invalid amount', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/admin/discount/${discountId}`,
        headers,
        payload: { amount: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400s a non-numeric discount id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/discount/abc',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('deletes a discount', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/discount/${discountId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().discountCode.findUnique({
        where: { id: discountId },
      });
      expect(row).toBeNull();
    });
  });

  describe('site settings', () => {
    it('404s when no settings row exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/settings',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('creates settings through PUT when none exist', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/settings',
        headers,
        payload: { productionDays: 5, productionMessage: 'Busy season' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.productionDays).toBe(5);
    });

    it('returns the stored settings', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/settings',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.productionDays).toBe(5);
      expect(data.productionMessage).toBe('Busy season');
    });

    it('rejects a negative productionDays', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/settings',
        headers,
        payload: { productionDays: -1 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('shipping config', () => {
    it('starts empty', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/shipping-config',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
    });

    it('rejects an invalid country code', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-config/NLD',
        headers,
        payload: { minDaysOffset: 1, maxDaysOffset: 2 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-numeric offsets', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-config/NL',
        headers,
        payload: { minDaysOffset: 'one', maxDaysOffset: 2 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('upserts a config for a country', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-config/NL',
        headers,
        payload: { minDaysOffset: 1, maxDaysOffset: 3 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.minDaysOffset).toBe(1);

      const list = await app.inject({
        method: 'GET',
        url: '/admin/shipping-config',
        headers,
      });
      expect(
        list.json().data.some((c: any) => c.countryCode?.toUpperCase() === 'NL')
      ).toBe(true);
    });

    it('deletes the config', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/shipping-config/NL',
        headers,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('email templates', () => {
    it('lists the templates from _data/mail.json', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/email-templates',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { templates } = res.json();
      expect(Array.isArray(templates)).toBe(true);
      expect(templates.length).toBeGreaterThan(0);
    });
  });

  describe('broken links', () => {
    let linkId: number;

    beforeAll(async () => {
      const link = await prisma().brokenLink.create({
        data: {
          url: 'https://open.spotify.com/track/broken1',
          type: 'invalid',
          serviceType: 'spotify',
          errorType: 'not_found',
        } as any,
      });
      linkId = link.id;
    });

    it('lists broken links', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/broken-links',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.data.some((l: any) => l.id === linkId)).toBe(true);
    });

    it('counts broken links', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/broken-links/count',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBeGreaterThanOrEqual(1);
    });

    it('toggles the ignored flag', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/broken-links/${linkId}/ignore`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ignored).toBe(true);
    });

    it('deletes a broken link', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/broken-links/${linkId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().brokenLink.findUnique({ where: { id: linkId } });
      expect(row).toBeNull();
    });

    it('deletes all broken links', async () => {
      await prisma().brokenLink.create({
        data: {
          url: 'https://open.spotify.com/track/broken2',
          type: 'invalid',
          serviceType: 'spotify',
          errorType: 'not_found',
        } as any,
      });
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/broken-links',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toBeGreaterThanOrEqual(1);
    });
  });

  describe('unknown links', () => {
    let linkId: number;

    beforeAll(async () => {
      const link = await prisma().unknownLink.create({
        data: { url: 'https://example.test/unknown1' } as any,
      });
      linkId = link.id;
    });

    it('lists unknown links', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/unknown-links',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('counts non-ignored unknown links', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/unknown-links/count',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBeGreaterThanOrEqual(1);
    });

    it('toggles ignored and excludes it from the count', async () => {
      const before = (
        await app.inject({
          method: 'GET',
          url: '/admin/unknown-links/count',
          headers,
        })
      ).json().count;
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/unknown-links/${linkId}/ignore`,
        headers,
      });
      expect(res.json().ignored).toBe(true);
      const after = (
        await app.inject({
          method: 'GET',
          url: '/admin/unknown-links/count',
          headers,
        })
      ).json().count;
      expect(after).toBe(before - 1);
    });

    it('404s toggling an unknown id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/unknown-links/999999/ignore',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('deletes one and then all unknown links', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/unknown-links/${linkId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);

      await prisma().unknownLink.create({
        data: { url: 'https://example.test/unknown2' } as any,
      });
      const all = await app.inject({
        method: 'DELETE',
        url: '/admin/unknown-links',
        headers,
      });
      expect(all.statusCode).toBe(200);
      expect(all.json().deleted).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tracks admin', () => {
    it('searches tracks by name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/search',
        headers,
        payload: { searchTerm: 'Dancing' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('Dancing Queen');
    });

    it('searches tracks missing a spotify link', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/search',
        headers,
        payload: { searchTerm: 'ABBA', missingService: 'spotify' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.some((t: any) => t.name === 'Dancing Queen')).toBe(true);
      expect(body.data.some((t: any) => t.name === 'Waterloo')).toBe(false);
    });

    it('rejects a track update with missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/update',
        headers,
        payload: { id: trackId, artist: 'ABBA' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
    });

    it('updates a track and marks it manually corrected', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tracks/update',
        headers,
        payload: {
          id: trackId,
          artist: 'ABBA',
          name: 'Dancing Queen',
          year: 1977,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const row = await prisma().track.findUnique({ where: { id: trackId } });
      expect(row!.year).toBe(1977);
      expect(row!.manuallyCorrected).toBe(true);
    });
  });

  describe('featured and promotional playlists', () => {
    let featuredPlaylistDbId: number;

    beforeAll(async () => {
      await prisma().playlist.create({
        data: {
          playlistId: 'featured-1',
          name: 'Greatest Hits',
          slug: 'greatest-hits',
          image: 'img.png',
          featured: true,
          featuredLocale: 'en',
        },
      });
      featuredPlaylistDbId = (
        await prisma().playlist.findUnique({ where: { playlistId: 'featured-1' } })
      )!.id;
      await prisma().playlist.create({
        data: {
          playlistId: 'promo-pending-1',
          name: 'Pending Promo',
          slug: 'pending-promo',
          image: 'img.png',
          promotionalActive: true,
          promotionalTitle: 'My cool playlist',
          promotionalUserId: customer.user.id,
        },
      });
      await prisma().playlist.create({
        data: {
          playlistId: 'promo-accepted-1',
          name: 'Accepted Promo',
          slug: 'accepted-promo',
          image: 'img.png',
          promotionalActive: true,
          promotionalAccepted: true,
        },
      });
    });

    it('lists all featured playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/featured/all',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.some((p: any) => p.playlistId === 'featured-1')).toBe(true);
    });

    it('searches featured playlists', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/featured/search',
        headers,
        payload: { searchTerm: 'Greatest', page: 1, limit: 10 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(
        body.approved.data.some((p: any) => p.playlistId === 'featured-1')
      ).toBe(true);
    });

    it('counts pending promotional playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/promotional/pending-count',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBe(1);
    });

    it('lists pending promotional playlists with submitter info', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/promotional/pending',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('My cool playlist');
      expect(data[0].userEmail).toBe(customer.user.email);
    });

    it('lists accepted promotional playlists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/promotional/accepted',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.some((p: any) => p.playlistId === 'promo-accepted-1')).toBe(
        true
      );
    });

    it('requires a boolean for the featured flag', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/playlist/featured-1/featured',
        headers,
        payload: { featured: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('unfeatures a playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/playlist/featured-1/featured',
        headers,
        payload: { featured: false },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().playlist.findUnique({
        where: { playlistId: 'featured-1' },
      });
      expect(row!.featured).toBe(false);
      // restore
      await prisma().playlist.update({
        where: { id: featuredPlaylistDbId },
        data: { featured: true },
      });
    });
  });

  describe('misc admin endpoints', () => {
    it('returns analytics counters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/analytics',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(typeof body.data).toBe('object');
    });

    it('returns last plays', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/lastplays',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('returns corrections', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/corrections',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns chart data for moving average, hourly and daily sales', async () => {
      for (const url of [
        '/admin/charts/moving-average',
        '/admin/charts/hourly-sales',
        '/admin/charts/daily-sales',
      ]) {
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
      }
    });

    it('reads and toggles the spotify provider', async () => {
      const initial = await app.inject({
        method: 'GET',
        url: '/admin/spotify/provider-status',
        headers,
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().playlistProvider).toBe('v1');

      const toggle = await app.inject({
        method: 'POST',
        url: '/admin/spotify/toggle-provider',
        headers,
        payload: { provider: 'scraper', target: 'playlist' },
      });
      expect(toggle.statusCode).toBe(200);

      const after = await app.inject({
        method: 'GET',
        url: '/admin/spotify/provider-status',
        headers,
      });
      expect(after.json().playlistProvider).toBe('scraper');

      // reset back to default
      const reset = await app.inject({
        method: 'POST',
        url: '/admin/spotify/toggle-provider',
        headers,
        payload: { provider: 'v1', target: 'playlist' },
      });
      expect(reset.statusCode).toBe(200);
    });

    it('rejects an invalid provider toggle', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/spotify/toggle-provider',
        headers,
        payload: { provider: 'v9', target: 'playlist' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('external cards', () => {
    beforeAll(async () => {
      await prisma().externalCard.create({
        data: {
          cardType: 'jumbo',
          sku: 'aaaa0001',
          cardNumber: '1',
          spotifyLink: 'https://open.spotify.com/track/abc',
        },
      });
      await prisma().externalCard.create({
        data: {
          cardType: 'country',
          countryCode: 'nl',
          cardNumber: '2',
        },
      });
    });

    it('lists external cards', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/external-cards',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('filters by card type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/external-cards?cardType=jumbo',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.data.every((c: any) => c.cardType === 'jumbo')).toBe(true);
    });

    it('filters by missing service link', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/external-cards?missingLink=tidal',
        headers,
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns aggregate stats', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/external-cards/stats',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  describe('user management', () => {
    it('impersonates a customer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/impersonate',
        headers,
        payload: { email: customer.user.email },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      const decoded = verifyToken(body.token);
      expect(decoded.userId).toBe(customer.user.userId);
      expect(decoded.userGroups).toContain('users');
    });

    it('refuses to impersonate an admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/impersonate',
        headers,
        payload: { email: admin.user.email },
      });
      expect(res.statusCode).toBe(403);
    });

    it('404s impersonating an unknown user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/impersonate',
        headers,
        payload: { email: 'ghost@test.qrsong.io' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('400s impersonation without an email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/impersonate',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('deletes a user by id', async () => {
      const victim = await createTestUser({ groups: ['users'] });
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/user/${victim.user.id}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().user.findUnique({
        where: { id: victim.user.id },
      });
      expect(row).toBeNull();
    });

    it('400s an invalid user id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/user/abc',
        headers,
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
