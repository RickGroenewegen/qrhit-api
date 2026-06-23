import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import Utils from '../../src/utils';

/**
 * Integration coverage for the OnzeVibe company portal:
 * vibeRoutes.ts + vibe.ts (companies, lists, submissions, delivery
 * addresses, intake forms, events, calculators, order email).
 */
describe('vibe portal routes', () => {
  let app: FastifyInstance;
  let admin: Awaited<ReturnType<typeof createTestUser>>;
  let plainUser: Awaited<ReturnType<typeof createTestUser>>;
  let headers: Record<string, string>;

  // shared fixtures created in the flow below
  let companyId: number;
  let listId: number;

  beforeAll(async () => {
    vi.spyOn(Utils.prototype, 'verifyRecaptcha').mockResolvedValue({
      isHuman: true,
      score: 0.9,
    } as any);
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    // groups used by the public company-list-create flow
    await prisma().userGroup.createMany({
      data: [
        { id: 6, name: 'companyadmin' },
        { id: 7, name: 'qrvoteadmin' },
      ],
      skipDuplicates: true,
    });
    admin = await createTestUser({ groups: ['admin'] });
    plainUser = await createTestUser({ groups: ['users'] });
    headers = authHeader(admin.token);
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('auth guards', () => {
    it('rejects unauthenticated access', async () => {
      const res = await app.inject({ method: 'GET', url: '/vibe/companies' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects users without an allowed group', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/companies',
        headers: authHeader(plainUser.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('companies CRUD', () => {
    it('rejects creation without a name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companies',
        headers,
        payload: { city: 'Amsterdam' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('name');
    });

    it('creates a company and auto-creates the contact user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companies',
        headers,
        payload: {
          name: 'Acme Music BV',
          address: 'Hoofdstraat',
          housenumber: '12',
          city: 'Utrecht',
          zipcode: '3511AB',
          countrycode: 'NL',
          contact: 'Jan de Vries',
          contactemail: 'jan.devries@test.qrsong.io',
          contactphone: '+31612345678',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.company.name).toBe('Acme Music BV');
      companyId = body.company.id;

      const contact = await prisma().user.findUnique({
        where: { email: 'jan.devries@test.qrsong.io' },
      });
      expect(contact).toBeTruthy();
      expect(contact!.companyId).toBe(companyId);
    });

    it('refuses a duplicate company name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companies',
        headers,
        payload: { name: 'Acme Music BV' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Company with this name already exists');
    });

    it('lists all companies for an admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/companies',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { companies } = res.json();
      expect(Array.isArray(companies)).toBe(true);
      const mine = companies.find((c: any) => c.id === companyId);
      expect(mine).toBeTruthy();
      expect(mine.numberOfLists).toBe(0);
    });

    it('updates a company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}`,
        headers,
        payload: { name: 'Acme Music BV', city: 'Rotterdam', locale: 'nl' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const updated = await prisma().company.findUnique({
        where: { id: companyId },
      });
      expect(updated!.city).toBe('Rotterdam');
    });

    it('404s when updating an unknown company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/vibe/companies/999999',
        headers,
        payload: { name: 'Ghost BV' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('400s on a non-numeric company id', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/vibe/companies/abc',
        headers,
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns the users of a company', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/users/${companyId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(
        body.users.some((u: any) => u.email === 'jan.devries@test.qrsong.io')
      ).toBe(true);
    });

    it('404s for users of an unknown company', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/users/999999',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('toggles the favorite flag', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/favorite`,
        headers,
        payload: { favorite: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().favorite).toBe(true);

      const off = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/favorite`,
        headers,
        payload: { favorite: false },
      });
      expect(off.json().favorite).toBe(false);
    });

    it('404s favorite toggle for an unknown company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/vibe/companies/999999/favorite',
        headers,
        payload: { favorite: true },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('company lists', () => {
    it('rejects list creation with missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/lists`,
        headers,
        payload: { name: 'No slug' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates a list', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/lists`,
        headers,
        payload: {
          name: 'Zomerfeest 2026',
          description: 'Stem op je favoriete nummers',
          slug: 'zomerfeest-2026',
          numberOfCards: 200,
          numberOfTracks: 5,
          playlistSource: 'voting',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.list.slug).toBe('zomerfeest-2026');
      expect(body.list.status).toBe('new');
      listId = body.listId;
    });

    it('refuses a duplicate slug', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/lists`,
        headers,
        payload: {
          name: 'Another',
          description: 'x',
          slug: 'zomerfeest-2026',
          numberOfCards: 100,
          numberOfTracks: 3,
        },
      });
      expect(res.statusCode).toBe(409);
    });

    it('404s when the company does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companies/999999/lists',
        headers,
        payload: {
          name: 'Ghost',
          description: 'x',
          slug: 'ghost-list',
          numberOfCards: 100,
          numberOfTracks: 3,
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns company lists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/company/${companyId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.companyLists.some((l: any) => l.id === listId)).toBe(true);
    });

    it('updates list info fields', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/info`,
        headers,
        payload: {
          name: 'Zomerfeest 2026 v2',
          numberOfCards: 96,
          startAt: '2026-07-01T10:00:00.000Z',
          showNames: true,
          musicWishes: 'Veel NL hits',
          internalNotes: null,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.list.name).toBe('Zomerfeest 2026 v2');
      expect(body.list.numberOfCards).toBe(96);
      expect(body.list.showNames).toBe(true);
    });

    it('rejects an invalid status value', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/info`,
        headers,
        payload: { status: 'not-a-status' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid status value');
    });

    it('rejects a negative number field', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/info`,
        headers,
        payload: { numberOfTracks: -2 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid date', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/info`,
        headers,
        payload: { endAt: 'not-a-date' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty body', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/info`,
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('No fields to update');
    });

    it('409s when updating to a slug already in use', async () => {
      // create a second list whose slug we collide with
      const other = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/lists`,
        headers,
        payload: {
          name: 'Kerstborrel',
          description: 'x',
          slug: 'kerstborrel-2026',
          numberOfCards: 100,
          numberOfTracks: 3,
        },
      });
      expect(other.statusCode).toBe(201);
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/info`,
        headers,
        payload: { slug: 'kerstborrel-2026' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('404s info update on a list of another company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/999999/lists/${listId}/info`,
        headers,
        payload: { name: 'Stolen' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns the vibe state of a list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/state/${listId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.list.id).toBe(listId);
      expect(Array.isArray(body.list.languages)).toBe(true);
      expect(Array.isArray(body.questions)).toBe(true);
      expect(Array.isArray(body.ranking)).toBe(true);
      expect(Array.isArray(body.submissions)).toBe(true);
      expect(body.availableLocales).toContain('en');
    });

    it('404s the state of an unknown list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/state/999999',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('shows lists with status production in production-lists', async () => {
      await prisma().companyList.update({
        where: { id: listId },
        data: { status: 'production' },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/production-lists',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.lists.some((l: any) => l.id === listId)).toBe(true);
      // restore for later tests
      await prisma().companyList.update({
        where: { id: listId },
        data: { status: 'new' },
      });
    });

    it('refuses to delete a list whose status is not "new"', async () => {
      await prisma().companyList.update({
        where: { id: listId },
        data: { status: 'production' },
      });
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/lists/${listId}`,
        headers,
      });
      expect(res.statusCode).toBe(409);
      await prisma().companyList.update({
        where: { id: listId },
        data: { status: 'new' },
      });
    });

    it('403s deleting a list through the wrong company', async () => {
      const other = await app.inject({
        method: 'POST',
        url: '/vibe/companies',
        headers,
        payload: { name: 'Other Company BV' },
      });
      const otherCompanyId = other.json().company.id;
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${otherCompanyId}/lists/${listId}`,
        headers,
      });
      expect(res.statusCode).toBe(403);
    });

    it('deletes a fresh list', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/lists`,
        headers,
        payload: {
          name: 'Tijdelijk',
          description: 'x',
          slug: 'tijdelijke-lijst',
          numberOfCards: 50,
          numberOfTracks: 3,
        },
      });
      const tempId = created.json().listId;
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/lists/${tempId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      const gone = await prisma().companyList.findUnique({
        where: { id: tempId },
      });
      expect(gone).toBeNull();
    });

    it('404s deleting an unknown list', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/lists/999999`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns aggregate counts for a company', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/counts`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { counts } = res.json();
      expect(counts.contacts).toBeGreaterThanOrEqual(1);
      expect(counts.lists).toBeGreaterThanOrEqual(2);
      expect(counts.assets).toBe(0);
    });

    it('lists quotations for a company', async () => {
      await prisma().quotation.create({
        data: {
          quotationNumber: 'Q-2026-001',
          companyId,
          variant: 'schneider',
          quantity: 100,
        },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/quotations`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { quotations } = res.json();
      expect(quotations).toHaveLength(1);
      expect(quotations[0].quotationNumber).toBe('Q-2026-001');
    });
  });

  describe('delivery addresses', () => {
    let addressId: number;

    it('starts with no addresses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/delivery-addresses`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().addresses).toEqual([]);
    });

    it('requires name, address and country', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/lists/${listId}/delivery-addresses`,
        headers,
        payload: { name: 'Depot', address: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates an address', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/lists/${listId}/delivery-addresses`,
        headers,
        payload: {
          name: 'Hoofdkantoor',
          address: 'Stationsplein 1\n1012AB Amsterdam',
          country: 'Nederland',
        },
      });
      expect(res.statusCode).toBe(201);
      const { address } = res.json();
      expect(address.name).toBe('Hoofdkantoor');
      addressId = address.id;
    });

    it('updates an address', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/delivery-addresses/${addressId}`,
        headers,
        payload: {
          name: 'Magazijn',
          address: 'Industrieweg 5',
          country: 'Nederland',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().address.name).toBe('Magazijn');
    });

    it('404s updating an address of a different list', async () => {
      const otherList = await prisma().companyList.findFirst({
        where: { slug: 'kerstborrel-2026' },
      });
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${otherList!.id}/delivery-addresses/${addressId}`,
        headers,
        payload: { name: 'X', address: 'Y', country: 'Z' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s for a list that does not belong to the company', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/999999/lists/${listId}/delivery-addresses`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('deletes an address', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/lists/${listId}/delivery-addresses/${addressId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const del = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/lists/${listId}/delivery-addresses/${addressId}`,
        headers,
      });
      expect(del.statusCode).toBe(404);
    });
  });

  describe('design files', () => {
    it('returns an empty file list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/files`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().files).toEqual([]);
    });

    it('rejects an invalid file type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/files/poster/download`,
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s downloading a file that was never uploaded', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/files/cards/download`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s deleting a file that does not exist', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/lists/${listId}/files/box`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('order email', () => {
    it('builds the Dutch printer order email with warnings', async () => {
      await prisma().companyList.update({
        where: { id: listId },
        data: {
          printer: 'schneider',
          calculationSchneider: JSON.stringify({ quantity: 25, cardCount: 96 }),
          desiredDeliveryDate: new Date('2026-08-15T00:00:00.000Z'),
        },
      });
      await prisma().companyListDeliveryAddress.create({
        data: {
          companyListId: listId,
          name: 'Hoofdkantoor',
          address: 'Stationsplein 1\n1012AB Amsterdam',
          country: 'Nederland',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/order-email`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { email } = res.json();
      expect(email.totalBoxes).toBe(25);
      // company address + always-appended QRSong address
      expect(email.addressCount).toBe(2);
      expect(email.text).toContain('Goedendag');
      expect(email.text).toContain('15 augustus 2026');
      expect(email.html).toContain('<strong>25</strong>');
      // designs were never uploaded -> two file warnings
      expect(
        email.warnings.filter((w: string) => w.includes('ontbreekt')).length
      ).toBe(2);
    });

    it('404s for an unknown list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/999999/order-email`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('intake form', () => {
    let intakeToken: string;

    it('generates an intake token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/lists/${listId}/intake-link`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      intakeToken = res.json().intakeToken;
      expect(intakeToken.length).toBeGreaterThanOrEqual(16);
    });

    it('serves the intake data publicly by token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/intake/${intakeToken}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.company.name).toBe('Acme Music BV');
      expect(body.list.id).toBe(listId);
    });

    it('400s a too-short token', async () => {
      const res = await app.inject({ method: 'GET', url: '/vibe/intake/abc' });
      expect(res.statusCode).toBe(400);
    });

    it('404s an unknown token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/intake/unknown-token-unknown-token',
      });
      expect(res.statusCode).toBe(404);
    });

    it('saves intake fields publicly', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/intake/${intakeToken}`,
        payload: {
          musicWishes: 'Vooral jaren 90',
          numberOfCards: 144,
          personalizedApp: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const list = await prisma().companyList.findUnique({
        where: { id: listId },
      });
      expect(list!.musicWishes).toBe('Vooral jaren 90');
      expect(list!.numberOfCards).toBe(144);
      expect(list!.personalizedApp).toBe(true);
    });

    it('404s saving with an unknown token', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/vibe/intake/unknown-token-unknown-token',
        payload: { musicWishes: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('submissions', () => {
    let submissionId: number;
    let trackA: any;
    let trackB: any;

    beforeAll(async () => {
      trackA = await prisma().track.create({
        data: { trackId: 'spotify-track-a', name: 'Song A', artist: 'Artist A' },
      });
      trackB = await prisma().track.create({
        data: { trackId: 'spotify-track-b', name: 'Song B', artist: 'Artist B' },
      });
      const submission = await prisma().companyListSubmission.create({
        data: {
          companyListId: listId,
          hash: 'sub-hash-1',
          firstname: 'Piet',
          lastname: 'Jansen',
          email: 'piet@test.qrsong.io',
          locale: 'nl',
        },
      });
      submissionId = submission.id;
      await prisma().companyListSubmissionTrack.create({
        data: {
          companyListSubmissionId: submissionId,
          trackId: trackA.id,
          position: 1,
        },
      });
    });

    it('updates the card name', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/submissions/${submissionId}`,
        headers,
        payload: { cardName: 'Piet J.' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.cardName).toBe('Piet J.');
    });

    it('rejects an empty card name', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/submissions/${submissionId}`,
        headers,
        payload: { cardName: '   ' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s updating an unknown submission', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/vibe/submissions/999999',
        headers,
        payload: { cardName: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('verifies a submission', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/submissions/${submissionId}/verify`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.verified).toBe(true);
      expect(data.status).toBe('submitted');
    });

    it('replaces a track across submissions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/lists/${listId}/replace-track`,
        headers,
        payload: { sourceTrackId: trackA.id, destinationTrackId: trackB.id },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().updatedCount).toBe(1);
      const rows = await prisma().companyListSubmissionTrack.findMany({
        where: { companyListSubmissionId: submissionId },
      });
      expect(rows[0].trackId).toBe(trackB.id);
    });

    it('400s replace-track with missing params', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/lists/${listId}/replace-track`,
        headers,
        payload: { sourceTrackId: trackA.id },
      });
      expect(res.statusCode).toBe(400);
    });

    it('includes the submission with voteCount in the state', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/state/${listId}`,
        headers,
      });
      const body = res.json();
      const sub = body.submissions.find((s: any) => s.id === submissionId);
      expect(sub).toBeTruthy();
      expect(sub.voteCount).toBe(1);
      expect(sub.verified).toBe(true);
    });

    it('deletes a submission', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/submissions/${submissionId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const gone = await app.inject({
        method: 'DELETE',
        url: `/vibe/submissions/${submissionId}`,
        headers,
      });
      expect(gone.statusCode).toBe(404);
    });
  });

  describe('company events', () => {
    let eventId: number;

    it('starts empty', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/events`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().events).toEqual([]);
    });

    it('creates an event from a JSON body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/events`,
        headers,
        payload: { content: 'Kickoff call gepland' },
      });
      expect(res.statusCode).toBe(200);
      const { event } = res.json();
      expect(event.content).toBe('Kickoff call gepland');
      eventId = event.id;
    });

    it('rejects an empty content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/vibe/companies/${companyId}/events`,
        headers,
        payload: { content: '   ' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('updates an event', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/events/${eventId}`,
        headers,
        payload: { content: 'Kickoff call verzet' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().event.content).toBe('Kickoff call verzet');
    });

    it('404s updating an unknown event', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/events/999999`,
        headers,
        payload: { content: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('deletes an event', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/events/${eventId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const gone = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/events/${eventId}`,
        headers,
      });
      expect(gone.statusCode).toBe(404);
    });
  });

  describe('pricing calculators', () => {
    it('calculates standard OnzeVibe pricing for the 100 tier', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate',
        headers,
        payload: {
          quantity: 100,
          includePersonalization: true,
          shipmentOnLocation: false,
          soldBy: 'happibox',
          isReseller: false,
          manualDiscount: 0,
        },
      });
      expect(res.statusCode).toBe(200);
      const { calculation } = res.json();
      expect(calculation.tierKey).toBe(100);
      expect(calculation.pricing.commercialPricePerBox).toBe(44.95);
      // kickback 3 + half reseller discount 1.5395 -> 4.54
      expect(calculation.pricing.profitPerBox).toBe(4.54);
      expect(calculation.pricing.clientPrice).toBe(4495);
      expect(calculation.pricing.ourProfit).toBe(454);
      expect(calculation.pricing.happiBoxPayment).toBe(4041);
    });

    it('drops project management when sold by onzevibe', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate',
        headers,
        payload: {
          quantity: 100,
          includePersonalization: true,
          shipmentOnLocation: false,
          soldBy: 'onzevibe',
          isReseller: false,
          manualDiscount: 0,
        },
      });
      const { calculation } = res.json();
      expect(calculation.pricing.commercialPricePerBox).toBe(39.95);
      expect(calculation.adjustments.adjustedProjectManagement).toBe(0);
    });

    it('uses tier brackets in standard mode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate',
        headers,
        payload: {
          quantity: 600,
          includePersonalization: true,
          shipmentOnLocation: false,
          soldBy: 'happibox',
          isReseller: true,
          manualDiscount: 0,
        },
      });
      const { calculation } = res.json();
      expect(calculation.tierKey).toBe(500);
      expect(calculation.pricing.commercialPricePerBox).toBe(22.95);
      // reseller keeps the reseller discount
      expect(calculation.pricing.resellerProfit).toBe(
        Math.round(3.46 * 600 * 100) / 100
      );
    });

    it('interpolates between tiers in fluid mode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate',
        headers,
        payload: {
          quantity: 175,
          includePersonalization: true,
          shipmentOnLocation: false,
          soldBy: 'happibox',
          isReseller: false,
          manualDiscount: 0,
          fluidMode: true,
        },
      });
      const { calculation } = res.json();
      expect(calculation.tierKey).toBe(100);
      // halfway between 44.95 and 30.95
      expect(calculation.pricing.commercialPricePerBox).toBe(37.95);
    });

    it('caps fluid mode at the 5000 tier', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate',
        headers,
        payload: {
          quantity: 6000,
          includePersonalization: true,
          shipmentOnLocation: false,
          soldBy: 'happibox',
          isReseller: false,
          manualDiscount: 0,
          fluidMode: true,
        },
      });
      const { calculation } = res.json();
      expect(calculation.tierKey).toBe(5000);
      expect(calculation.pricing.commercialPricePerBox).toBe(16.95);
    });

    it('adds one-time custom app and voting portal fees', async () => {
      const base = await app.inject({
        method: 'POST',
        url: '/vibe/calculate',
        headers,
        payload: {
          quantity: 100,
          includePersonalization: true,
          shipmentOnLocation: false,
          soldBy: 'happibox',
          isReseller: false,
          manualDiscount: 0,
        },
      });
      const withExtras = await app.inject({
        method: 'POST',
        url: '/vibe/calculate',
        headers,
        payload: {
          quantity: 100,
          includePersonalization: true,
          shipmentOnLocation: false,
          soldBy: 'happibox',
          isReseller: false,
          manualDiscount: 0,
          includeCustomApp: true,
          includeVotingPortal: true,
        },
      });
      const a = base.json().calculation.pricing;
      const b = withExtras.json().calculation.pricing;
      expect(b.clientPrice).toBe(a.clientPrice + 850);
      expect(b.ourProfit).toBe(a.ourProfit + 850);
    });

    it('rejects an invalid quantity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate',
        headers,
        payload: {
          quantity: 0,
          includePersonalization: true,
          shipmentOnLocation: false,
          soldBy: 'happibox',
          isReseller: false,
          manualDiscount: 0,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid quantity');
    });

    it('calculates Tromp pricing for own printing with extras', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate-tromp',
        headers,
        payload: {
          quantity: 100,
          includeStansmestekening: true,
          includeStansvorm: true,
          profitMargin: 2,
        },
      });
      expect(res.statusCode).toBe(200);
      const { calculation } = res.json();
      expect(calculation.boxTypeName).toBe('Volledig eigen bedrukking');
      expect(calculation.cardsPerSet).toBe(200);
      // boxes (100*0.335+830=863.5) + cards (100*5.9+250=840)
      expect(calculation.boxPrice).toBe(863.5);
      expect(calculation.cardPrice).toBe(840);
      expect(calculation.extrasTotal).toBe(575);
      expect(calculation.pricePerSet).toBe(19.04);
      expect(calculation.ourProfit).toBe(200);
    });

    it('calculates Tromp pricing for the luxe box', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate-tromp',
        headers,
        payload: {
          quantity: 100,
          includeStansmestekening: false,
          includeStansvorm: false,
          profitMargin: 0,
          printingType: 'luxe',
        },
      });
      const { calculation } = res.json();
      expect(calculation.boxPrice).toBe(3850 + 10.5 * 100);
      expect(calculation.cardPrice).toBe(0);
      expect(calculation.cardsPerSet).toBe(200);
      expect(calculation.boxTypeName).toContain('Luxe doos');
    });

    it('calculates Tromp pricing for the small pre-printed box', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate-tromp',
        headers,
        payload: {
          quantity: 100,
          includeStansmestekening: false,
          includeStansvorm: false,
          profitMargin: 0,
          printingType: 'klein',
        },
      });
      const { calculation } = res.json();
      expect(calculation.cardsPerSet).toBe(100);
      expect(calculation.boxPrice).toBe(116.5);
      // ((840-100)*0.5)+100
      expect(calculation.cardPrice).toBe(470);
    });

    it('rejects an invalid Tromp quantity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate-tromp',
        headers,
        payload: {
          quantity: 0,
          includeStansmestekening: false,
          includeStansvorm: false,
          profitMargin: 0,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('calculates Schneider pricing for 96 cards', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate-schneider',
        headers,
        payload: {
          quantity: 100,
          cardCount: 96,
          includeStansmes: false,
          profitMargin: 0,
        },
      });
      expect(res.statusCode).toBe(200);
      const { calculation } = res.json();
      expect(calculation.boxType).toBe('2-vaks luxe dekseldoosje');
      expect(calculation.fixedCost).toBe(790);
      expect(calculation.pricePerPiece).toBe(2.16);
      expect(calculation.pricePerBox).toBe(10.06);
      expect(calculation.clientPrice).toBe(1006);
    });

    it('applies the 30% reseller discount on the 48-card tier price', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate-schneider',
        headers,
        payload: {
          quantity: 600,
          cardCount: 48,
          includeStansmes: false,
          profitMargin: 0,
        },
      });
      const { calculation } = res.json();
      // 600 qualifies for the 500 tier: 2.21 * 0.7 = 1.547 -> 1.55
      expect(calculation.pricePerPiece).toBe(1.55);
      expect(calculation.fixedCost).toBe(0);
      expect(calculation.boxType).toBe('1-vaks luxe dekseldoosje');
    });

    it('adds the stansmes for 192 cards', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate-schneider',
        headers,
        payload: {
          quantity: 50,
          cardCount: 192,
          includeStansmes: true,
          profitMargin: 1,
        },
      });
      const { calculation } = res.json();
      expect(calculation.boxType).toBe('4-vaks luxe dekseldoosje');
      expect(
        calculation.extras.some(
          (e: any) => e.name === 'Stansmes 4-vaks doosje' && e.price === 375
        )
      ).toBe(true);
    });

    it('rejects an invalid Schneider card count', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/calculate-schneider',
        headers,
        payload: {
          quantity: 100,
          cardCount: 50,
          includeStansmes: false,
          profitMargin: 0,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid card count');
    });
  });

  describe('pricing-tables profit config', () => {
    it('returns nulls when nothing is stored', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/pricing-tables/profit-config',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ profitMatrix: null, defaultProfits: null });
    });

    it('stores and returns the config', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/vibe/pricing-tables/profit-config',
        headers,
        payload: {
          profitMatrix: { schneider: { '100': 2 } },
          defaultProfits: { schneider: { profit: 2 } },
        },
      });
      expect(put.statusCode).toBe(200);
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/pricing-tables/profit-config',
        headers,
      });
      expect(res.json()).toEqual({
        profitMatrix: { schneider: { '100': 2 } },
        defaultProfits: { schneider: { profit: 2 } },
      });
    });
  });

  describe('public company list creation', () => {
    it('rejects missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companylist/create',
        payload: { fullname: 'Jan' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects mismatching passwords', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companylist/create',
        payload: {
          fullname: 'Klaas Visser',
          company: 'Visser Events',
          email: 'klaas@test.qrsong.io',
          captchaToken: 'tok',
          password1: 'Sup3rSecret!',
          password2: 'Different1!',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Passwords do not match');
    });

    it('rejects a weak password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companylist/create',
        payload: {
          fullname: 'Klaas Visser',
          company: 'Visser Events',
          email: 'klaas@test.qrsong.io',
          captchaToken: 'tok',
          password1: 'alllowercase1!',
          password2: 'alllowercase1!',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('uppercase');
    });

    it('creates company, list and portal user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companylist/create',
        payload: {
          fullname: 'Klaas Visser',
          company: 'Visser Events',
          email: 'klaas@test.qrsong.io',
          phone: '+31698765432',
          captchaToken: 'tok',
          password1: 'Sup3rSecret!',
          password2: 'Sup3rSecret!',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.company.name).toBe('Visser Events');
      expect(body.list.slug).toBe('visser-events');

      const user = await prisma().user.findUnique({
        where: { email: 'klaas@test.qrsong.io' },
      });
      expect(user).toBeTruthy();
      expect(user!.companyId).toBe(body.company.id);
      expect(user!.verified).toBe(true);
    });

    it('409s when the company already exists', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companylist/create',
        payload: {
          fullname: 'Klaas Visser',
          company: 'Visser Events',
          email: 'klaas2@test.qrsong.io',
          captchaToken: 'tok',
        },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects when the captcha fails', async () => {
      (Utils.prototype.verifyRecaptcha as any).mockResolvedValueOnce({
        isHuman: false,
        score: 0.1,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/companylist/create',
        payload: {
          fullname: 'Bot Botsson',
          company: 'Botfarm BV',
          email: 'bot@test.qrsong.io',
          captchaToken: 'tok',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('reCAPTCHA verification failed');
    });
  });
});
