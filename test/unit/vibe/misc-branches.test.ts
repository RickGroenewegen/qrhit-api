/**
 * Unit tests for src/vibe.ts — remaining branches: error catches, invoice line
 * variants, finalize edge cases and Excel cell-type handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, resetAll } from './vibe-mocks';

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

import ExcelJS from 'exceljs';
import Vibe from '../../../src/vibe';

const vibe = Vibe.getInstance();

process.env['API_URI'] = 'https://api.test';

beforeEach(() => {
  resetAll();
});

describe('error catch branches', () => {
  it('verifySubmission maps prisma errors', async () => {
    h.prisma.companyListSubmission.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.verifySubmission(9)).toMatchObject({
      success: false,
      error: 'Error verifying submission',
    });
  });

  it('getCompanyLists maps prisma errors', async () => {
    h.prisma.company.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.getCompanyLists(1)).toMatchObject({
      success: false,
      error: 'Error retrieving company lists',
    });
  });

  it('deleteCompany maps prisma errors', async () => {
    h.prisma.company.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.deleteCompany(1)).toMatchObject({
      success: false,
      error: 'Error deleting company',
    });
  });

  it('deleteCompanyList maps prisma errors', async () => {
    h.prisma.companyList.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.deleteCompanyList(1, 2)).toMatchObject({
      success: false,
      error: 'Error deleting company list',
    });
  });

  it('company event mutations map prisma errors', async () => {
    h.prisma.companyEvent.create.mockRejectedValue(new Error('x'));
    expect(await vibe.createCompanyEvent(1, 2, 'c', null)).toMatchObject({
      success: false,
      error: 'Failed to create company event',
    });
    h.prisma.companyEvent.findFirst.mockResolvedValue({ id: 3 });
    h.prisma.companyEvent.update.mockRejectedValue(new Error('x'));
    expect(await vibe.updateCompanyEvent(1, 3, 'c')).toMatchObject({
      success: false,
      error: 'Failed to update event',
    });
    h.prisma.companyEvent.findFirst.mockResolvedValue({ id: 3, attachmentUrl: null });
    h.prisma.companyEvent.delete.mockRejectedValue(new Error('x'));
    expect(await vibe.deleteCompanyEvent(1, 3)).toMatchObject({
      success: false,
      error: 'Failed to delete company event',
    });
  });

  it('pricing calculators catch malformed params objects', async () => {
    expect(await vibe.calculatePricing(null as any)).toMatchObject({
      success: false,
      error: 'Error calculating pricing',
    });
    expect(await vibe.calculateTrompPricing(null as any)).toMatchObject({
      success: false,
      error: 'Error calculating Tromp pricing',
    });
    expect(await vibe.calculateSchneiderPricing(null as any)).toMatchObject({
      success: false,
      error: 'Error calculating Schneider pricing',
    });
  });

  it('getQuotationPDF surfaces lookup failures and missing companies', async () => {
    h.prisma.quotation.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.getQuotationPDF(1, 4, ['admin'])).toMatchObject({
      success: false,
      error: 'Failed to fetch quotation',
    });

    h.prisma.quotation.findUnique.mockResolvedValue({
      id: 4,
      companyId: 1,
      quotationNumber: 'QRS1',
    });
    h.prisma.company.findMany.mockResolvedValue([]); // no companies at all
    expect(await vibe.getQuotationPDF(1, 4, ['admin'])).toMatchObject({
      success: false,
      error: 'Company not found',
    });
  });

  it('markSpotifyForReload ignores a falsy companyListId', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      id: 8,
      companyListId: 0,
    });
    h.prisma.companyListSubmission.delete.mockResolvedValue({});
    expect(await vibe.deleteSubmission(8)).toEqual({ success: true });
    expect(h.prisma.companyList.update).not.toHaveBeenCalled();
  });
});

describe('getState — successful non-empty ranking', () => {
  it('embeds the computed ranking in the state payload', async () => {
    h.prisma.companyList.findUnique.mockImplementation(async ({ select }: any) =>
      select?.slug
        ? { id: 5, name: 'L', slug: 'l', languages: null }
        : { id: 5, name: 'L', numberOfTracks: 3, numberOfCards: 5 }
    );
    h.prisma.companyListQuestion.findMany.mockResolvedValue([]);
    h.prisma.companyListSubmission.findMany.mockImplementation(async ({ where }: any) =>
      where.verified
        ? [
            {
              id: 1,
              firstname: 'Alice',
              lastname: 'A',
              agreeToUseName: true,
              createdAt: new Date('2026-01-01'),
              CompanyListSubmissionTrack: [
                { trackId: 10, position: 1, isBirthdayTrack: false },
              ],
            },
          ]
        : []
    );
    h.prisma.track.findMany.mockResolvedValue([
      {
        id: 10,
        trackId: 'sp10',
        name: 'S',
        artist: 'A',
        year: 1999,
        manuallyChecked: true,
        spotifyLink: 'https://open.spotify.com/track/sp10',
        youtubeLink: null,
      },
    ]);

    const res = await vibe.getState(5);
    expect(res.success).toBe(true);
    expect(res.data.ranking).toHaveLength(1);
    expect(res.data.ranking[0]).toMatchObject({ id: 10, score: 3, withinLimit: true });
  });
});

describe('updateCompanyList — remaining date/number branches', () => {
  beforeEach(() => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'L',
      slug: 'sl',
      background: null,
      background2: null,
    });
  });

  function makeRequest(parts: any[]) {
    return {
      parts: () =>
        (async function* () {
          for (const p of parts) yield p;
        })(),
    };
  }

  it('ignores non-numeric minimumNumberOfTracks, nulls invalid startAt and empty endAt', async () => {
    // Update echoes back an empty slug -> cache clearing is skipped
    h.prisma.companyList.update.mockImplementation(async ({ data }: any) => ({
      id: 2,
      slug: '',
      ...data,
    }));
    const res = await vibe.updateCompanyList(
      1,
      2,
      makeRequest([
        { type: 'field', fieldname: 'minimumNumberOfTracks', value: 'xx' },
        { type: 'field', fieldname: 'startAt', value: 'garbage-date' },
        { type: 'field', fieldname: 'endAt', value: '' },
      ])
    );
    expect(res.success).toBe(true);
    const data = h.prisma.companyList.update.mock.calls[0][0].data;
    expect(data).toEqual({ startAt: null, endAt: null });
    expect('minimumNumberOfTracks' in data).toBe(false);
    // Empty slug -> clearCompanyListCache bails out
    expect(h.cacheDel).not.toHaveBeenCalled();
  });
});

describe('generatePDF — forceTemplate edge cases on the queued path', () => {
  function arrange(list: any) {
    h.prisma.companyList.findUnique.mockImplementation(async (args: any) =>
      args.include ? list : { id: 5, numberOfTracks: 5, numberOfCards: 200 }
    );
    h.prisma.companyList.update.mockResolvedValue({ id: 5, slug: 'lijst' });
    h.discount.createDiscountCode.mockResolvedValue({ code: 'D' });
    h.mollie.getPaymentUri.mockResolvedValue({ data: { generationQueued: true } });
  }

  const list = {
    id: 5,
    name: 'L',
    slug: 'lijst',
    playlistId: null,
    paymentId: null,
    playlistUrl: 'https://open.spotify.com/playlist/pl1',
    background: null,
    background2: null,
    hideCircle: false,
    forceTemplate: 'classic',
    showNames: false,
    numberOfCards: 100,
    Company: { id: 1, name: 'A' },
  };

  it('logs and continues when the playlist for forceTemplate is missing', async () => {
    arrange(list);
    h.prisma.playlist.findUnique.mockResolvedValue(null);
    const res = await vibe.generatePDF(5, { getPaymentUri: h.mollie.getPaymentUri } as any, '1.1.1.1');
    expect(res.success).toBe(true);
    expect(h.prisma.playlist.update).not.toHaveBeenCalled();
  });

  it('swallows forceTemplate lookup errors', async () => {
    arrange(list);
    h.prisma.playlist.findUnique.mockRejectedValue(new Error('db'));
    const res = await vibe.generatePDF(5, { getPaymentUri: h.mollie.getPaymentUri } as any, '1.1.1.1');
    expect(res.success).toBe(true);
  });
});

describe('finalizeList — edge cases', () => {
  const submissionFixture = [
    {
      id: 1,
      firstname: 'A',
      lastname: 'B',
      agreeToUseName: true,
      createdAt: new Date('2026-01-01'),
      CompanyListSubmissionTrack: [{ trackId: 10, position: 1, isBirthdayTrack: false }],
    },
  ];
  const trackFixture = [
    {
      id: 10,
      trackId: 'sp10',
      name: 'S',
      artist: 'A',
      year: 1999,
      manuallyChecked: true,
      spotifyLink: 'https://open.spotify.com/track/sp10',
      youtubeLink: null,
    },
  ];

  it('finalizes an empty ranking without creating playlists', async () => {
    h.prisma.companyList.findUnique.mockImplementation(async (args: any) =>
      args.include
        ? { id: 1, name: 'L', numberOfCards: 2, Company: { name: 'Acme' } }
        : { id: 1, name: 'L', numberOfTracks: 3, numberOfCards: 2 }
    );
    h.prisma.companyListSubmission.findMany.mockResolvedValue([]);
    h.prisma.companyList.update.mockResolvedValue({ id: 1, slug: 's' });

    const res = await vibe.finalizeList(1);
    expect(res.success).toBe(true);
    expect(res.data.tracks).toEqual([]);
    // Both playlist attempts fail with "No tracks provided"
    expect(res.data.playlistLimited).toEqual({ error: 'No tracks provided' });
    expect(h.spotify.createOrUpdatePlaylist).not.toHaveBeenCalled();
  });

  it('hits the withinLimit fallback when the limit excludes everything', async () => {
    // Ranking sees numberOfCards 0 (nothing within limit) while finalize
    // sees 2 -> exercises the fallback logging path.
    h.prisma.companyList.findUnique.mockImplementation(async (args: any) =>
      args.include
        ? { id: 1, name: 'L', numberOfCards: 2, Company: { name: 'Acme' } }
        : { id: 1, name: 'L', numberOfTracks: 3, numberOfCards: 0 }
    );
    h.prisma.companyListSubmission.findMany.mockResolvedValue(submissionFixture);
    h.prisma.track.findMany.mockResolvedValue(trackFixture);
    h.prisma.companyList.update.mockResolvedValue({ id: 1, slug: 's' });
    h.spotify.createOrUpdatePlaylist.mockResolvedValue({
      success: true,
      data: { playlistUrl: 'https://sp/full' },
    });

    const res = await vibe.finalizeList(1);
    expect(res.success).toBe(true);
    expect(res.data.tracks).toEqual([]); // limited list stays empty
    // Limited playlist gets no tracks -> only the FULL playlist is created
    expect(h.spotify.createOrUpdatePlaylist).toHaveBeenCalledTimes(1);
    expect(h.spotify.createOrUpdatePlaylist).toHaveBeenCalledWith('Acme - L (FULL)', [
      'sp10',
    ]);
  });

  it('logs but survives DB failures while storing playlist URLs', async () => {
    h.prisma.companyList.findUnique.mockImplementation(async (args: any) =>
      args.include
        ? { id: 1, name: 'L', numberOfCards: 2, Company: { name: 'Acme' } }
        : { id: 1, name: 'L', numberOfTracks: 3, numberOfCards: 2 }
    );
    h.prisma.companyListSubmission.findMany.mockResolvedValue(submissionFixture);
    h.prisma.track.findMany.mockResolvedValue(trackFixture);
    h.spotify.createOrUpdatePlaylist.mockResolvedValue({
      success: true,
      data: { playlistUrl: 'https://sp/x' },
    });
    h.prisma.companyList.update.mockImplementation(async ({ data }: any) => {
      if (data.playlistUrl || data.playlistUrlFull) {
        throw new Error('url column gone');
      }
      return { id: 1, slug: 's' };
    });

    const res = await vibe.finalizeList(1);
    expect(res.success).toBe(true); // status update still succeeded
  });

  it('maps unexpected errors', async () => {
    h.prisma.companyList.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.finalizeList(1)).toMatchObject({
      success: false,
      error: 'Error finalizing list',
    });
  });
});

describe('buildInvoiceLineItems — description and extras variants', () => {
  beforeEach(() => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'Acme' });
  });

  it('qrsong luxe description with extras and voting portal lines', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'L',
      calculationTromp: JSON.stringify({
        quantity: 100,
        printingType: 'luxe',
        profitMargin: 1,
        includeStansvorm: true,
        includeVotingPortal: true,
      }),
    });
    const res = await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'full');
    expect(res.success).toBe(true);
    expect(res.items![0].description).toBe(
      'QRSong! Luxe doos — Luxe doos met 200 kaarten en bedrukte chips'
    );
    expect(res.items).toContainEqual({
      description: 'Stansvorm (eenmalige kosten)',
      amount: '1',
      price: '425.00',
    });
    expect(res.items).toContainEqual({
      description: 'Voting Portal — eenmalige kosten, gebruik stemportaal',
      amount: '1',
      price: '500.00',
    });
    // 50/set * 100 + 425 stansvorm + 500 portal
    expect(res.totals!.subtotalExclVat).toBeCloseTo(5925, 2);
  });

  it('qrsong klein description', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'L',
      calculationTromp: JSON.stringify({
        quantity: 100,
        printingType: 'klein',
        profitMargin: 0,
      }),
    });
    const res = await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'full');
    expect(res.items![0].description).toBe(
      'QRSong! muziekkaarten set — Klein voorbedrukt doosje met 100 kaarten'
    );
  });

  it('schneider keeps app/voting out of the extras lines but adds dedicated lines', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'L',
      calculationSchneider: JSON.stringify({
        quantity: 100,
        cardCount: 48,
        profitMargin: 1,
        includeCustomApp: true,
        includeVotingPortal: true,
      }),
    });
    const res = await vibe.buildInvoiceLineItems(1, 2, 'schneider', 'full');
    expect(res.success).toBe(true);
    const descriptions = res.items!.map((i) => i.description);
    expect(descriptions).toEqual([
      'QRSong! Box - 48 kaarten',
      'App in eigen stijl — eenmalige kosten, maatwerk app ontwikkeling',
      'Voting Portal — eenmalige kosten, gebruik stemportaal',
    ]);
    // No duplicated "(eenmalige kosten)" lines for app/voting extras
    expect(descriptions.filter((d) => d.includes('eenmalige kosten'))).toHaveLength(2);
    expect(res.totals!.subtotalExclVat).toBeCloseTo(472 + 350 + 500, 2);
  });

  it('onzevibe adds the custom app line', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'L',
      calculation: JSON.stringify({
        quantity: 100,
        includePersonalization: true,
        includeCustomApp: true,
      }),
    });
    const res = await vibe.buildInvoiceLineItems(1, 2, 'onzevibe', 'full');
    expect(res.items).toContainEqual({
      description: 'App in eigen stijl — eenmalige kosten, maatwerk app ontwikkeling',
      amount: '1',
      price: '350.00',
    });
  });
});

describe('importCompaniesFromExcel — cell types and skipped rows', () => {
  beforeEach(() => {
    h.prisma.userGroup.findUnique.mockResolvedValue({ id: 30, name: 'companyadmin' });
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockImplementation(async ({ data }: any) => ({
      id: 100,
      ...data,
    }));
    h.prisma.companyEvent.create.mockResolvedValue({});
    h.prisma.user.findUnique.mockResolvedValue(null);
    h.prisma.user.create.mockImplementation(async ({ data }: any) => ({
      id: 200,
      ...data,
    }));
    h.prisma.userInGroup.create.mockResolvedValue({});
  });

  it('extracts rich text, hyperlink and formula cell values; skips nameless/email-less rows', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Leads');
    sheet.addRow(['Bedrijfsnaam', 'E-mail', 'Voornaam', 'Achternaam']);

    // Rich text company name + hyperlink e-mail + formula first name
    const row = sheet.addRow([]);
    row.getCell(1).value = { richText: [{ text: 'Rich ' }, { text: 'Co' }] } as any;
    row.getCell(2).value = {
      text: 'mail@rich.co',
      hyperlink: 'mailto:mail@rich.co',
    } as any;
    row.getCell(3).value = { formula: 'A1', result: 'Form' } as any;
    row.getCell(4).value = 'Ula';

    // Row without a company name -> skipped entirely
    sheet.addRow(['', 'ignored@x.y', 'I', 'G']);
    // Second contact row for Rich Co without an e-mail -> no user created
    sheet.addRow(['Rich Co', '', 'No', 'Mail']);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(res.success).toBe(true);
    expect(res.data.imported).toBe(1);

    const companyData = h.prisma.company.create.mock.calls[0][0].data;
    expect(companyData.name).toBe('Rich Co');
    expect(companyData.contactemail).toBe('mail@rich.co');
    expect(companyData.contact).toBe('Form Ula');

    // Only one user (the mail-less row contributes none)
    expect(h.prisma.user.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.user.create.mock.calls[0][0].data.email).toBe('mail@rich.co');
  });
});
