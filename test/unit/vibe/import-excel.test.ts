/**
 * Unit tests for src/vibe.ts — importCompaniesFromExcel. Uses the REAL
 * exceljs library to build workbook buffers (the code under test loads
 * them with exceljs too), with all database access mocked.
 *
 * Columns are matched by header name. The primary layout tested here is
 * the current lead export (Email, First name, Last name, Company name,
 * Phone number, Address, zipcode, Country, ... Comment ...); the older
 * Dutch layout (Bedrijfsnaam, E-mail, Voornaam, ...) is covered as well.
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
// NOTE: no fs/sharp/exceljs mocks here — exceljs must stay real.

import ExcelJS from 'exceljs';
import Vibe from '../../../src/vibe';

const vibe = Vibe.getInstance();

/** Header row of the current lead export (24 columns). */
const HEADER = [
  'Email',
  'First name',
  'Last name',
  'Company name',
  'Phone number',
  'Address',
  'zipcode',
  'Country',
  'voorkeurstaal',
  'visitor_type',
  'inhouse_specialties',
  'visit_goal',
  'company_size',
  'Creation date',
  'Source',
  'History',
  'Author',
  'Comment',
  'Rating',
  'Product interests',
  'Test',
  'type',
  'role',
  'follow_up_action',
];

/** Header row of the older Dutch export. */
const LEGACY_HEADER = [
  'Bedrijfsnaam',
  'E-mail',
  'Voornaam',
  'Achternaam',
  'Telefoonnummer',
  'Adres',
  'Plaats',
  'Land',
  'zipcode',
  'Categorie',
  'Opmerking',
];

type Lead = {
  email?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
  address?: string;
  zipcode?: string;
  country?: string;
  comment?: string;
};

/** Build a data row in the current export layout from named fields. */
function lead(l: Lead): any[] {
  const row = new Array(HEADER.length).fill('');
  row[0] = l.email ?? '';
  row[1] = l.firstName ?? '';
  row[2] = l.lastName ?? '';
  row[3] = l.company ?? '';
  row[4] = l.phone ?? '';
  row[5] = l.address ?? '';
  row[6] = l.zipcode ?? '';
  row[7] = l.country ?? '';
  row[8] = 'Dutch';
  row[9] = 'Distributor (in the sense of reseller/intermediary). Supplies to end customers.';
  row[13] = '2026-09-01 20:27:31 +0200';
  row[14] = 'Badge scan';
  row[15] = 'September 03 2026 at 15:57:41 : Badge scan';
  row[16] = 'Some Author';
  row[17] = l.comment ?? '';
  row[18] = '0';
  return row;
}

async function buildXlsx(rows: any[][], header: string[] = HEADER): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Contact List');
  sheet.addRow(header);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

beforeEach(() => {
  resetAll();
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
  h.prisma.user.update.mockResolvedValue({});
  h.prisma.userInGroup.create.mockResolvedValue({});
});

