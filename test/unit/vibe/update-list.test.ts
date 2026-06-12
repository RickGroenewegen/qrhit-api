/**
 * Unit tests for src/vibe.ts — updateCompanyList multipart handling:
 * field coercion (booleans, numbers, dates, locale descriptions),
 * background uploads/clearing and cache invalidation.
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

import Vibe from '../../../src/vibe';

const vibe = Vibe.getInstance();

const LIST = {
  id: 2,
  companyId: 1,
  name: 'Old name',
  slug: 'old-slug',
  background: 'old-bg.png',
  background2: null,
  votingBackground: null,
  votingLogo: null,
};

function field(fieldname: string, value: any) {
  return { type: 'field', fieldname, value };
}

function file(fieldname: string, filename: string, buffer = Buffer.from('x')) {
  return {
    type: 'file',
    fieldname,
    filename,
    toBuffer: vi.fn(async () => buffer),
  };
}

function makeRequest(parts: any[]) {
  return {
    parts: () =>
      (async function* () {
        for (const p of parts) yield p;
      })(),
  };
}

beforeEach(() => {
  resetAll();
  h.prisma.companyList.findUnique.mockResolvedValue({ ...LIST });
  h.prisma.companyList.update.mockImplementation(async ({ data }: any) => ({
    ...LIST,
    ...data,
    slug: 'old-slug',
  }));
  h.fs.mkdir.mockResolvedValue(undefined);
  h.fs.writeFile.mockResolvedValue(undefined);
});

describe('updateCompanyList — validation', () => {
  it('rejects invalid ids', async () => {
    expect(await vibe.updateCompanyList(NaN, 2, makeRequest([]))).toMatchObject({
      success: false,
      error: 'Invalid company or list ID provided',
    });
    expect(await vibe.updateCompanyList(1, NaN, makeRequest([]))).toMatchObject({
      success: false,
    });
  });

  it('rejects unknown lists and foreign lists', async () => {
    h.prisma.companyList.findUnique.mockResolvedValueOnce(null);
    expect(await vibe.updateCompanyList(1, 2, makeRequest([]))).toMatchObject({
      success: false,
      error: 'Company list not found',
    });
    h.prisma.companyList.findUnique.mockResolvedValueOnce({ ...LIST, companyId: 8 });
    expect(await vibe.updateCompanyList(1, 2, makeRequest([]))).toMatchObject({
      success: false,
      error: 'List does not belong to this company',
    });
  });
});

describe('updateCompanyList — field coercion', () => {
  it('returns the original list when nothing was provided', async () => {
    const res = await vibe.updateCompanyList(1, 2, makeRequest([]));
    expect(res.success).toBe(true);
    expect(res.data.list).toEqual(LIST);
    expect(res.data.backgroundFilename).toBe('old-bg.png');
    expect(h.prisma.companyList.update).not.toHaveBeenCalled();
    expect(h.cacheDel).not.toHaveBeenCalled();
  });

  it('coerces every supported field type into the update payload', async () => {
    const res = await vibe.updateCompanyList(
      1,
      2,
      makeRequest([
        field('name', 'New name'),
        field('description_en', 'EN text'),
        field('description_xx', 'not a locale'), // ignored
        field('playlistSource', 'spotify'),
        field('playlistUrl', 'https://sp/p'),
        field('qrColor', '#111111'),
        field('textColor', '#222222'),
        field('buttonBackgroundColor', '#333333'),
        field('buttonTextColor', '#444444'),
        field('languages', 'nl,en'),
        field('hideCircle', 'true'),
        field('showNames', 'false'),
        field('forceTemplate', ''), // empty string -> null
        field('addBirthdayNumber1', 'true'),
        field('hideBirthdayNumber1', 'false'),
        field('background', ''), // clear background
        field('background2', ''), // clear backside
        field('numberOfCards', '50'),
        field('numberOfTracks', 'abc'), // invalid -> ignored
        field('minimumNumberOfTracks', '  '), // blank -> null
        field('startAt', 'null'), // literal null -> null
        field('endAt', '2026-05-01T00:00:00Z'),
        field('status', 'box'), // explicitly not applied
      ])
    );
    expect(res.success).toBe(true);

    const data = h.prisma.companyList.update.mock.calls[0][0].data;
    expect(data).toEqual({
      name: 'New name',
      description_en: 'EN text',
      playlistSource: 'spotify',
      playlistUrl: 'https://sp/p',
      qrColor: '#111111',
      textColor: '#222222',
      buttonBackgroundColor: '#333333',
      buttonTextColor: '#444444',
      languages: 'nl,en',
      hideCircle: true,
      showNames: false,
      forceTemplate: null,
      addBirthdayNumber1: true,
      hideBirthdayNumber1: false,
      background: null,
      background2: null,
      numberOfCards: 50,
      minimumNumberOfTracks: null,
      startAt: null,
      endAt: new Date('2026-05-01T00:00:00Z'),
    });
    expect('status' in data).toBe(false);
    expect('numberOfTracks' in data).toBe(false);
    expect('description_xx' in data).toBe(false);

    // Cleared backgrounds are reflected in the response filenames
    expect(res.data.backgroundFilename).toBeNull();
    expect(res.data.background2Filename).toBeNull();

    // Cache invalidated by slug
    expect(h.cacheDel).toHaveBeenCalledWith('companyListByDomain:old-slug');
  });

  it('parses valid numbers and dates, nulls unparseable dates', async () => {
    await vibe.updateCompanyList(
      1,
      2,
      makeRequest([
        field('minimumNumberOfTracks', '7'),
        field('numberOfTracks', '12'),
        field('startAt', '2026-02-03T08:00:00Z'),
        field('endAt', 'definitely-not-a-date'),
      ])
    );
    const data = h.prisma.companyList.update.mock.calls[0][0].data;
    expect(data).toEqual({
      minimumNumberOfTracks: 7,
      numberOfTracks: 12,
      startAt: new Date('2026-02-03T08:00:00Z'),
      endAt: null,
    });
  });

  it('ignores negative card counts', async () => {
    const res = await vibe.updateCompanyList(
      1,
      2,
      makeRequest([field('numberOfCards', '-5')])
    );
    // Nothing valid remained -> treated as a no-op update
    expect(res.success).toBe(true);
    expect(h.prisma.companyList.update).not.toHaveBeenCalled();
  });
});

describe('updateCompanyList — file uploads', () => {
  it('stores uploaded backgrounds and drains unexpected file fields', async () => {
    const bg = file('background', 'pic.png');
    const stray = file('unexpected', 'evil.bin');
    const res = await vibe.updateCompanyList(1, 2, makeRequest([bg, stray]));
    expect(res.success).toBe(true);

    const data = h.prisma.companyList.update.mock.calls[0][0].data;
    expect(data).toEqual({ background: 'card_background_2_RANDOM32.png' });
    expect(res.data.backgroundFilename).toBe('card_background_2_RANDOM32.png');

    // The unknown file stream is consumed so the request cannot hang
    expect(stray.toBuffer).toHaveBeenCalled();
  });

  it('handles all four image slots', async () => {
    h.utils.generateRandomString
      .mockReturnValueOnce('R1')
      .mockReturnValueOnce('R2')
      .mockReturnValueOnce('R3')
      .mockReturnValueOnce('R4');
    await vibe.updateCompanyList(
      1,
      2,
      makeRequest([
        file('background', 'a.png'),
        file('background2', 'b.jpg'),
        file('votingBackground', 'c.webp'),
        file('votingLogo', 'd.png'),
      ])
    );
    const data = h.prisma.companyList.update.mock.calls[0][0].data;
    expect(data).toEqual({
      background: 'card_background_2_R1.png',
      background2: 'card_background2_2_R2.jpg',
      votingBackground: 'card_votingBackground_2_R3.webp',
      votingLogo: 'card_votingLogo_2_R4.png',
    });
  });

  it('keeps the old background when the upload fails to process', async () => {
    const bad = {
      type: 'file',
      fieldname: 'background',
      filename: 'x.png',
      toBuffer: vi.fn(async () => {
        throw new Error('broken stream');
      }),
    };
    const res = await vibe.updateCompanyList(1, 2, makeRequest([bad]));
    expect(res.success).toBe(true);
    // Processing failed -> no update happened, original filename returned
    expect(h.prisma.companyList.update).not.toHaveBeenCalled();
    expect(res.data.backgroundFilename).toBe('old-bg.png');
  });
});

describe('updateCompanyList — errors', () => {
  it('maps prisma update failures', async () => {
    h.prisma.companyList.update.mockRejectedValue(new Error('db'));
    const res = await vibe.updateCompanyList(
      1,
      2,
      makeRequest([field('name', 'X')])
    );
    expect(res).toMatchObject({
      success: false,
      error: 'Error updating company list',
    });
  });
});
