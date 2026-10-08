/**
 * Unit tests for src/business.ts — company/list admin CRUD, production list
 * overview, the Dutch printer order e-mail builder, quotation PDF fetch
 * and the processAndSaveImage helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { h, resetAll, TEST_LOCALES } from './business-mocks';

vi.mock('../../../src/prisma', async () => (await import('./business-mocks')).prismaModule());
vi.mock('../../../src/cache', async () => (await import('./business-mocks')).cacheModule());
vi.mock('../../../src/utils', async () => (await import('./business-mocks')).utilsModule());
vi.mock('../../../src/auth', async () => (await import('./business-mocks')).authModule());
vi.mock('../../../src/mollie', async () => (await import('./business-mocks')).mollieModule());
vi.mock('../../../src/discount', async () => (await import('./business-mocks')).discountModule());
vi.mock('../../../src/data', async () => (await import('./business-mocks')).dataModule());
vi.mock('../../../src/spotify', async () => (await import('./business-mocks')).spotifyModule());
vi.mock('../../../src/generator', async () => (await import('./business-mocks')).generatorModule());
vi.mock('../../../src/translation', async () => (await import('./business-mocks')).translationModule());
vi.mock('../../../src/logger', async () => (await import('./business-mocks')).loggerModule());
vi.mock('sharp', async () => (await import('./business-mocks')).sharpModule());
vi.mock('fs/promises', async () => (await import('./business-mocks')).fsModule());

import Business from '../../../src/business';

const business = Business.getInstance();

beforeEach(() => {
  resetAll();
});

describe('updateCompany', () => {
  it('requires a company id and an existing company', async () => {
    expect(await business.updateCompany(0, {})).toMatchObject({
      success: false,
      error: 'No company ID provided',
    });
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await business.updateCompany(1, {})).toMatchObject({
      success: false,
      error: 'Company not found',
    });
  });

  it('whitelists fields and bumps new lists to company status', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1 });
    h.prisma.company.update.mockResolvedValue({ id: 1, name: 'Renamed' });
    h.prisma.companyList.updateMany.mockResolvedValue({ count: 1 });

    const res = await business.updateCompany(1, {
      name: 'Renamed',
      followUp: true,
      excludeFromMailing: true,
      evilField: 'drop me',
      test: true,
      id: 666,
      address: 'Street',
    });
    expect(res.success).toBe(true);
    expect(res.data.company.name).toBe('Renamed');
    expect(h.prisma.company.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: 'Renamed', followUp: true, excludeFromMailing: true, address: 'Street' },
    });
    expect(h.prisma.companyList.updateMany).toHaveBeenCalledWith({
      where: { companyId: 1, status: 'new' },
      data: { status: 'company' },
    });
  });

  it('maps prisma errors', async () => {
    h.prisma.company.findUnique.mockRejectedValue(new Error('x'));
    expect(await business.updateCompany(1, {})).toMatchObject({
      success: false,
      error: 'Error updating company',
    });
  });
});

describe('getCompanyLists / getAllCompanies', () => {
  it('getCompanyLists validates and fetches lists newest-first', async () => {
    expect(await business.getCompanyLists(0)).toMatchObject({ success: false });
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await business.getCompanyLists(1)).toMatchObject({
      success: false,
      error: 'Company not found',
    });

    h.prisma.company.findUnique.mockResolvedValue({ id: 1 });
    const lists = [{ id: 9 }];
    h.prisma.companyList.findMany.mockResolvedValue(lists);
    const res = await business.getCompanyLists(1);
    expect(res).toEqual({ success: true, data: { companyLists: lists } });
    expect(h.prisma.companyList.findMany).toHaveBeenCalledWith({
      where: { companyId: 1 },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('getAllCompanies hides admin-only companies from non-admins', async () => {
    h.prisma.company.findMany.mockResolvedValue([]);
    await business.getAllCompanies(['companyadmin']);
    expect(h.prisma.company.findMany.mock.calls[0][0].where).toEqual({
      onlyForAdmin: false,
    });
    await business.getAllCompanies(['admin']);
    expect(h.prisma.company.findMany.mock.calls[1][0].where).toEqual({});
  });

  it('getAllCompanies flattens the list count', async () => {
    h.prisma.company.findMany.mockResolvedValue([
      { id: 1, name: 'A', _count: { CompanyList: 3 } },
    ]);
    const res = await business.getAllCompanies(['admin']);
    expect(res.success).toBe(true);
    expect(res.data.companies[0]).toMatchObject({
      id: 1,
      numberOfLists: 3,
    });
    expect(res.data.companies[0]._count).toBeUndefined();
  });

  it('getAllCompanies maps errors', async () => {
    h.prisma.company.findMany.mockRejectedValue(new Error('x'));
    expect(await business.getAllCompanies()).toMatchObject({
      success: false,
      error: 'Error retrieving companies',
    });
  });
});

describe('deleteCompany', () => {
  it('validates the id and existence', async () => {
    expect(await business.deleteCompany(NaN)).toMatchObject({
      success: false,
      error: 'Invalid company ID provided',
    });
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await business.deleteCompany(1)).toMatchObject({
      success: false,
      error: 'Company not found',
    });
  });

  it('refuses to delete companies that still have lists', async () => {
    h.prisma.company.findUnique.mockResolvedValue({
      id: 1,
      name: 'A',
      _count: { CompanyList: 2 },
    });
    expect(await business.deleteCompany(1)).toMatchObject({
      success: false,
      error: 'Company cannot be deleted because it has associated lists',
    });
    expect(h.prisma.company.delete).not.toHaveBeenCalled();
  });

  it('deletes a list-less company', async () => {
    h.prisma.company.findUnique.mockResolvedValue({
      id: 1,
      name: 'A',
      _count: { CompanyList: 0 },
    });
    h.prisma.company.delete.mockResolvedValue({});
    expect(await business.deleteCompany(1)).toEqual({ success: true });
    expect(h.prisma.company.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});

describe('createCompanyList', () => {
  const valid = {
    name: 'Lijst',
    slug: 'lijst',
    numberOfCards: 100,
    numberOfTracks: 5,
  };

  it('validates ids, required fields and numeric ranges', async () => {
    expect(await business.createCompanyList(NaN, valid)).toMatchObject({
      success: false,
      error: 'Ongeldig bedrijfs-ID opgegeven',
    });
    expect(
      await business.createCompanyList(1, { ...valid, name: '' })
    ).toMatchObject({
      success: false,
      error: 'Verplichte velden voor de bedrijfslijst ontbreken',
    });
    expect(
      await business.createCompanyList(1, { ...valid, numberOfCards: -1 })
    ).toMatchObject({
      success: false,
      error: 'Ongeldig aantal voor kaarten of nummers',
    });
  });

  it('requires an existing company and a globally unique slug', async () => {
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await business.createCompanyList(1, valid)).toMatchObject({
      success: false,
      error: 'Bedrijf niet gevonden',
    });

    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'A' });
    h.prisma.companyList.findFirst.mockResolvedValue({ id: 2, slug: 'lijst' });
    expect(await business.createCompanyList(1, valid)).toMatchObject({
      success: false,
      error: 'Slug bestaat al. Kies een unieke slug.',
    });
  });

  it('creates the list with per-locale descriptions and defaults', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'A' });
    h.prisma.companyList.findFirst.mockResolvedValue(null);
    h.prisma.companyList.create.mockImplementation(async ({ data }: any) => ({
      id: 50,
      ...data,
    }));

    const res = await business.createCompanyList(1, {
      ...valid,
      description_en: 'Hello',
      description_nl: 'Hallo',
      // description_de intentionally omitted
      playlistSource: 'spotify',
      playlistUrl: 'https://sp/x',
      qrvote: true,
    } as any);
    expect(res.success).toBe(true);

    const data = h.prisma.companyList.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      companyId: 1,
      name: 'Lijst',
      slug: 'lijst',
      description_en: 'Hello',
      description_nl: 'Hallo',
      playlistSource: 'spotify',
      playlistUrl: 'https://sp/x',
      status: 'new',
      qrvote: true,
    });
    expect('description_de' in data).toBe(false);
  });

  it('defaults playlistSource to own and playlistUrl to null', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'A' });
    h.prisma.companyList.findFirst.mockResolvedValue(null);
    h.prisma.companyList.create.mockImplementation(async ({ data }: any) => data);
    await business.createCompanyList(1, valid);
    expect(h.prisma.companyList.create.mock.calls[0][0].data).toMatchObject({
      playlistSource: 'own',
      playlistUrl: null,
      qrvote: false,
    });
  });

  it('translates a P2002 slug constraint into the friendly slug error', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'A' });
    h.prisma.companyList.findFirst.mockResolvedValue(null);
    h.prisma.companyList.create.mockRejectedValue(
      Object.assign(new Error('unique'), {
        code: 'P2002',
        meta: { target: ['slug'] },
      })
    );
    expect(await business.createCompanyList(1, valid)).toMatchObject({
      success: false,
      error: 'Slug bestaat al. Kies een unieke slug.',
    });
  });

  it('maps other prisma failures to a generic Dutch error', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'A' });
    h.prisma.companyList.findFirst.mockResolvedValue(null);
    h.prisma.companyList.create.mockRejectedValue(new Error('db'));
    expect(await business.createCompanyList(1, valid)).toMatchObject({
      success: false,
      error: 'Fout bij het aanmaken van de bedrijfslijst',
    });
  });
});

describe('deleteCompanyList', () => {
  it('validates ids, ownership and status', async () => {
    expect(await business.deleteCompanyList(NaN, 1)).toMatchObject({ success: false });
    expect(await business.deleteCompanyList(1, NaN)).toMatchObject({ success: false });

    h.prisma.companyList.findUnique.mockResolvedValueOnce(null);
    expect(await business.deleteCompanyList(1, 2)).toMatchObject({
      success: false,
      error: 'Company list not found',
    });

    h.prisma.companyList.findUnique.mockResolvedValueOnce({
      id: 2,
      companyId: 9,
      status: 'new',
    });
    expect(await business.deleteCompanyList(1, 2)).toMatchObject({
      success: false,
      error: 'List does not belong to this company',
    });
    expect(h.prisma.companyList.delete).not.toHaveBeenCalled();
  });

  // The admin no longer has list statuses, so none of them blocks a delete.
  for (const status of ['new', 'production', 'submitted']) {
    it(`deletes a list belonging to the company with status "${status}"`, async () => {
      h.prisma.companyList.findUnique.mockResolvedValue({
        id: 2,
        companyId: 1,
        name: 'L',
        status,
      });
      h.prisma.companyList.delete.mockResolvedValue({});
      expect(await business.deleteCompanyList(1, 2)).toEqual({ success: true });
      expect(h.prisma.companyList.delete).toHaveBeenCalledWith({ where: { id: 2 } });
    });
  }
});

describe('getOrderEmail', () => {
  function baseList(over: Record<string, any> = {}) {
    return {
      id: 2,
      companyId: 1,
      name: 'Feest',
      printer: 'schneider',
      numberOfCards: 96,
      desiredDeliveryDate: new Date('2026-03-05T12:00:00Z'),
      calculationSchneider: JSON.stringify({ quantity: 5, cardCount: 144 }),
      Company: {
        id: 1,
        name: 'Acme & Zn',
        deliveryName: 'Magazijn & Co',
        deliveryAddress: 'Straatweg',
        deliveryHousenumber: '1',
        deliveryZipcode: '1234AB',
        deliveryCity: 'Stad',
        deliveryCountrycode: 'NL',
      },
      CompanyFile: [
        { id: 31, originalName: 'cards.pdf' },
        { id: 32, originalName: 'box.pdf' },
      ],
      ...over,
    };
  }

  it('rejects unknown lists or other companies', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    expect(await business.getOrderEmail(1, 2)).toMatchObject({
      success: false,
      error: 'List not found',
    });
    h.prisma.companyList.findUnique.mockResolvedValue(baseList({ companyId: 99 }));
    expect(await business.getOrderEmail(1, 2)).toMatchObject({
      success: false,
      error: 'List not found',
    });
  });

  it('delivers to the company delivery address by default', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({
        Company: {
          id: 1,
          name: 'By Acte',
          deliveryName: 'Sandra Kusters',
          deliveryAddress: 'Ambachtweg',
          deliveryHousenumber: '73',
          deliveryZipcode: '5731 AE',
          deliveryCity: 'Mierlo',
          deliveryCountrycode: 'NL',
          deliveryPhone: '040 20 60 100',
        },
      })
    );
    const d = (await business.getOrderEmail(1, 2)).data;
    expect(d.warnings).toEqual([]);
    expect(d.addressCount).toBe(2);
    expect(d.text).toContain('Adres 1: 5 stuks');
    expect(d.text).toContain('By Acte\nt.a.v. Sandra Kusters\nAmbachtweg 73\n5731 AE Mierlo\nTel. 040 20 60 100');
  });

  it('uses the list\'s own delivery address when the default is switched off', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({
        useCompanyDeliveryAddress: false,
        deliveryName: 'Receptie',
        deliveryAddress: 'Hoofdstraat',
        deliveryHousenumber: '1',
        deliveryZipcode: '2000',
        deliveryCity: 'Antwerpen',
        deliveryCountrycode: 'BE',
        Company: { id: 1, name: 'Van Haren', deliveryAddress: 'Elders', deliveryCity: 'Utrecht' },
      })
    );
    const d = (await business.getOrderEmail(1, 2)).data;
    expect(d.text).toContain('Van Haren\nt.a.v. Receptie\nHoofdstraat 1\n2000 Antwerpen\nBE');
    expect(d.text).not.toContain('Utrecht');
  });

  it('asks for delivery as soon as possible when the list says z.s.m.', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({ deliveryAsap: true, desiredDeliveryDate: null })
    );
    const d = (await business.getOrderEmail(1, 2)).data;
    expect(d.warnings).toEqual([]);
    expect(d.text).toContain('De wens is dat het zo snel mogelijk (z.s.m.) geleverd wordt.');
    expect(d.html).toContain('<strong>zo snel mogelijk (z.s.m.)</strong>');
    expect(d.text).not.toContain('[LEVERDATUM]');
  });

  it('builds a complete Schneider order mail without warnings', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(baseList());
    const res = await business.getOrderEmail(1, 2);
    expect(res.success).toBe(true);
    const d = res.data;

    expect(d.subject).toBe('Order Acme & Zn');
    expect(d.totalBoxes).toBe(5);
    expect(d.warnings).toEqual([]);

    // Schneider product description from the cardCount lookup
    expect(d.text).toContain('144 kaarten (2x 72 in banderol)');
    expect(d.text).toContain('2-vaks dekseldoosje');

    // Dutch date
    expect(d.text).toContain('uiterlijk 5 maart 2026 geleverd');

    // Addresses: the client's gets all boxes, QRSong! appended with 3
    expect(d.addressCount).toBe(2);
    expect(d.text).toContain('op twee verschillende adressen');
    expect(d.text).toContain('Adres 1: 5 stuks');
    expect(d.text).toContain('Adres 2: 3 stuks');
    expect(d.text).toContain('Rick Groenewegen\nPrinsenhof 1');
    expect(d.text).toContain('Acme & Zn\nt.a.v. Magazijn & Co\nStraatweg 1\n1234AB Stad');

    // HTML escapes ampersands
    expect(d.html).toContain('Magazijn &amp; Co');
    expect(d.files).toEqual([
      { id: 31, originalName: 'cards.pdf' },
      { id: 32, originalName: 'box.pdf' },
    ]);
    expect(h.prisma.companyList.findUnique.mock.calls[0][0].include.CompanyFile).toEqual({
      where: { category: 'design' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('falls back to the 96-card spec for unknown Schneider card counts', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({ calculationSchneider: JSON.stringify({ quantity: 5, cardCount: 60 }) })
    );
    const res = await business.getOrderEmail(1, 2);
    expect(res.data.text).toContain('60 kaarten (2x 48 in banderol)');
  });

  it('uses the Tromp description for qrsong lists (luxe)', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({
        printer: 'qrsong',
        calculationTromp: JSON.stringify({ quantity: 8, printingType: 'luxe' }),
      })
    );
    const res = await business.getOrderEmail(1, 2);
    expect(res.data.totalBoxes).toBe(8);
    expect(res.data.text).toContain('luxe doos met 200 kaarten + bedrukte chips');
  });

  it('collects warnings for missing quantity, date, addresses and files', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({
        printer: null,
        calculationSchneider: null,
        desiredDeliveryDate: null,
        Company: { id: 1, name: 'Acme & Zn' },
        CompanyFile: [],
        numberOfCards: 200,
      })
    );
    const res = await business.getOrderEmail(1, 2);
    expect(res.success).toBe(true);
    const d = res.data;

    expect(d.totalBoxes).toBe(0);
    expect(d.text).toContain('totaal [AANTAL] x');
    expect(d.text).toContain('uiterlijk [LEVERDATUM]');
    // Only the QRSong! fallback address remains
    expect(d.addressCount).toBe(1);
    expect(d.text).toContain('op één verschillende adressen');

    // A list without a printer is ordered as Schneider, the default.
    expect(d.text).toContain('dekseldoosje');
    expect(d.warnings).toEqual([
      expect.stringContaining('Geen aantal dozen gevonden'),
      expect.stringContaining('Geen gewenste leverdatum'),
      expect.stringContaining('Geen leveradres bij deze lijst'),
      expect.stringContaining('nog geen ontwerpen bij deze lijst'),
    ]);
  });

  it('maps errors', async () => {
    h.prisma.companyList.findUnique.mockRejectedValue(new Error('x'));
    expect(await business.getOrderEmail(1, 2)).toMatchObject({
      success: false,
      error: 'Error building order email',
    });
  });
});

describe('getQuotationPDF', () => {
  function arrangeQuotation(locale = 'nl') {
    h.prisma.quotation.findUnique.mockResolvedValue({
      id: 4,
      companyId: 1,
      quotationNumber: 'QRS12345678',
      locale,
    });
    h.prisma.company.findMany.mockResolvedValue([
      { id: 1, name: 'Acme Co!', _count: { CompanyList: 0 } },
    ]);
  }

  it('forbids companyadmins from fetching other companies', async () => {
    const res = await business.getQuotationPDF(1, 4, ['companyadmin'], 2);
    expect(res).toMatchObject({ success: false, error: 'Forbidden' });
    expect(h.prisma.quotation.findUnique).not.toHaveBeenCalled();
  });

  it('rejects unknown quotations and company mismatches', async () => {
    h.prisma.quotation.findUnique.mockResolvedValueOnce(null);
    expect(await business.getQuotationPDF(1, 4, ['admin'])).toMatchObject({
      success: false,
      error: 'Quotation not found',
    });
    h.prisma.quotation.findUnique.mockResolvedValueOnce({ id: 4, companyId: 9 });
    expect(await business.getQuotationPDF(1, 4, ['admin'])).toMatchObject({
      success: false,
      error: 'Quotation not found',
    });
  });

  it('reports a missing archived PDF', async () => {
    arrangeQuotation();
    h.fs.access.mockRejectedValue(new Error('ENOENT'));
    expect(await business.getQuotationPDF(1, 4, ['admin'])).toMatchObject({
      success: false,
      error: 'Archived PDF not found',
    });
  });

  it('names the re-download after the language the quotation was issued in', async () => {
    // The archived PDF cannot change, so the filename must follow the stored
    // quotation locale rather than the company's current one.
    arrangeQuotation('de');
    h.fs.access.mockResolvedValue(undefined);
    h.fs.readFile.mockResolvedValue(Buffer.from('%PDF-fake'));

    const res = await business.getQuotationPDF(1, 4, ['admin']);
    expect(res.filename).toBe('Angebot_Acme_Co__QRS12345678.pdf');
  });

  it('streams the archived PDF with a sanitized filename', async () => {
    arrangeQuotation();
    h.fs.access.mockResolvedValue(undefined);
    const pdf = Buffer.from('%PDF-fake');
    h.fs.readFile.mockResolvedValue(pdf);

    const res = await business.getQuotationPDF(1, 4, ['companyadmin'], 1);
    expect(res.success).toBe(true);
    expect(res.data).toBe(pdf);
    expect(res.filename).toBe('Offerte_Acme_Co__QRS12345678.pdf');
    expect(h.fs.readFile).toHaveBeenCalledWith(
      `${process.env['PRIVATE_DIR']}/quotation/QRS12345678.pdf`
    );
  });
});

describe('generateQuotationPDF — guard branches', () => {
  it('forbids companyadmins from generating for other companies', async () => {
    const res = await business.generateQuotationPDF(1, 9, ['companyadmin'], 2);
    expect(res).toMatchObject({
      success: false,
      error: 'Forbidden: You can only generate quotations for your own company',
    });
  });

  it('fails cleanly when companies cannot be fetched', async () => {
    h.prisma.company.findMany.mockRejectedValue(new Error('db'));
    expect(await business.generateQuotationPDF(1, 9, ['admin'])).toMatchObject({
      success: false,
      error: 'Failed to fetch companies',
    });
  });

  it('fails when the company does not exist', async () => {
    h.prisma.company.findMany.mockResolvedValue([
      { id: 2, name: 'Other', _count: { CompanyList: 0 } },
    ]);
    expect(await business.generateQuotationPDF(1, 9, ['admin'])).toMatchObject({
      success: false,
      error: 'Company not found',
    });
  });
});

describe('processAndSaveImage (private)', () => {
  const anyBusiness = business as any;

  it('returns null when no file part is provided', async () => {
    expect(await anyBusiness.processAndSaveImage(null, 5, 'background')).toBeNull();
    expect(
      await anyBusiness.processAndSaveImage({ filename: '' }, 5, 'background')
    ).toBeNull();
    expect(h.fs.writeFile).not.toHaveBeenCalled();
  });

  it('persists the upload under a unique type/list-scoped name', async () => {
    h.fs.mkdir.mockResolvedValue(undefined);
    h.fs.writeFile.mockResolvedValue(undefined);
    const part = {
      filename: 'Logo.JPG',
      toBuffer: vi.fn(async () => Buffer.from('img')),
    };
    const name = await anyBusiness.processAndSaveImage(part, 5, 'votingLogo');
    expect(name).toBe('card_votingLogo_5_RANDOM32.jpg');
    expect(h.fs.mkdir).toHaveBeenCalledWith(
      path.join(process.env['PUBLIC_DIR'] as string, 'companydata', 'backgrounds'),
      { recursive: true }
    );
    expect(h.fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('card_votingLogo_5_RANDOM32.jpg'),
      Buffer.from('img')
    );
  });

  it('returns null when reading the upload fails', async () => {
    h.fs.mkdir.mockResolvedValue(undefined);
    const part = {
      filename: 'x.png',
      toBuffer: vi.fn(async () => {
        throw new Error('stream broke');
      }),
    };
    expect(await anyBusiness.processAndSaveImage(part, 5, 'background')).toBeNull();
  });
});