describe('importCompaniesFromExcel', () => {
  it('rejects an empty sheet (header only)', async () => {
    const buffer = await buildXlsx([]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(res).toMatchObject({
      success: false,
      error: 'Excel file is empty or has no data rows',
    });
  });

  it('rejects a sheet without a recognisable company column', async () => {
    const buffer = await buildXlsx([['a@b.nl', 'Jan']], ['Email', 'First name']);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Could not find a company name column');
    expect(res.error).toContain('Email, First name');
    expect(h.prisma.company.create).not.toHaveBeenCalled();
  });

  it('fails when the companyadmin group is missing', async () => {
    h.prisma.userGroup.findUnique.mockResolvedValue(null);
    const buffer = await buildXlsx([lead({ company: 'Acme', email: 'a@acme.nl' })]);
    expect(await vibe.importCompaniesFromExcel(buffer, 1)).toMatchObject({
      success: false,
      error: 'companyadmin user group not found',
    });
  });

  it('imports a lead from the current export layout', async () => {
    const buffer = await buildXlsx([
      lead({
        email: 'marnix@unigear.nl',
        firstName: 'Marnix',
        lastName: 'de Vries',
        company: 'Unigear',
        phone: '+31850805815',
        address: 'Utrechtseweg 92',
        zipcode: '3702 AD',
        country: 'Netherlands',
        comment: 'Wil folder digitaal',
      }),
    ]);
    const res = await vibe.importCompaniesFromExcel(buffer, 42);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ imported: 1, skipped: 0, usersCreated: 1, errors: [] });

    expect(h.prisma.company.create).toHaveBeenCalledWith({
      data: {
        name: 'Unigear',
        test: true, // imported as lead
        followUp: false,
        address: 'Utrechtseweg',
        housenumber: '92',
        city: '', // the export has no city column
        zipcode: '3702 AD',
        countrycode: 'NL',
        contact: 'Marnix de Vries',
        contactemail: 'marnix@unigear.nl',
        contactphone: '+31850805815', // already international, kept as-is
      },
    });

    // Comment column lands as a company event by the importing user
    expect(h.prisma.companyEvent.create).toHaveBeenCalledWith({
      data: {
        companyId: 100,
        userId: 42,
        type: 'comment',
        content: 'Wil folder digitaal',
      },
    });

    // Contact user created, unverified, in the companyadmin group
    const userData = h.prisma.user.create.mock.calls[0][0].data;
    expect(userData).toMatchObject({
      email: 'marnix@unigear.nl',
      displayName: 'Marnix de Vries',
      companyId: 100,
      verified: false,
    });
    expect(userData.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(h.prisma.userInGroup.create).toHaveBeenCalledWith({
      data: { userId: 200, groupId: 30 },
    });

    expect(res.data.details).toEqual([
      { company: 'Unigear', status: 'imported', companyId: 100, usersCreated: 1 },
    ]);
  });

  it('still imports the older Dutch layout (columns matched by header name)', async () => {
    const buffer = await buildXlsx(
      [
        [
          'Acme BV',
          'jan@acme.nl',
          'Jan',
          'Visser',
          '0612345678',
          'Hoofdstraat 12a',
          'Utrecht',
          'Nederland',
          '3511AB',
          'Horeca',
          'Warm contact, terugbellen',
        ],
      ],
      LEGACY_HEADER
    );
    const res = await vibe.importCompaniesFromExcel(buffer, 42);
    expect(res.data).toMatchObject({ imported: 1, skipped: 0, errors: [] });
    expect(h.prisma.company.create).toHaveBeenCalledWith({
      data: {
        name: 'Acme BV',
        test: true,
        followUp: false,
        address: 'Hoofdstraat',
        housenumber: '12a',
        city: 'Utrecht',
        zipcode: '3511AB',
        countrycode: 'NL',
        contact: 'Jan Visser',
        contactemail: 'jan@acme.nl',
        contactphone: '+31612345678',
      },
    });
    expect(h.prisma.companyEvent.create).toHaveBeenCalledWith({
      data: { companyId: 100, userId: 42, type: 'comment', content: 'Warm contact, terugbellen' },
    });
  });

  it('matches headers regardless of case, spacing and punctuation', async () => {
    const header = ['COMPANY_NAME', 'e_mail', 'First-Name', 'LAST NAME', 'Zip Code'];
    const buffer = await buildXlsx([['Acme', 'x@acme.nl', 'Jan', 'V', '1234AB']], header);
    await vibe.importCompaniesFromExcel(buffer, 1);
    expect(h.prisma.company.create.mock.calls[0][0].data).toMatchObject({
      name: 'Acme',
      contactemail: 'x@acme.nl',
      contact: 'Jan V',
      zipcode: '1234AB',
    });
  });

  it('groups multiple rows of one company and creates a user per contact', async () => {
    const buffer = await buildXlsx([
      lead({ company: 'Döbler', email: 'eckert@doebler.de', firstName: 'E', lastName: 'K' }),
      lead({ company: 'Döbler', email: 'judith@doebler.de', firstName: 'J', lastName: 'M' }),
    ]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(res.data.imported).toBe(1);
    expect(res.data.usersCreated).toBe(2);
    expect(h.prisma.company.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.user.create).toHaveBeenCalledTimes(2);
    expect(res.data.details[0].usersCreated).toBe(2);
  });

  it('skips existing companies but still creates their missing contacts', async () => {
    h.prisma.company.findFirst.mockResolvedValue({ id: 7, name: 'Acme BV' });
    h.prisma.user.findUnique
      .mockResolvedValueOnce({ id: 9, email: 'jan@acme.nl', companyId: 7 }) // already a contact
      .mockResolvedValueOnce(null); // new contact person
    const buffer = await buildXlsx([
      lead({ company: 'Acme BV', email: 'jan@acme.nl', firstName: 'Jan', lastName: 'V' }),
      lead({ company: 'Acme BV', email: 'piet@acme.nl', firstName: 'Piet', lastName: 'B' }),
    ]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);

    expect(res.data).toMatchObject({ imported: 0, skipped: 1, usersCreated: 1 });
    expect(h.prisma.company.create).not.toHaveBeenCalled();
    expect(h.prisma.companyEvent.create).not.toHaveBeenCalled();

    // Only Piet is new; he is linked to the existing company as companyadmin
    expect(h.prisma.user.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.user.create.mock.calls[0][0].data).toMatchObject({
      email: 'piet@acme.nl',
      displayName: 'Piet B',
      companyId: 7,
      verified: false,
    });
    expect(h.prisma.userInGroup.create).toHaveBeenCalledWith({
      data: { userId: 200, groupId: 30 },
    });
    expect(res.data.details[0]).toEqual({
      company: 'Acme BV',
      status: 'skipped',
      reason: 'Company already exists',
      companyId: 7,
      usersCreated: 1,
    });
  });

  it('links existing company-less users instead of recreating them', async () => {
    h.prisma.user.findUnique.mockResolvedValue({
      id: 9,
      email: 'jan@acme.nl',
      companyId: null,
    });
    const buffer = await buildXlsx([lead({ company: 'Acme BV', email: 'jan@acme.nl' })]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(h.prisma.user.create).not.toHaveBeenCalled();
    expect(h.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { companyId: 100 },
    });
    expect(res.data.details[0].usersCreated).toBe(1);
  });

  it('leaves users alone when they already belong to a company', async () => {
    h.prisma.user.findUnique.mockResolvedValue({
      id: 9,
      email: 'jan@acme.nl',
      companyId: 55,
    });
    const buffer = await buildXlsx([lead({ company: 'Acme BV', email: 'jan@acme.nl' })]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(h.prisma.user.update).not.toHaveBeenCalled();
    expect(res.data.details[0].usersCreated).toBe(0);
    expect(res.data.usersCreated).toBe(0);
  });

  it.each([
    ['0612345678', '+31612345678'],
    ['612345678', '+31612345678'],
    ['201234567', '+31201234567'],
    ['+447700900000', '+447700900000'],
    ['0032472290359', '+32472290359'],
    ['', ''],
  ])('normalizes phone %s to %s', async (input, expected) => {
    const buffer = await buildXlsx([lead({ company: 'Acme BV', email: 'jan@acme.nl', phone: input })]);
    await vibe.importCompaniesFromExcel(buffer, 1);
    expect(h.prisma.company.create.mock.calls[0][0].data.contactphone).toBe(expected);
  });

  it.each([
    ['Netherlands', 'NL'],
    ['Belgium', 'BE'],
    ['Germany', 'DE'],
    ['Ireland', 'IE'],
    ['United Kingdom', 'GB'],
    ['Luxembourg', 'LU'],
    ['Spain', 'ES'],
    ['Slovenia', 'SI'],
    ['', ''],
  ])('maps country %s to %s', async (input, expected) => {
    const buffer = await buildXlsx([lead({ company: 'Acme BV', email: 'jan@acme.nl', country: input })]);
    await vibe.importCompaniesFromExcel(buffer, 1);
    expect(h.prisma.company.create.mock.calls[0][0].data.countrycode).toBe(expected);
  });

  it.each([
    ['Wolkammersstraat, 2', 'Wolkammersstraat', '2'],
    ['Loopkantstraat 10 B', 'Loopkantstraat', '10 B'],
    ['Golf van Biskaje 7a', 'Golf van Biskaje', '7a'],
    ['Zonder Nummer', 'Zonder Nummer', ''],
    ['', '', ''],
  ])('splits address %s into street %s and number %s', async (input, street, number) => {
    const buffer = await buildXlsx([lead({ company: 'Acme BV', email: 'jan@acme.nl', address: input })]);
    await vibe.importCompaniesFromExcel(buffer, 1);
    const data = h.prisma.company.create.mock.calls[0][0].data;
    expect(data.address).toBe(street);
    expect(data.housenumber).toBe(number);
  });

  it('keeps unknown countries as-is', async () => {
    const buffer = await buildXlsx([lead({ company: 'Acme BV', email: 'jan@acme.nl', country: 'Atlantis' })]);
    await vibe.importCompaniesFromExcel(buffer, 1);
    expect(h.prisma.company.create.mock.calls[0][0].data.countrycode).toBe('Atlantis');
  });

  it('records per-company errors and keeps importing the rest', async () => {
    h.prisma.company.create
      .mockRejectedValueOnce(new Error('insert exploded'))
      .mockImplementation(async ({ data }: any) => ({ id: 101, ...data }));
    const buffer = await buildXlsx([
      lead({ company: 'Broken BV', email: 'x@broken.nl' }),
      lead({ company: 'Fine BV', email: 'ok@fine.nl' }),
    ]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(res.success).toBe(true);
    expect(res.data.imported).toBe(1);
    expect(res.data.errors).toEqual(['Broken BV: insert exploded']);
    expect(res.data.details).toContainEqual({
      company: 'Broken BV',
      status: 'error',
      error: 'insert exploded',
    });
  });

  it('rejects unreadable buffers with the import error message', async () => {
    const res = await vibe.importCompaniesFromExcel(Buffer.from('not xlsx'), 1);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to import companies');
  });
});
