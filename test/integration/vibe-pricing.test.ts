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

/**
 * Vibe pricing persistence (company/list calculations), quotation HTML
 * views, technical instructions, pricing table views and company deletion.
 */
describe('vibe pricing and quotation views', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let companyId: number;
  let listId: number;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    const admin = await createTestUser({ groups: ['admin'] });
    headers = authHeader(admin.token);

    const company = await prisma().company.create({
      data: { name: 'Pricing Company BV', contact: 'Contact Person' },
    });
    companyId = company.id;
    const list = await prisma().companyList.create({
      data: {
        companyId,
        name: 'Pricing List',
        slug: 'pricing-list',
        numberOfTracks: 5,
        numberOfCards: 96,
      },
    });
    listId = list.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  describe('company-level calculations', () => {
    it('saves the OnzeVibe calculation', async () => {
      const calc = JSON.stringify({ quantity: 250, soldBy: 'onzevibe' });
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/calculation`,
        headers,
        payload: { calculation: calc },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma().company.findUnique({ where: { id: companyId } });
      expect(row!.calculation).toBe(calc);
    });

    it('saves the Tromp calculation', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/calculation-tromp`,
        headers,
        payload: { calculationTromp: '{"quantity":100,"printingType":"eigen"}' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('saves the Schneider calculation', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/calculation-schneider`,
        headers,
        payload: {
          calculationSchneider: '{"quantity":50,"cardCount":96,"profitMargin":2}',
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('404s for an unknown company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/vibe/companies/999999/calculation',
        headers,
        payload: { calculation: '{}' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('400s for a non-numeric company id', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/vibe/companies/abc/calculation',
        headers,
        payload: { calculation: '{}' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('list-level calculations with fallback', () => {
    it('falls back to the company calculation when the list has none', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation?variant=onzevibe`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe('company');
      expect(JSON.parse(body.calculation).quantity).toBe(250);
      expect(body.numberOfCards).toBe(96);
    });

    it('saves a list-level calculation with order metrics', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation`,
        headers,
        payload: {
          calculation: '{"quantity":75}',
          numberOfBoxes: 75.4,
          buyPrice: 10.005,
          sellPrice: 19.999,
        },
      });
      expect(res.statusCode).toBe(200);
      const { list } = res.json();
      expect(list.numberOfBoxes).toBe(75);
      expect(list.buyPrice).toBe(10.01);
      expect(list.sellPrice).toBe(20);
    });

    it('prefers the list-level value once present', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation`,
        headers,
      });
      const body = res.json();
      expect(body.source).toBe('list');
      expect(JSON.parse(body.calculation).quantity).toBe(75);
    });

    it('returns empty when neither list nor company has the variant', async () => {
      await prisma().company.update({
        where: { id: companyId },
        data: { calculationTromp: null },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation?variant=tromp`,
        headers,
      });
      const body = res.json();
      expect(body.source).toBe('empty');
      expect(body.calculation).toBeNull();
    });

    it('rejects an invalid variant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation?variant=other`,
        headers,
      });
      expect(res.statusCode).toBe(400);
    });

    it('saves list-level tromp and schneider calculations', async () => {
      const tromp = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation-tromp`,
        headers,
        payload: { calculationTromp: '{"quantity":120}' },
      });
      expect(tromp.statusCode).toBe(200);
      const schneider = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation-schneider`,
        headers,
        payload: { calculationSchneider: '{"quantity":60,"cardCount":144}' },
      });
      expect(schneider.statusCode).toBe(200);
      const row = await prisma().companyList.findUnique({ where: { id: listId } });
      expect(row!.calculationTromp).toBe('{"quantity":120}');
      expect(row!.calculationSchneider).toBe('{"quantity":60,"cardCount":144}');
    });

    it('404s list calculations for the wrong company', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/999999/lists/${listId}/calculation`,
        headers,
        payload: { calculation: '{}' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('quotation HTML views', () => {
    it('renders the OnzeVibe quotation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/quotation/onzevibe/${companyId}/Q-2026-100`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Pricing Company BV');
    });

    it('renders the QRSong (Tromp) quotation using stored list calculation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/quotation/qrsong/${companyId}/Q-2026-101?listId=${listId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Q-2026-101');
    });

    it('renders the Schneider quotation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/quotation/schneider/${companyId}/Q-2026-102?isReseller=true`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('404s an unknown company', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/quotation/onzevibe/999999/Q-1',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('technical instructions and pricing views', () => {
    it('renders the technical instructions page', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/technical-instructions/${companyId}?printer=tromp`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('404s technical instructions for an unknown company', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/technical-instructions/999999',
      });
      expect(res.statusCode).toBe(404);
    });

    it('renders the reseller pricing tables', async () => {
      const profitMatrix = encodeURIComponent(
        JSON.stringify({ 'schneider-48': { 100: { reseller: 2, qrsong: 1 } } })
      );
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/reseller-pricing?profitMatrix=${profitMatrix}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('renders the retail pricing tables', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/retail-pricing',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('renders the vibe poster page', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/vibe/poster/some-poster-id',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  describe('quotation records and company deletion', () => {
    it('deletes a quotation', async () => {
      const quotation = await prisma().quotation.create({
        data: {
          quotationNumber: 'Q-DEL-1',
          companyId,
          variant: 'onzevibe',
          quantity: 10,
        },
      });
      const wrong = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/999999/quotations/${quotation.id}`,
        headers,
      });
      expect(wrong.statusCode).toBe(404);

      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${companyId}/quotations/${quotation.id}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const gone = await prisma().quotation.findUnique({
        where: { id: quotation.id },
      });
      expect(gone).toBeNull();
    });

    it('rejects finalize without a list id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/finalize',
        headers,
        payload: {},
      });
      expect(res.json().success).toBe(false);
    });

    it('deletes a company', async () => {
      const company = await prisma().company.create({
        data: { name: 'Doomed BV' },
      });
      const res = await app.inject({
        method: 'DELETE',
        url: `/vibe/companies/${company.id}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const gone = await prisma().company.findUnique({
        where: { id: company.id },
      });
      expect(gone).toBeNull();
    });

    it('404s deleting an unknown company', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/vibe/companies/999999',
        headers,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
