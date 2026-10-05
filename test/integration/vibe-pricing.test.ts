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
import { PriceListEdition, priceListQuery } from '../../src/priceList';
import { PROFIT_TIERS } from '../../src/services/boxOptionsPricing';

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
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation?variant=schneider`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe('company');
      expect(JSON.parse(body.calculation).quantity).toBe(50);
      expect(body.numberOfCards).toBe(96);
    });

    it('saves a list-level calculation with order metrics', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation-schneider`,
        headers,
        payload: {
          calculationSchneider: '{"quantity":75}',
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
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation?variant=schneider`,
        headers,
      });
      const body = res.json();
      expect(body.source).toBe('list');
      expect(JSON.parse(body.calculation).quantity).toBe(75);
    });

    it('has no OnzeVibe list calculation any more', async () => {
      // Lists are priced by Tromp or Schneider; the OnzeVibe calculator is gone.
      const read = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation?variant=onzevibe`,
        headers,
      });
      expect(read.statusCode).toBe(400);
      const noVariant = await app.inject({
        method: 'GET',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation`,
        headers,
      });
      expect(noVariant.statusCode).toBe(400);
      const write = await app.inject({
        method: 'PUT',
        url: `/vibe/companies/${companyId}/lists/${listId}/calculation`,
        headers,
        payload: { calculation: '{"quantity":75}' },
      });
      expect(write.statusCode).toBe(404);
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
        url: `/vibe/companies/999999/lists/${listId}/calculation-schneider`,
        headers,
        payload: { calculationSchneider: '{}' },
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

    it('applies 21% Dutch VAT when the company has no usable country', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/quotation/onzevibe/${companyId}/Q-2026-110`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('BTW 21%');
      expect(res.body).not.toContain('BTW verlegd');
    });

    it('reverse-charges VAT for an EU company (BTW verlegd)', async () => {
      await prisma().company.update({
        where: { id: companyId },
        data: { countrycode: 'DE' },
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/vibe/quotation/onzevibe/${companyId}/Q-2026-111`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('BTW verlegd (0%)');
        expect(res.body).toContain('artikel 138');
        expect(res.body).toContain('artikel 196');
        expect(res.body).not.toContain('BTW 21%');
        // The address block shows the localized country name, not the code
        expect(res.body).toContain('Duitsland');
      } finally {
        await prisma().company.update({
          where: { id: companyId },
          data: { countrycode: null },
        });
      }
    });

    it('normalizes legacy free-text countries (Duitsland → reverse charge)', async () => {
      await prisma().company.update({
        where: { id: companyId },
        data: { countrycode: 'Duitsland' },
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/vibe/quotation/qrsong/${companyId}/Q-2026-112?listId=${listId}`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('BTW verlegd (0%)');
      } finally {
        await prisma().company.update({
          where: { id: companyId },
          data: { countrycode: null },
        });
      }
    });

    it('shows the country name in the quotation language', async () => {
      await prisma().company.update({
        where: { id: companyId },
        data: { countrycode: 'DE' },
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/vibe/quotation/onzevibe/${companyId}/Q-2026-114?locale=de`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Deutschland');
      } finally {
        await prisma().company.update({
          where: { id: companyId },
          data: { countrycode: null },
        });
      }
    });

    it('charges 0% without reverse charge outside the EU', async () => {
      await prisma().company.update({
        where: { id: companyId },
        data: { countrycode: 'US' },
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/vibe/quotation/onzevibe/${companyId}/Q-2026-113`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('BTW 0%');
        expect(res.body).not.toContain('BTW verlegd');
        expect(res.body).not.toContain('BTW 21%');
      } finally {
        await prisma().company.update({
          where: { id: companyId },
          data: { countrycode: null },
        });
      }
    });

    it('renders the quotation in the language from the query string', async () => {
      // This is the URL the PDF Lambda fetches, so the ?locale it carries is
      // what decides the language of the customer's quotation.
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/quotation/qrsong/${companyId}/Q-2026-103?locale=de`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('lang="de"');
      expect(res.body).toContain('Angebotsnummer');
      expect(res.body).toContain('Gültig bis');
      expect(res.body).toContain('USt-IdNr.');
      // German business convention puts the euro sign after the amount.
      expect(res.body).toMatch(/\d,\d{2}\s*€/);
      expect(res.body).not.toContain('Offerte');
    });

    it('falls back to the company language when the query string omits it', async () => {
      await prisma().company.update({
        where: { id: companyId },
        data: { locale: 'de' },
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/vibe/quotation/qrsong/${companyId}/Q-2026-104`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('lang="de"');
        expect(res.body).toContain('Angebot');
      } finally {
        await prisma().company.update({
          where: { id: companyId },
          data: { locale: 'nl' },
        });
      }
    });

    it('translates the Schneider product description, not just the chrome', async () => {
      // Regression: the Schneider branch builds its own product description in
      // the route, and was still emitting Dutch on a German quotation.
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/quotation/schneider/${companyId}/Q-2026-107?locale=de`,
      });
      expect(res.statusCode).toBe(200);
      // The card count depends on whatever calculation an earlier test stored,
      // so assert on the language rather than a specific size.
      expect(res.body).toMatch(/QRSong! Box - \d+ Karten/);
      expect(res.body).toMatch(/Schachtel mit \d+ Fach|Luxusschachtel mit \d+ Fächern/);
      expect(res.body).not.toContain('vakje');
      expect(res.body).not.toContain('kaarten');
      expect(res.body).not.toContain('Doos met');
    });

    it('falls back to English for a language we do not write quotations in', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/quotation/qrsong/${companyId}/Q-2026-105?locale=fr`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('lang="en"');
      expect(res.body).toContain('Valid until');
    });

    it('still renders Dutch, unchanged, for a Dutch company', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/quotation/qrsong/${companyId}/Q-2026-106?locale=nl`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('lang="nl"');
      expect(res.body).toContain('Geldig tot');
      expect(res.body).toContain('Algemene Voorwaarden');
      expect(res.body).toContain('KVK');
    });
  });

  describe('technical instructions HTML view', () => {
    it('renders in the language from the query string', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/technical-instructions/${companyId}?printer=tromp&locale=de`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('lang="de"');
      expect(res.body).toContain('Technische Anweisungen');
      // Formal register: never the informal du form.
      expect(res.body).not.toMatch(/\bdu\b/i);
      // Printer-specific branching must survive translation.
      expect(res.body).toContain('60x60mm');
    });

    it('keeps the schneider card size when translated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/technical-instructions/${companyId}?printer=schneider&locale=de`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('56x56mm');
    });

    it('falls back to English for an unsupported language', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/vibe/technical-instructions/${companyId}?locale=jp`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('lang="en"');
      expect(res.body).toContain('Technical Instructions');
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

    // The price-list views only render from a URL the PDF route signed
    // (priceListQuery); every tier needs a margin of ours.
    const priceListMatrix = () => {
      const m: Record<string, Record<string, { qrsong: number; reseller: number }>> = {};
      for (const id of ['schneider-48', 'schneider-96', 'schneider-192']) {
        m[id] = {};
        for (const q of PROFIT_TIERS) m[id][String(q)] = { qrsong: 25, reseller: 30 };
      }
      return m;
    };
    const priceListUrl = (edition: PriceListEdition, locale: string) =>
      `/vibe/${edition}-pricing?${priceListQuery(edition, locale, priceListMatrix())}`;

    it('refuses to render a price list without a valid signature', async () => {
      // Without the signature anyone could render it with an empty matrix
      // and read the printer's cost per box.
      const unsigned = await app.inject({ method: 'GET', url: '/vibe/retail-pricing' });
      expect(unsigned.statusCode).toBe(403);

      const signed = new URLSearchParams(priceListQuery('retail', 'nl', priceListMatrix()));
      signed.set('profitMatrix', JSON.stringify({ 'schneider-48': {} }));
      const tampered = await app.inject({
        method: 'GET',
        url: `/vibe/retail-pricing?${signed.toString()}`,
      });
      expect(tampered.statusCode).toBe(403);
    });

    it('renders the reseller edition in German, formal and with purchase prices', async () => {
      const res = await app.inject({ method: 'GET', url: priceListUrl('reseller', 'de') });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('lang="de"');
      expect(res.body).toContain('Händlerausgabe');
      expect(res.body).toContain('QRSong! für Unternehmen');
      expect(res.body).toContain('48 Karten');
      expect(res.body).toContain('class="b-buy"');
      expect(res.body).toContain('business@qrsong.io');
      // Formal register only.
      expect(res.body).not.toMatch(/>\s*Inkoop\s*</);
    });

    it('renders the retail edition with recommended prices only', async () => {
      const res = await app.inject({ method: 'GET', url: priceListUrl('retail', 'nl') });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('lang="nl"');
      expect(res.body).toContain('Prijslijst');
      expect(res.body).toContain('48 kaarten');
      expect(res.body).toContain('zakelijk@qrsong.io');
      expect(res.body).not.toContain('class="b-buy"');
    });

    it('leaves every price and our contact details out of the client brochure', async () => {
      const res = await app.inject({ method: 'GET', url: priceListUrl('client', 'nl') });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('powered by');
      expect(res.body).toContain('Brochure');
      expect(res.body).not.toContain('€');
      expect(res.body).not.toContain('pricing-table');
      expect(res.body).not.toContain('zakelijk@qrsong.io');
      expect(res.body).not.toContain('business@qrsong.io');
      expect(res.body).not.toContain('www.qrsong.io');
    });

    it('falls back to English for a language we do not produce price lists in', async () => {
      const res = await app.inject({ method: 'GET', url: priceListUrl('retail', 'fr') });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('lang="en"');
      expect(res.body).toContain('Price per box');
    });

    it('refuses a price list PDF while the profit table is empty', async () => {
      // The PDF routes fall back to the saved table, which the test Redis
      // does not have: a clear 400 instead of a list at the printer's cost.
      const res = await app.inject({
        method: 'POST',
        url: '/vibe/retail-pricing/pdf',
        headers,
        payload: { locale: 'nl' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('profit table');
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
