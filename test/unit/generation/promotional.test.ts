import { describe, it, expect, vi, beforeEach } from 'vitest';
import { outbound } from '../../helpers/recording-mock';

/**
 * Pure unit tests for src/promotional.ts: ownership verification, the
 * promotional setup read/write flow, slug generation + brand sanitization,
 * sale crediting (idempotency, discount-code bookkeeping, sale mail),
 * admin accept/translate/resend flows and the admin dashboard listing.
 *
 * prisma/chatgpt/data/sharp/fs are mocked; Mail goes through the global
 * recording mock and is asserted with outbound.calls().
 */

const h = vi.hoisted(() => {
  // Deterministic module constants: PROMOTIONAL_CREDIT_AMOUNT is read at
  // import time, FRONTEND_URI at call time.
  process.env['PROMOTIONAL_CREDIT_AMOUNT'] = '2.5';
  process.env['FRONTEND_URI'] = 'https://front.test';
  return {
    prisma: {
      $queryRaw: vi.fn(),
      playlist: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      discountCode: {
        findFirst: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
      discountCodedUses: { aggregate: vi.fn() },
      paymentHasPlaylist: { findFirst: vi.fn(), update: vi.fn() },
      user: { findUnique: vi.fn() },
    },
    translateText: vi.fn(),
    clearPlaylistCache: vi.fn(async () => undefined),
    calcDecades: vi.fn(async () => undefined),
    fsMkdir: vi.fn(async () => undefined),
    fsWriteFile: vi.fn(async () => undefined),
    fsUnlink: vi.fn(async () => undefined),
    sharpToBuffer: vi.fn(async () => Buffer.from('processed-png')),
  };
});

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));
vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));
vi.mock('../../../src/chatgpt', () => ({
  ChatGPT: class {
    translateText = h.translateText;
  },
}));
vi.mock('../../../src/translation', () => ({
  default: class {
    allLocales = ['en', 'nl'];
  },
}));
vi.mock('../../../src/data', () => ({
  default: {
    getInstance: () => ({
      clearPlaylistCache: h.clearPlaylistCache,
      calculateSinglePlaylistDecadePercentages: h.calcDecades,
    }),
  },
}));
vi.mock('../../../src/utils', () => ({
  default: class {
    generateRandomString(_len?: number): string {
      return 'IMGID';
    }
  },
}));
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer: h.sharpToBuffer,
  })),
}));
vi.mock('fs/promises', () => ({
  mkdir: h.fsMkdir,
  writeFile: h.fsWriteFile,
  unlink: h.fsUnlink,
}));

import Promotional from '../../../src/promotional';

const promotional = Promotional.getInstance();
const FRONT = 'https://front.test';
const OWNER_ROW = {
  paymentDbId: 1,
  playlistDbId: 2,
  userId: 7,
  userEmail: 'owner@example.com',
  userLocale: 'nl',
};

function resetPrisma() {
  h.prisma.$queryRaw.mockReset();
  for (const model of [
    h.prisma.playlist,
    h.prisma.discountCode,
    h.prisma.discountCodedUses,
    h.prisma.paymentHasPlaylist,
    h.prisma.user,
  ]) {
    for (const fn of Object.values(model)) {
      (fn as any).mockReset();
    }
  }
}

beforeEach(() => {
  outbound.reset();
  resetPrisma();
  h.translateText.mockReset();
  h.clearPlaylistCache.mockClear();
  h.calcDecades.mockClear();
  h.fsMkdir.mockClear();
  h.fsWriteFile.mockClear();
  h.fsUnlink.mockClear();
  h.prisma.$queryRaw.mockResolvedValue([{ ...OWNER_ROW }]);
});

