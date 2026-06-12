/**
 * Unit tests for src/vibe.ts — company/list admin CRUD, production list
 * overview, the Dutch printer order e-mail builder, quotation PDF fetch
 * and the processAndSaveImage helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { h, resetAll, TEST_LOCALES } from './vibe-mocks';

vi.mock('../../../src/prisma', async () => (await import('./vibe-mocks')).prismaModule());
vi.mock('../../../src/cache', async () => (await import('./vibe-mocks')).cacheModule());
vi.mock('../../../src/utils', async () => (await import('./vibe-mocks')).utilsModule());
vi.mock('../../../src/auth', async () => (await import('./vibe-mocks')).authModule());
vi.mock('../../../src/mollie', async () => (await import('./vibe-mocks')).mollieModule());
vi.mock('../../../src/discount', async () => (await import('./vibe-mocks')).discountModule());
vi.mock('../../../src/data', async () => (await import('./vibe-mocks')).dataModule());
vi.mock('../../../src/spotify', async () => (await import('./vibe-mocks')).spotifyModule());
vi.mock('../../../src/generator', async () => (await import('./vibe-mocks')).generatorModule());
vi.mock('../../../src/translation', async () => (await import('./vibe-mocks')).translationModule());
vi.mock('../../../src/logger', async () => (await import('./vibe-mocks')).loggerModule());
vi.mock('sharp', async () => (await import('./vibe-mocks')).sharpModule());
vi.mock('fs/promises', async () => (await import('./vibe-mocks')).fsModule());

import Vibe from '../../../src/vibe';

const vibe = Vibe.getInstance();

beforeEach(() => {
  resetAll();
});

describe('updateCompany', () => {
  it('requires a company id and an existing company', async () => {
    expect(await vibe.updateCompany(0, {})).toMatchObject({
      success: false,
      error: 'No company ID provided',
    });
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await vibe.updateCompany(1, {})).toMatchObject({
      success: false,
      error: 'Company not found',
    });
  });

  it('whitelists fields and bumps new lists to company status', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1 });
    h.prisma.company.update.mockResolvedValue({ id: 1, name: 'Renamed' });
    h.prisma.companyList.updateMany.mockResolvedValue({ count: 1 });

    const res = await vibe.updateCompany(1, {
      name: 'Renamed',
      test: true,
      evilField: 'drop me',
      id: 666,
      address: 'Street',
    });
    expect(res.success).toBe(true);
    expect(res.data.company.name).toBe('Renamed');
    expect(h.prisma.company.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: 'Renamed', test: true, address: 'Street' },
    });
    expect(h.prisma.companyList.updateMany).toHaveBeenCalledWith({
      where: { companyId: 1, status: 'new' },
      data: { status: 'company' },
    });
  });

  it('maps prisma errors', async () => {
    h.prisma.company.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.updateCompany(1, {})).toMatchObject({
      success: false,
      error: 'Error updating company',
    });
  });
});

describe('getCompanyLists / getAllCompanies', () => {
  it('getCompanyLists validates and fetches lists newest-first', async () => {
    expect(await vibe.getCompanyLists(0)).toMatchObject({ success: false });
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await vibe.getCompanyLists(1)).toMatchObject({
      success: false,
      error: 'Company not found',
    });

    h.prisma.company.findUnique.mockResolvedValue({ id: 1 });
    const lists = [{ id: 9 }];
    h.prisma.companyList.findMany.mockResolvedValue(lists);
    const res = await vibe.getCompanyLists(1);
    expect(res).toEqual({ success: true, data: { companyLists: lists } });
    expect(h.prisma.companyList.findMany).toHaveBeenCalledWith({
      where: { companyId: 1 },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('getAllCompanies hides admin-only companies from non-admins', async () => {
    h.prisma.company.findMany.mockResolvedValue([]);
    await vibe.getAllCompanies(['companyadmin']);
    expect(h.prisma.company.findMany.mock.calls[0][0].where).toEqual({
      onlyForAdmin: false,
    });
    await vibe.getAllCompanies(['admin']);
    expect(h.prisma.company.findMany.mock.calls[1][0].where).toEqual({});
  });

  it('getAllCompanies flattens the list count', async () => {
    h.prisma.company.findMany.mockResolvedValue([
      { id: 1, name: 'A', test: false, _count: { CompanyList: 3 } },
    ]);
    const res = await vibe.getAllCompanies(['admin']);
    expect(res.success).toBe(true);
    expect(res.data.companies[0]).toMatchObject({
      id: 1,
      numberOfLists: 3,
      test: false,
    });
    expect(res.data.companies[0]._count).toBeUndefined();
  });

  it('getAllCompanies maps errors', async () => {
    h.prisma.company.findMany.mockRejectedValue(new Error('x'));
    expect(await vibe.getAllCompanies()).toMatchObject({
      success: false,
      error: 'Error retrieving companies',
    });
  });
});

describe('deleteCompany', () => {
  it('validates the id and existence', async () => {
    expect(await vibe.deleteCompany(NaN)).toMatchObject({
      success: false,
      error: 'Invalid company ID provided',
    });
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await vibe.deleteCompany(1)).toMatchObject({
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
    expect(await vibe.deleteCompany(1)).toMatchObject({
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
    expect(await vibe.deleteCompany(1)).toEqual({ success: true });
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
    expect(await vibe.createCompanyList(NaN, valid)).toMatchObject({
      success: false,
      error: 'Ongeldig bedrijfs-ID opgegeven',
    });
    expect(
      await vibe.createCompanyList(1, { ...valid, name: '' })
    ).toMatchObject({
      success: false,
      error: 'Verplichte velden voor de bedrijfslijst ontbreken',
    });
    expect(
      await vibe.createCompanyList(1, { ...valid, numberOfCards: -1 })
    ).toMatchObject({
      success: false,
      error: 'Ongeldig aantal voor kaarten of nummers',
    });
  });

  it('requires an existing company and a globally unique slug', async () => {
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await vibe.createCompanyList(1, valid)).toMatchObject({
      success: false,
      error: 'Bedrijf niet gevonden',
    });

    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'A' });
    h.prisma.companyList.findFirst.mockResolvedValue({ id: 2, slug: 'lijst' });
    expect(await vibe.createCompanyList(1, valid)).toMatchObject({
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

    const res = await vibe.createCompanyList(1, {
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

  it('defaults playlistSource to voting and playlistUrl to null', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'A' });
    h.prisma.companyList.findFirst.mockResolvedValue(null);
    h.prisma.companyList.create.mockImplementation(async ({ data }: any) => data);
    await vibe.createCompanyList(1, valid);
    expect(h.prisma.companyList.create.mock.calls[0][0].data).toMatchObject({
      playlistSource: 'voting',
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
    expect(await vibe.createCompanyList(1, valid)).toMatchObject({
      success: false,
      error: 'Slug bestaat al. Kies een unieke slug.',
    });
  });

  it('maps other prisma failures to a generic Dutch error', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'A' });
    h.prisma.companyList.findFirst.mockResolvedValue(null);
    h.prisma.companyList.create.mockRejectedValue(new Error('db'));
    expect(await vibe.createCompanyList(1, valid)).toMatchObject({
      success: false,
      error: 'Fout bij het aanmaken van de bedrijfslijst',
    });
  });
});

describe('deleteCompanyList', () => {
  it('validates ids, ownership and status', async () => {
    expect(await vibe.deleteCompanyList(NaN, 1)).toMatchObject({ success: false });
    expect(await vibe.deleteCompanyList(1, NaN)).toMatchObject({ success: false });

    h.prisma.companyList.findUnique.mockResolvedValueOnce(null);
    expect(await vibe.deleteCompanyList(1, 2)).toMatchObject({
      success: false,
      error: 'Company list not found',
    });

    h.prisma.companyList.findUnique.mockResolvedValueOnce({
      id: 2,
      companyId: 9,
      status: 'new',
    });
    expect(await vibe.deleteCompanyList(1, 2)).toMatchObject({
      success: false,
      error: 'List does not belong to this company',
    });

    h.prisma.companyList.findUnique.mockResolvedValueOnce({
      id: 2,
      companyId: 1,
      status: 'production',
    });
    expect(await vibe.deleteCompanyList(1, 2)).toMatchObject({
      success: false,
      error: 'List cannot be deleted because its status is not "new"',
    });
    expect(h.prisma.companyList.delete).not.toHaveBeenCalled();
  });

  it('deletes a new list belonging to the company', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'L',
      status: 'new',
    });
    h.prisma.companyList.delete.mockResolvedValue({});
    expect(await vibe.deleteCompanyList(1, 2)).toEqual({ success: true });
    expect(h.prisma.companyList.delete).toHaveBeenCalledWith({ where: { id: 2 } });
  });
});

describe('getProductionLists', () => {
  it('derives box counts from the per-printer calculator state', async () => {
    h.prisma.companyList.findMany.mockResolvedValue([
      {
        id: 1,
        companyId: 7,
        Company: { id: 7, name: 'Acme' },
        name: 'Tromp lijst',
        slug: 'a',
        printer: 'qrsong',
        status: 'production',
        numberOfCards: 200,
        numberOfBoxes: null,
        calculationTromp: JSON.stringify({ quantity: 40 }),
        calculation: JSON.stringify({ quantity: 1 }),
        buyPrice: 10,
        sellPrice: 20,
        desiredDeliveryDate: null,
        CompanyListDeliveryAddress: [{ id: 1 }, { id: 2 }],
        CompanyListFile: [{ type: 'cards' }, { type: 'box' }],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      },
      {
        id: 2,
        companyId: 8,
        Company: null,
        name: 'Schneider lijst',
        slug: 'b',
        printer: 'schneider',
        status: 'production',
        numberOfCards: 96,
        numberOfBoxes: 12, // explicit value wins over calculator
        calculationSchneider: JSON.stringify({ quantity: 99 }),
        CompanyListDeliveryAddress: [],
        CompanyListFile: [],
      },
      {
        id: 3,
        companyId: 9,
        Company: { id: 9, name: 'C' },
        name: 'Vibe lijst',
        slug: 'c',
        printer: null,
        status: 'production',
        numberOfBoxes: null,
        calculation: 'NOT JSON', // parse failure -> 0 boxes
        CompanyListDeliveryAddress: [],
        CompanyListFile: [],
      },
    ]);

    const res = await vibe.getProductionLists();
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(3);
    expect(res.data[0]).toMatchObject({
      id: 1,
      companyName: 'Acme',
      numberOfBoxes: 40,
      deliveryAddressCount: 2,
      fileTypes: ['cards', 'box'],
    });
    expect(res.data[1]).toMatchObject({
      id: 2,
      companyName: '',
      numberOfBoxes: 12,
    });
    expect(res.data[2]).toMatchObject({ id: 3, numberOfBoxes: 0 });
    expect(h.prisma.companyList.findMany.mock.calls[0][0].where).toEqual({
      status: 'production',
    });
  });

  it('maps errors', async () => {
    h.prisma.companyList.findMany.mockRejectedValue(new Error('x'));
    expect(await vibe.getProductionLists()).toMatchObject({
      success: false,
      error: 'Error getting production lists',
    });
  });
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
      Company: { id: 1, name: 'Acme & Zn' },
      CompanyListDeliveryAddress: [
        {
          id: 1,
          name: 'Magazijn & Co',
          address: 'Straatweg 1\n1234AB Stad\n',
          country: 'Nederland',
        },
        { id: 2, name: 'Tweede', address: 'Laan 2', country: 'België' },
      ],
      CompanyListFile: [
        { type: 'cards', originalName: 'cards.pdf' },
        { type: 'box', originalName: 'box.pdf' },
      ],
      ...over,
    };
  }

  it('rejects unknown lists or other companies', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    expect(await vibe.getOrderEmail(1, 2)).toMatchObject({
      success: false,
      error: 'List not found',
    });
    h.prisma.companyList.findUnique.mockResolvedValue(baseList({ companyId: 99 }));
    expect(await vibe.getOrderEmail(1, 2)).toMatchObject({
      success: false,
      error: 'List not found',
    });
  });

  it('builds a complete Schneider order mail without warnings', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(baseList());
    const res = await vibe.getOrderEmail(1, 2);
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

    // Addresses: first gets all boxes, second 0, QRSong! appended with 3
    expect(d.addressCount).toBe(3);
    expect(d.text).toContain('op drie verschillende adressen');
    expect(d.text).toContain('Adres 1: 5 stuks');
    expect(d.text).toContain('Adres 2: 0 stuks');
    expect(d.text).toContain('Adres 3: 3 stuks');
    expect(d.text).toContain('Rick Groenewegen\nPrinsenhof 1');

    // Multi-line address split + country appended
    expect(d.text).toContain('Magazijn & Co\nStraatweg 1\n1234AB Stad\nNederland');

    // HTML escapes ampersands
    expect(d.html).toContain('Magazijn &amp; Co');
    expect(d.files).toEqual([
      { type: 'cards', originalName: 'cards.pdf' },
      { type: 'box', originalName: 'box.pdf' },
    ]);
  });

  it('falls back to the 96-card spec for unknown Schneider card counts', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({ calculationSchneider: JSON.stringify({ quantity: 5, cardCount: 60 }) })
    );
    const res = await vibe.getOrderEmail(1, 2);
    expect(res.data.text).toContain('60 kaarten (2x 48 in banderol)');
  });

  it('uses the Tromp description for qrsong lists (luxe)', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({
        printer: 'qrsong',
        calculationTromp: JSON.stringify({ quantity: 8, printingType: 'luxe' }),
      })
    );
    const res = await vibe.getOrderEmail(1, 2);
    expect(res.data.totalBoxes).toBe(8);
    expect(res.data.text).toContain('luxe doos met 200 kaarten + bedrukte chips');
  });

  it('collects warnings for missing quantity, date, addresses and files', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(
      baseList({
        printer: null,
        calculation: null,
        desiredDeliveryDate: null,
        CompanyListDeliveryAddress: [],
        CompanyListFile: [{ type: 'cards', originalName: 'c.pdf' }],
        numberOfCards: 200,
      })
    );
    const res = await vibe.getOrderEmail(1, 2);
    expect(res.success).toBe(true);
    const d = res.data;

    expect(d.totalBoxes).toBe(0);
    expect(d.text).toContain('totaal [AANTAL] x');
    expect(d.text).toContain('uiterlijk [LEVERDATUM]');
    // Only the QRSong! fallback address remains
    expect(d.addressCount).toBe(1);
    expect(d.text).toContain('op één verschillende adressen');

    expect(d.warnings).toEqual([
      expect.stringContaining('Geen aantal dozen gevonden'),
      expect.stringContaining('OnzeVibe printer'),
      expect.stringContaining('Geen gewenste leverdatum'),
      expect.stringContaining('Geen leveradressen'),
      expect.stringContaining('doosje ontbreekt'),
    ]);
  });

  it('maps errors', async () => {
    h.prisma.companyList.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.getOrderEmail(1, 2)).toMatchObject({
      success: false,
      error: 'Error building order email',
    });
  });
});

describe('getQuotationPDF', () => {
  function arrangeQuotation() {
    h.prisma.quotation.findUnique.mockResolvedValue({
      id: 4,
      companyId: 1,
      quotationNumber: 'QRS12345678',
    });
    h.prisma.company.findMany.mockResolvedValue([
      { id: 1, name: 'Acme Co!', test: false, _count: { CompanyList: 0 } },
    ]);
  }

  it('forbids companyadmins from fetching other companies', async () => {
    const res = await vibe.getQuotationPDF(1, 4, ['companyadmin'], 2);
    expect(res).toMatchObject({ success: false, error: 'Forbidden' });
    expect(h.prisma.quotation.findUnique).not.toHaveBeenCalled();
  });

  it('rejects unknown quotations and company mismatches', async () => {
    h.prisma.quotation.findUnique.mockResolvedValueOnce(null);
    expect(await vibe.getQuotationPDF(1, 4, ['admin'])).toMatchObject({
      success: false,
      error: 'Quotation not found',
    });
    h.prisma.quotation.findUnique.mockResolvedValueOnce({ id: 4, companyId: 9 });
    expect(await vibe.getQuotationPDF(1, 4, ['admin'])).toMatchObject({
      success: false,
      error: 'Quotation not found',
    });
  });

  it('reports a missing archived PDF', async () => {
    arrangeQuotation();
    h.fs.access.mockRejectedValue(new Error('ENOENT'));
    expect(await vibe.getQuotationPDF(1, 4, ['admin'])).toMatchObject({
      success: false,
      error: 'Archived PDF not found',
    });
  });

  it('streams the archived PDF with a sanitized filename', async () => {
    arrangeQuotation();
    h.fs.access.mockResolvedValue(undefined);
    const pdf = Buffer.from('%PDF-fake');
    h.fs.readFile.mockResolvedValue(pdf);

    const res = await vibe.getQuotationPDF(1, 4, ['companyadmin'], 1);
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
    const res = await vibe.generateQuotationPDF(1, 9, ['companyadmin'], 2);
    expect(res).toMatchObject({
      success: false,
      error: 'Forbidden: You can only generate quotations for your own company',
    });
  });

  it('fails cleanly when companies cannot be fetched', async () => {
    h.prisma.company.findMany.mockRejectedValue(new Error('db'));
    expect(await vibe.generateQuotationPDF(1, 9, ['admin'])).toMatchObject({
      success: false,
      error: 'Failed to fetch companies',
    });
  });

  it('fails when the company does not exist', async () => {
    h.prisma.company.findMany.mockResolvedValue([
      { id: 2, name: 'Other', _count: { CompanyList: 0 } },
    ]);
    expect(await vibe.generateQuotationPDF(1, 9, ['admin'])).toMatchObject({
      success: false,
      error: 'Company not found',
    });
  });
});

describe('processAndSaveImage (private)', () => {
  const anyVibe = vibe as any;

  it('returns null when no file part is provided', async () => {
    expect(await anyVibe.processAndSaveImage(null, 5, 'background')).toBeNull();
    expect(
      await anyVibe.processAndSaveImage({ filename: '' }, 5, 'background')
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
    const name = await anyVibe.processAndSaveImage(part, 5, 'votingLogo');
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
    expect(await anyVibe.processAndSaveImage(part, 5, 'background')).toBeNull();
  });
});
