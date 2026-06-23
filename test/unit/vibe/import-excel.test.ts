/**
 * Unit tests for src/vibe.ts — importCompaniesFromExcel. Uses the REAL
 * exceljs library to build workbook buffers (the code under test loads
 * them with exceljs too), with all database access mocked.
 *
 * Column layout: Bedrijfsnaam, E-mail, Voornaam, Achternaam, Telefoon,
 * Adres, Plaats, Land, zipcode, Categorie, Opmerking.
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

const HEADER = [
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

async function buildXlsx(rows: any[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Leads');
  sheet.addRow(HEADER);
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

  it('fails when the companyadmin group is missing', async () => {
    h.prisma.userGroup.findUnique.mockResolvedValue(null);
    const buffer = await buildXlsx([
      ['Acme', 'a@acme.nl', 'Jan', 'Visser', '', '', '', '', '', '', ''],
    ]);
    expect(await vibe.importCompaniesFromExcel(buffer, 1)).toMatchObject({
      success: false,
      error: 'companyadmin user group not found',
    });
  });

  it('imports a company as a lead with parsed address, country, phone and note', async () => {
    const buffer = await buildXlsx([
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
    ]);
    const res = await vibe.importCompaniesFromExcel(buffer, 42);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ imported: 1, skipped: 0, errors: [] });

    expect(h.prisma.company.create).toHaveBeenCalledWith({
      data: {
        name: 'Acme BV',
        test: true, // imported as lead
        followUp: false,
        address: 'Hoofdstraat',
        housenumber: '12a',
        city: 'Utrecht',
        zipcode: '3511AB',
        countrycode: 'NL', // mapped from 'Nederland'
        contact: 'Jan Visser',
        contactemail: 'jan@acme.nl',
        contactphone: '+31612345678', // 0-prefix swapped for +31
      },
    });

    // Opmerking lands as a company event by the importing user
    expect(h.prisma.companyEvent.create).toHaveBeenCalledWith({
      data: {
        companyId: 100,
        userId: 42,
        type: 'comment',
        content: 'Warm contact, terugbellen',
      },
    });

    // Contact user created, unverified, in the companyadmin group
    const userData = h.prisma.user.create.mock.calls[0][0].data;
    expect(userData).toMatchObject({
      email: 'jan@acme.nl',
      displayName: 'Jan Visser',
      companyId: 100,
      verified: false,
    });
    expect(userData.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(h.prisma.userInGroup.create).toHaveBeenCalledWith({
      data: { userId: 200, groupId: 30 },
    });

    expect(res.data.details).toEqual([
      { company: 'Acme BV', status: 'imported', companyId: 100, usersCreated: 1 },
    ]);
  });

  it('groups multiple rows of one company and creates a user per contact', async () => {
    const buffer = await buildXlsx([
      ['Acme BV', 'jan@acme.nl', 'Jan', 'V', '', '', '', '', '', '', ''],
      ['Acme BV', 'piet@acme.nl', 'Piet', 'B', '', '', '', '', '', '', ''],
    ]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(res.data.imported).toBe(1);
    expect(h.prisma.company.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.user.create).toHaveBeenCalledTimes(2);
    expect(res.data.details[0].usersCreated).toBe(2);
  });

  it('skips companies that already exist', async () => {
    h.prisma.company.findFirst.mockResolvedValue({ id: 1, name: 'Acme BV' });
    const buffer = await buildXlsx([
      ['Acme BV', 'jan@acme.nl', 'Jan', 'V', '', '', '', '', '', '', ''],
    ]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(res.data).toMatchObject({ imported: 0, skipped: 1 });
    expect(res.data.details[0]).toEqual({
      company: 'Acme BV',
      status: 'skipped',
      reason: 'Company already exists',
    });
    expect(h.prisma.company.create).not.toHaveBeenCalled();
  });

  it('links existing company-less users instead of recreating them', async () => {
    h.prisma.user.findUnique.mockResolvedValue({
      id: 9,
      email: 'jan@acme.nl',
      companyId: null,
    });
    const buffer = await buildXlsx([
      ['Acme BV', 'jan@acme.nl', 'Jan', 'V', '', '', '', '', '', '', ''],
    ]);
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
    const buffer = await buildXlsx([
      ['Acme BV', 'jan@acme.nl', 'Jan', 'V', '', '', '', '', '', '', ''],
    ]);
    const res = await vibe.importCompaniesFromExcel(buffer, 1);
    expect(h.prisma.user.update).not.toHaveBeenCalled();
    expect(res.data.details[0].usersCreated).toBe(0);
  });

  it.each([
    ['0612345678', '+31612345678'],
    ['612345678', '+31612345678'],
    ['201234567', '+31201234567'],
    ['+447700900000', '+447700900000'],
  ])('normalizes phone %s to %s', async (input, expected) => {
    const buffer = await buildXlsx([
      ['Acme BV', 'jan@acme.nl', 'Jan', 'V', input, '', '', '', '', '', ''],
    ]);
    await vibe.importCompaniesFromExcel(buffer, 1);
    expect(h.prisma.company.create.mock.calls[0][0].data.contactphone).toBe(expected);
  });

  it('keeps unknown countries as-is and addresses without house numbers whole', async () => {
    const buffer = await buildXlsx([
      ['Acme BV', 'jan@acme.nl', 'Jan', 'V', '', 'Zonder Nummer', '', 'Atlantis', '', '', ''],
    ]);
    await vibe.importCompaniesFromExcel(buffer, 1);
    const data = h.prisma.company.create.mock.calls[0][0].data;
    expect(data.countrycode).toBe('Atlantis');
    expect(data.address).toBe('Zonder Nummer');
    expect(data.housenumber).toBe('');
  });

  it('records per-company errors and keeps importing the rest', async () => {
    h.prisma.company.create
      .mockRejectedValueOnce(new Error('insert exploded'))
      .mockImplementation(async ({ data }: any) => ({ id: 101, ...data }));
    const buffer = await buildXlsx([
      ['Broken BV', 'x@broken.nl', 'X', 'Y', '', '', '', '', '', '', ''],
      ['Fine BV', 'ok@fine.nl', 'O', 'K', '', '', '', '', '', '', ''],
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