describe('Promotional.getPromotionalSetup', () => {
  it('rejects when ownership cannot be verified, passing the raw-query params', async () => {
    h.prisma.$queryRaw.mockResolvedValue([]);
    const res = await promotional.getPromotionalSetup('pay_1', 'uhash', 'pl_1');
    expect(res).toEqual({ success: false, error: 'Unauthorized' });
    // Tagged template call: values follow the strings array.
    expect(h.prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([
      'pay_1',
      'uhash',
      'pl_1',
    ]);
    expect(h.prisma.playlist.findFirst).not.toHaveBeenCalled();
  });

  it('errors when the playlist is missing', async () => {
    h.prisma.playlist.findFirst.mockResolvedValue(null);
    const res = await promotional.getPromotionalSetup('pay_1', 'uhash', 'pl_1');
    expect(res).toEqual({ success: false, error: 'Playlist not found' });
  });

  it('returns submitted setup with remaining discount balance', async () => {
    h.prisma.playlist.findFirst.mockResolvedValue({
      id: 2,
      name: 'PName',
      slug: 'pslug',
      image: 'img.png',
      customImage: '/public/custom.png',
      promotionalTitle: 'T',
      promotionalDescription: 'D',
      promotionalActive: 0,
      promotionalAccepted: 1,
      promotionalDeclined: null,
    });
    h.prisma.discountCode.findFirst.mockResolvedValue({
      code: 'AAAA-BBBB-CCCC-DDDD',
      amount: 10,
    });
    h.prisma.discountCodedUses.aggregate.mockResolvedValue({
      _sum: { amount: 4 },
    });

    const res = await promotional.getPromotionalSetup('pay_1', 'uhash', 'pl_1');

    expect(h.prisma.discountCodedUses.aggregate).toHaveBeenCalledWith({
      where: { discountCode: { promotional: true, promotionalUserId: 7 } },
      _sum: { amount: true },
    });
    expect(res).toEqual({
      success: true,
      data: {
        title: 'T',
        description: 'D',
        image: 'img.png',
        customImage: '/public/custom.png',
        active: false, // hasSubmitted -> reflects promotionalActive
        hasSubmitted: true,
        shareLink: `${FRONT}/product/pslug`,
        discountCode: 'AAAA-BBBB-CCCC-DDDD',
        discountBalance: 6,
        slug: 'pslug',
        playlistName: 'PName',
        accepted: true,
        declined: false,
      },
    });
  });

  it('defaults active=true on first-time setup and falls back to the playlistId share link', async () => {
    h.prisma.playlist.findFirst.mockResolvedValue({
      id: 2,
      name: 'PName',
      slug: null,
      image: 'img.png',
      customImage: null,
      promotionalTitle: null,
      promotionalDescription: null,
      promotionalActive: false,
      promotionalAccepted: null,
      promotionalDeclined: null,
    });
    h.prisma.discountCode.findFirst.mockResolvedValue(null);

    const res = await promotional.getPromotionalSetup('pay_1', 'uhash', 'pl_1');

    expect(h.prisma.discountCodedUses.aggregate).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({
      title: '',
      description: '',
      active: true,
      hasSubmitted: false,
      shareLink: `${FRONT}/product/pl_1`,
      discountCode: null,
      discountBalance: 0,
    });
  });
});

describe('Promotional.savePromotionalSetup', () => {
  const saveData = {
    title: 'Best Hitster Mix',
    description: 'My description',
    active: true,
    locale: 'de',
  };

  beforeEach(() => {
    h.prisma.playlist.findFirst.mockResolvedValue(null); // slug is free
    h.prisma.playlist.findUnique.mockResolvedValue({
      slug: 'old-slug',
      customImage: null,
    });
    h.prisma.playlist.update.mockResolvedValue({});
  });

  it('rejects unverified ownership', async () => {
    h.prisma.$queryRaw.mockResolvedValue([]);
    const res = await promotional.savePromotionalSetup(
      'pay_1',
      'uhash',
      'pl_1',
      saveData
    );
    expect(res).toEqual({ success: false, error: 'Unauthorized' });
    expect(h.prisma.playlist.update).not.toHaveBeenCalled();
  });

  it('sanitizes the brand name, slugifies and stores promotional fields', async () => {
    const res = await promotional.savePromotionalSetup(
      'pay_1',
      'uhash',
      'pl_1',
      saveData
    );
    expect(res).toEqual({ success: true });
    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl_1' },
      data: {
        promotionalTitle: 'Best Hitster Mix', // raw title is kept
        promotionalDescription: 'My description',
        promotionalActive: true,
        promotionalLocale: 'de',
        promotionalUserId: 7,
        featured: true,
        name: 'Best QRSong! Mix', // hitster -> QRSong!
        slug: 'best-qrsong-mix',
      },
    });
    // Old slug differs -> cache for it is cleared.
    expect(h.clearPlaylistCache).toHaveBeenCalledWith('pl_1', 'old-slug');
  });

  it('appends -2 when the base slug is taken by another playlist', async () => {
    h.prisma.playlist.findFirst
      .mockResolvedValueOnce({ id: 99 }) // base slug taken
      .mockResolvedValueOnce(null);
    await promotional.savePromotionalSetup('pay_1', 'uhash', 'pl_1', saveData);
    expect(h.prisma.playlist.update.mock.calls[0][0].data.slug).toBe(
      'best-qrsong-mix-2'
    );
    expect(h.prisma.playlist.findFirst).toHaveBeenCalledWith({
      where: { slug: 'best-qrsong-mix', playlistId: { not: 'pl_1' } },
    });
  });

  it('processes a base64 image, stores its path and deletes the old custom image', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue({
      slug: 'old-slug',
      customImage: '/public/playlist_images/old.png',
    });

    const res = await promotional.savePromotionalSetup('pay_1', 'uhash', 'pl_1', {
      ...saveData,
      image: 'data:image/png;base64,QUJD',
    });

    expect(res).toEqual({ success: true });
    expect(h.fsWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('playlist_images/IMGID.png'),
      Buffer.from('processed-png')
    );
    expect(h.fsUnlink).toHaveBeenCalledWith(
      expect.stringContaining('playlist_images/old.png')
    );
    expect(h.prisma.playlist.update.mock.calls[0][0].data.customImage).toBe(
      '/public/playlist_images/IMGID.png'
    );
  });

  it('skips image processing for non-data-URL images', async () => {
    await promotional.savePromotionalSetup('pay_1', 'uhash', 'pl_1', {
      ...saveData,
      image: 'https://cdn.example.com/img.png',
    });
    expect(h.fsWriteFile).not.toHaveBeenCalled();
    expect(
      h.prisma.playlist.update.mock.calls[0][0].data.customImage
    ).toBeUndefined();
  });

  it('returns a generic failure when the update throws', async () => {
    h.prisma.playlist.update.mockRejectedValue(new Error('db down'));
    const res = await promotional.savePromotionalSetup(
      'pay_1',
      'uhash',
      'pl_1',
      saveData
    );
    expect(res).toEqual({
      success: false,
      error: 'Failed to save promotional setup',
    });
  });
});

describe('Promotional.checkSlugAvailability', () => {
  it('rejects unverified ownership', async () => {
    h.prisma.$queryRaw.mockResolvedValue([]);
    const res = await promotional.checkSlugAvailability(
      'pay_1',
      'uhash',
      'pl_1',
      'Title'
    );
    expect(res).toEqual({
      success: false,
      available: false,
      slug: '',
      error: 'Unauthorized',
    });
  });

  it('reports a free, sanitized slug as available', async () => {
    h.prisma.playlist.findFirst.mockResolvedValue(null);
    const res = await promotional.checkSlugAvailability(
      'pay_1',
      'uhash',
      'pl_1',
      'Crazy Hitster Nights!'
    );
    expect(res).toEqual({
      success: true,
      available: true,
      slug: 'crazy-qrsong-nights',
    });
    expect(h.prisma.playlist.findFirst).toHaveBeenCalledWith({
      where: { slug: 'crazy-qrsong-nights', playlistId: { not: 'pl_1' } },
      select: { playlistId: true },
    });
  });

  it('reports a taken slug as unavailable', async () => {
    h.prisma.playlist.findFirst.mockResolvedValue({ playlistId: 'other' });
    const res = await promotional.checkSlugAvailability(
      'pay_1',
      'uhash',
      'pl_1',
      'Crazy Nights'
    );
    expect(res).toMatchObject({ success: true, available: false });
  });
});

describe('Promotional.creditPromotionalDiscount', () => {
  const PLAYLIST = {
    id: 2,
    playlistId: 'pl_1',
    name: 'PName',
    slug: 'pslug',
    promotionalActive: true,
    promotionalUserId: 7,
  };
  const CREATOR = {
    id: 7,
    email: 'creator@example.com',
    displayName: 'Creator',
    hash: 'chash',
    locale: 'de',
  };

  beforeEach(() => {
    h.prisma.playlist.findUnique.mockResolvedValue({ ...PLAYLIST });
    h.prisma.user.findUnique.mockResolvedValue({ ...CREATOR });
    h.prisma.paymentHasPlaylist.findFirst.mockImplementation(
      async (args: any) =>
        args.where.paymentId !== undefined
          ? { id: 5, amount: 2, promotionalCredited: false }
          : { payment: { paymentId: 'orig_pay' } }
    );
    h.prisma.discountCode.findFirst.mockResolvedValue({
      id: 3,
      code: 'CODE-1111-2222-3333',
      amount: 10,
    });
    h.prisma.discountCode.updateMany.mockResolvedValue({});
    h.prisma.paymentHasPlaylist.update.mockResolvedValue({});
    h.prisma.discountCodedUses.aggregate.mockResolvedValue({
      _sum: { amount: 4 },
    });
  });

  it('skips playlists that are not promotional', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue({
      ...PLAYLIST,
      promotionalActive: false,
    });
    const res = await promotional.creditPromotionalDiscount(2, 99);
    expect(res).toEqual({ success: true, credited: false });
    expect(h.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('skips when the creator user no longer exists', async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);
    const res = await promotional.creditPromotionalDiscount(2, 99);
    expect(res).toEqual({ success: true, credited: false });
    expect(h.prisma.discountCode.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent: skips already-credited payment lines', async () => {
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      id: 5,
      amount: 1,
      promotionalCredited: true,
    });
    const res = await promotional.creditPromotionalDiscount(2, 99);
    expect(res).toEqual({ success: true, credited: false });
    expect(h.prisma.discountCode.updateMany).not.toHaveBeenCalled();
    expect(outbound.calls('Mail')).toHaveLength(0);
  });

  it('credits per-quantity, marks the line credited and mails the creator', async () => {
    const res = await promotional.creditPromotionalDiscount(2, 99);

    expect(res).toEqual({ success: true, credited: true });
    expect(
      h.prisma.paymentHasPlaylist.findFirst.mock.calls[0][0].where
    ).toEqual({ paymentId: 99, playlistId: 2 });
    // 2.5 * quantity(2) = 5 on top of the existing 10.
    expect(h.prisma.discountCode.updateMany).toHaveBeenCalledWith({
      where: { promotional: true, promotionalUserId: 7 },
      data: { amount: 15 },
    });
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: {
        promotionalCredited: true,
        promotionalCreditedAt: expect.any(Date),
      },
    });

    const mails = outbound.calls('Mail', 'sendPromotionalSaleEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'creator@example.com',
      'Creator',
      'PName',
      5, // credited amount
      11, // new balance: 15 - 4 used
      'CODE-1111-2222-3333',
      `${FRONT}/de/product/pslug`,
      `${FRONT}/de/promotional/orig_pay/chash/pl_1`,
      'de',
      2,
    ]);
  });

  it('creates a discount code on the fly, which adds an extra initial 2.50 on top of the credit (suspected bug)', async () => {
    // fetchOrCreateDiscountCode's docblock says "create a new one with 0
    // balance" but it seeds amount=PROMOTIONAL_CREDIT_AMOUNT (src/promotional.ts
    // ~line 552-562). creditPromotionalDiscount then adds the sale credit on
    // top, so a first sale of quantity 1 yields a 5.00 balance, not 2.50.
    h.prisma.discountCode.findFirst.mockResolvedValue(null);
    h.prisma.discountCode.create.mockImplementation(async ({ data }: any) => ({
      id: 9,
      ...data,
    }));
    h.prisma.paymentHasPlaylist.findFirst.mockImplementation(
      async (args: any) =>
        args.where.paymentId !== undefined
          ? { id: 5, amount: 1, promotionalCredited: false }
          : null // no original payment -> no setup link
    );
    h.prisma.discountCodedUses.aggregate.mockResolvedValue({
      _sum: { amount: null },
    });

    const res = await promotional.creditPromotionalDiscount(2, 99);

    expect(res).toEqual({ success: true, credited: true });
    expect(h.prisma.discountCode.create).toHaveBeenCalledWith({
      data: {
        code: expect.stringMatching(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/),
        amount: 2.5,
        description: 'Promotional discount for user: Creator',
        promotional: true,
        promotionalUserId: 7,
        general: false,
        digital: false,
      },
    });
    // 2.5 (seeded) + 2.5 (credit) = 5 after a single first sale.
    expect(h.prisma.discountCode.updateMany).toHaveBeenCalledWith({
      where: { promotional: true, promotionalUserId: 7 },
      data: { amount: 5 },
    });
    // Without an original payment the mail still goes out, with a null setup link.
    const mails = outbound.calls('Mail', 'sendPromotionalSaleEmail');
    expect(mails[0].args[7]).toBeNull();
  });

  it('returns a failure result when prisma throws', async () => {
    h.prisma.playlist.findUnique.mockRejectedValue(new Error('db down'));
    const res = await promotional.creditPromotionalDiscount(2, 99);
    expect(res).toEqual({
      success: false,
      credited: false,
      error: 'Failed to credit discount',
    });
  });
});

describe('Promotional.fetchOrCreateDiscountCode', () => {
  it('returns the existing code untouched', async () => {
    h.prisma.discountCode.findFirst.mockResolvedValue({
      id: 3,
      code: 'EXIS-TING-CODE-0001',
      amount: 12.5,
    });
    const res = await promotional.fetchOrCreateDiscountCode(7, 'Creator');
    expect(res).toEqual({ id: 3, code: 'EXIS-TING-CODE-0001', amount: 12.5 });
    expect(h.prisma.discountCode.create).not.toHaveBeenCalled();
  });

  it('falls back to the user id in the description when no name or email is known', async () => {
    h.prisma.discountCode.findFirst.mockResolvedValue(null);
    h.prisma.discountCode.create.mockImplementation(async ({ data }: any) => ({
      id: 9,
      ...data,
    }));
    const res = await promotional.fetchOrCreateDiscountCode(7);
    expect(h.prisma.discountCode.create.mock.calls[0][0].data.description).toBe(
      'Promotional discount for user ID: 7'
    );
    expect(res.amount).toBe(2.5);
    expect(res.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  });
});

describe('Promotional.getAllPromotionalPlaylists', () => {
  it('enriches playlists with user, payment, discount and sales data', async () => {
    h.prisma.playlist.findMany.mockResolvedValue([
      {
        id: 2,
        playlistId: 'pl_1',
        name: 'PName',
        slug: 'pslug',
        image: 'img.png',
        promotionalTitle: 'T',
        promotionalDescription: 'D',
        promotionalActive: true,
        promotionalAccepted: true,
        promotionalDeclined: false,
        promotionalLocale: 'en',
        promotionalUserId: 7,
        numberOfTracks: 100,
      },
      {
        id: 3,
        playlistId: 'pl_2',
        name: 'Orphan',
        slug: null,
        image: 'img2.png',
        promotionalTitle: null,
        promotionalDescription: null,
        promotionalActive: true,
        promotionalAccepted: null,
        promotionalDeclined: null,
        promotionalLocale: null,
        promotionalUserId: null,
        numberOfTracks: 50,
      },
    ]);
    h.prisma.user.findUnique.mockResolvedValue({
      email: 'creator@example.com',
      displayName: 'Creator',
      hash: 'chash',
    });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      payment: { paymentId: 'orig_pay' },
    });
    h.prisma.discountCode.findFirst.mockResolvedValue({
      code: 'CODE-1111-2222-3333',
      amount: 7.5,
    });

    const res = await promotional.getAllPromotionalPlaylists();

    expect(res.success).toBe(true);
    expect(h.prisma.playlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { promotionalActive: true },
            { promotionalUserId: { not: null } },
          ],
        },
        orderBy: { id: 'desc' },
      })
    );

    const [withUser, orphan] = res.data!;
    expect(withUser).toMatchObject({
      playlistId: 'pl_1',
      discountCode: 'CODE-1111-2222-3333',
      discountBalance: 7.5,
      totalSales: 3, // floor(7.5 / 2.5)
      setupLink: '/promotional/orig_pay/chash/pl_1',
    });
    expect(orphan).toMatchObject({
      playlistId: 'pl_2',
      user: null,
      payment: null,
      discountCode: null,
      discountBalance: 0,
      totalSales: 0,
      setupLink: null,
    });
  });

  it('returns an error result when the query fails', async () => {
    h.prisma.playlist.findMany.mockRejectedValue(new Error('db down'));
    expect(await promotional.getAllPromotionalPlaylists()).toEqual({
      success: false,
      error: 'Failed to get promotional playlists',
    });
  });
});

describe('Promotional.acceptPromotionalPlaylist', () => {
  const PLAYLIST = {
    id: 2,
    name: 'Old Name',
    slug: 'oldslug',
    promotionalTitle: 'Hitster Hits',
    promotionalDescription: 'Great hitster mix',
    promotionalLocale: 'nl',
    promotionalUserId: 7,
  };

  beforeEach(() => {
    h.prisma.playlist.findUnique.mockResolvedValue({ ...PLAYLIST });
    h.prisma.playlist.findFirst.mockResolvedValue(null); // slug free
    h.prisma.playlist.update.mockResolvedValue({});
    h.prisma.user.findUnique.mockResolvedValue({
      email: 'creator@example.com',
      displayName: 'Creator',
      hash: 'chash',
      locale: 'de',
    });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      payment: { paymentId: 'orig_pay' },
    });
    h.prisma.discountCode.findFirst.mockResolvedValue({
      id: 3,
      code: 'CODE-1111-2222-3333',
      amount: 10,
    });
    h.translateText.mockResolvedValue({
      en: 'Great hitster mix EN',
      nl: 'Geweldige mix NL',
    });
  });

  it('errors when the playlist is unknown', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue(null);
    expect(await promotional.acceptPromotionalPlaylist('pl_x')).toEqual({
      success: false,
      error: 'Playlist not found',
    });
  });

  it('translates, sanitizes every locale, updates name/slug and mails approval', async () => {
    const res = await promotional.acceptPromotionalPlaylist('pl_1');

    expect(res).toEqual({ success: true });
    // Source description is brand-sanitized before translation.
    expect(h.translateText).toHaveBeenCalledWith('Great QRSong! mix', [
      'en',
      'nl',
    ]);
    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl_1' },
      data: {
        promotionalAccepted: true,
        markedForMerchantCenter: true,
        // Translations are sanitized again post-translation.
        description_en: 'Great QRSong! mix EN',
        description_nl: 'Geweldige mix NL',
        name: 'QRSong! Hits',
        slug: 'qrsong-hits',
      },
    });
    expect(h.clearPlaylistCache).toHaveBeenCalledWith('pl_1', 'oldslug');
    expect(h.calcDecades).toHaveBeenCalledWith(2);

    const mails = outbound.calls('Mail', 'sendPromotionalApprovedEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'creator@example.com',
      'Creator',
      'Old Name', // name as fetched before the update
      'CODE-1111-2222-3333',
      `${FRONT}/product/qrsong-hits`, // share link uses the NEW slug
      `${FRONT}/promotional/orig_pay/chash/pl_1`,
      'de', // user locale wins over promotionalLocale
    ]);
  });

  it('accepts without translation when the description is empty, skipping the mail if no user is linked', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue({
      ...PLAYLIST,
      promotionalTitle: null,
      promotionalDescription: '   ',
      promotionalUserId: null,
    });

    const res = await promotional.acceptPromotionalPlaylist('pl_1');

    expect(res).toEqual({ success: true });
    expect(h.translateText).not.toHaveBeenCalled();
    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl_1' },
      data: { promotionalAccepted: true, markedForMerchantCenter: true },
    });
    expect(h.clearPlaylistCache).toHaveBeenCalledWith('pl_1', 'oldslug');
    expect(h.calcDecades).toHaveBeenCalledWith(2);
    expect(outbound.calls('Mail', 'sendPromotionalApprovedEmail')).toHaveLength(
      0
    );
  });

  it('still succeeds but skips the mail when no paid payment exists', async () => {
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
    const res = await promotional.acceptPromotionalPlaylist('pl_1');
    expect(res).toEqual({ success: true });
    expect(outbound.calls('Mail', 'sendPromotionalApprovedEmail')).toHaveLength(
      0
    );
  });

  it('propagates translation failures as an error result', async () => {
    h.translateText.mockRejectedValue(new Error('openai down'));
    const res = await promotional.acceptPromotionalPlaylist('pl_1');
    expect(res).toEqual({ success: false, error: 'openai down' });
    expect(h.prisma.playlist.update).not.toHaveBeenCalled();
  });
});

describe('Promotional.translateDescription', () => {
  it('errors when the playlist is unknown', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue(null);
    expect(await promotional.translateDescription('pl_x')).toEqual({
      success: false,
      error: 'Playlist not found',
    });
  });

  it('errors when there is nothing to translate', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue({
      id: 2,
      name: 'P',
      promotionalDescription: null,
      description_en: '  ',
    });
    expect(await promotional.translateDescription('pl_1')).toEqual({
      success: false,
      error: 'No description to translate',
    });
    expect(h.translateText).not.toHaveBeenCalled();
  });

  it('prefers description_en as the source and updates translations', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue({
      id: 2,
      name: 'P',
      promotionalDescription: 'old promo text',
      description_en: 'Edited admin text',
    });
    h.translateText.mockResolvedValue({ en: 'Edited EN', nl: 'Edited NL' });

    const res = await promotional.translateDescription('pl_1');

    expect(res).toEqual({ success: true });
    expect(h.translateText).toHaveBeenCalledWith('Edited admin text', [
      'en',
      'nl',
    ]);
    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { playlistId: 'pl_1' },
      data: {
        description_en: 'Edited EN',
        description_nl: 'Edited NL',
        markedForMerchantCenter: true,
      },
    });
    expect(h.clearPlaylistCache).toHaveBeenCalledWith('pl_1');
  });
});

describe('Promotional.resendApprovalEmail', () => {
  const APPROVED = {
    id: 2,
    name: 'PName',
    slug: 'pslug',
    promotionalAccepted: true,
    promotionalLocale: 'nl',
    promotionalUserId: 7,
  };

  beforeEach(() => {
    h.prisma.playlist.findUnique.mockResolvedValue({ ...APPROVED });
    h.prisma.user.findUnique.mockResolvedValue({
      email: 'creator@example.com',
      displayName: null,
      hash: 'chash',
      locale: null,
    });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      payment: { paymentId: 'orig_pay' },
    });
    h.prisma.discountCode.findFirst.mockResolvedValue({
      id: 3,
      code: 'CODE-1111-2222-3333',
      amount: 10,
    });
  });

  it.each([
    ['playlist missing', { playlist: null }, 'Playlist not found'],
    [
      'not approved',
      { playlist: { ...APPROVED, promotionalAccepted: false } },
      'Playlist is not approved yet',
    ],
    [
      'no promotional user',
      { playlist: { ...APPROVED, promotionalUserId: null } },
      'No promotional user associated with this playlist',
    ],
  ] as const)('rejects: %s', async (_label, setup, expectedError) => {
    h.prisma.playlist.findUnique.mockResolvedValue(setup.playlist as any);
    expect(await promotional.resendApprovalEmail('pl_1')).toEqual({
      success: false,
      error: expectedError,
    });
    expect(outbound.calls('Mail')).toHaveLength(0);
  });

  it('rejects when the user record is gone', async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);
    expect(await promotional.resendApprovalEmail('pl_1')).toEqual({
      success: false,
      error: 'User not found',
    });
  });

  it('rejects when there is no paid payment', async () => {
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
    expect(await promotional.resendApprovalEmail('pl_1')).toEqual({
      success: false,
      error: 'No paid payment found for this playlist',
    });
  });

  it('resends the approval mail with email-prefix fallback name and promotionalLocale fallback', async () => {
    const res = await promotional.resendApprovalEmail('pl_1');
    expect(res).toEqual({ success: true });

    const mails = outbound.calls('Mail', 'sendPromotionalApprovedEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'creator@example.com',
      'creator', // displayName null -> local part of the email
      'PName',
      'CODE-1111-2222-3333',
      `${FRONT}/product/pslug`,
      `${FRONT}/promotional/orig_pay/chash/pl_1`,
      'nl', // user.locale null -> promotionalLocale
    ]);
  });
});
