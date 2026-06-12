import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PRINTER_TYPE } from '../../../src/config/constants';

/**
 * Unit tests for src/resellers.ts payload mapping and validation logic.
 * Every collaborator (prisma, designer, music registry, data, order,
 * generator, cache, utils) is mocked; assertions focus on how reseller
 * input is validated and translated into Payment/PaymentHasPlaylist rows,
 * preview payloads and status responses.
 */

const h = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  return {
    cacheStore,
    cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string) => {
      cacheStore.set(key, value);
    }),
    cacheDel: vi.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
    recognizeUrl: vi.fn(),
    getPlaylistFromUrl: vi.fn(),
    getTracksFromUrl: vi.fn(),
    uploadBackgroundImage: vi.fn(),
    uploadBackgroundBackImage: vi.fn(),
    uploadLogoImage: vi.fn(),
    storeUser: vi.fn(async () => 501),
    storePlaylists: vi.fn(async () => [601]),
    areAllTracksManuallyChecked: vi.fn(async () => true),
    getOrderType: vi.fn(async () => ({ id: 7 })),
    queueGenerate: vi.fn(),
    generateRandomString: vi.fn((len: number) => 'R'.repeat(len)),
    prisma: {
      payment: {
        create: vi.fn(async () => ({ id: 42 })),
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(),
      },
      resellerMedia: {
        findFirst: vi.fn(),
        findMany: vi.fn(async () => []),
        create: vi.fn(),
        createMany: vi.fn(),
      },
      userInGroup: {
        findFirst: vi.fn(async () => ({ userId: 1 })),
      },
    },
  };
});

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({ get: h.cacheGet, set: h.cacheSet, del: h.cacheDel }),
  },
}));

vi.mock('../../../src/designer', () => ({
  default: {
    getInstance: () => ({
      uploadBackgroundImage: h.uploadBackgroundImage,
      uploadBackgroundBackImage: h.uploadBackgroundBackImage,
      uploadLogoImage: h.uploadLogoImage,
    }),
  },
}));

vi.mock('../../../src/services/MusicServiceRegistry', () => ({
  default: {
    getInstance: () => ({
      recognizeUrl: h.recognizeUrl,
      getPlaylistFromUrl: h.getPlaylistFromUrl,
      getTracksFromUrl: h.getTracksFromUrl,
    }),
  },
}));

vi.mock('../../../src/data', () => ({
  default: {
    getInstance: () => ({
      storeUser: h.storeUser,
      storePlaylists: h.storePlaylists,
      areAllTracksManuallyChecked: h.areAllTracksManuallyChecked,
    }),
  },
}));

vi.mock('../../../src/order', () => ({
  default: { getInstance: () => ({ getOrderType: h.getOrderType }) },
}));

vi.mock('../../../src/generator', () => ({
  default: { getInstance: () => ({ queueGenerate: h.queueGenerate }) },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    generateRandomString = h.generateRandomString;
  },
}));

import Resellers from '../../../src/resellers';

const resellers = Resellers.getInstance();

const resellerUser = {
  id: 9,
  email: 'shop@example.com',
  displayName: 'Shop BV',
} as any;

function recognizedPlaylist() {
  h.recognizeUrl.mockReturnValue({
    recognized: true,
    serviceType: 'spotify',
    playlistId: 'pl-abc',
  });
  h.getPlaylistFromUrl.mockResolvedValue({
    success: true,
    serviceType: 'spotify',
    data: {
      id: 'pl-abc',
      name: 'Hits',
      description: 'desc',
      imageUrl: 'http://img',
      trackCount: 120,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cacheStore.clear();
  h.prisma.payment.create.mockResolvedValue({ id: 42 });
  h.prisma.userInGroup.findFirst.mockResolvedValue({ userId: 1 });
  h.storeUser.mockResolvedValue(501);
  h.storePlaylists.mockResolvedValue([601]);
  h.getOrderType.mockResolvedValue({ id: 7 });
  h.generateRandomString.mockImplementation((len: number) => 'R'.repeat(len));
});

describe('uploadMedia', () => {
  it('routes each media type to the matching designer upload', async () => {
    h.uploadBackgroundImage.mockResolvedValueOnce({ success: true, filename: 'f.png' });
    h.prisma.resellerMedia.create.mockResolvedValueOnce({ id: 11 });
    expect(await resellers.uploadMedia(9, 'b64', 'background')).toEqual({
      success: true,
      data: { mediaId: 11, type: 'background' },
    });

    h.uploadBackgroundBackImage.mockResolvedValueOnce({ success: true, filename: 'b.png' });
    h.prisma.resellerMedia.create.mockResolvedValueOnce({ id: 12 });
    expect(await resellers.uploadMedia(9, 'b64', 'background_back')).toEqual({
      success: true,
      data: { mediaId: 12, type: 'background_back' },
    });

    h.uploadLogoImage.mockResolvedValueOnce({ success: true, filename: 'l.png' });
    h.prisma.resellerMedia.create.mockResolvedValueOnce({ id: 13 });
    expect(await resellers.uploadMedia(9, 'b64', 'logo')).toEqual({
      success: true,
      data: { mediaId: 13, type: 'logo' },
    });

    expect(h.prisma.resellerMedia.create).toHaveBeenLastCalledWith({
      data: { userId: 9, mediaType: 'logo', filename: 'l.png' },
    });
  });

  it('propagates upload failures without touching the database', async () => {
    h.uploadBackgroundImage.mockResolvedValueOnce({ success: false, error: 'too big' });
    expect(await resellers.uploadMedia(9, 'b64', 'background')).toEqual({
      success: false,
      error: 'too big',
    });
    expect(h.prisma.resellerMedia.create).not.toHaveBeenCalled();
  });
});

describe('createOrder', () => {
  it('rejects unrecognized playlist URLs', async () => {
    h.recognizeUrl.mockReturnValue({ recognized: false });
    const result = await resellers.createOrder(resellerUser, {
      playlistUrl: 'http://nope',
      design: {},
    });
    expect(result).toEqual({
      success: false,
      error: 'URL not recognized as a supported music service',
    });
    expect(h.getPlaylistFromUrl).not.toHaveBeenCalled();
  });

  it('propagates playlist fetch failures', async () => {
    h.recognizeUrl.mockReturnValue({ recognized: true, playlistId: 'x' });
    h.getPlaylistFromUrl.mockResolvedValue({ success: false, error: 'rate limited' });
    const result = await resellers.createOrder(resellerUser, {
      playlistUrl: 'http://spotify',
      design: {},
    });
    expect(result).toEqual({ success: false, error: 'rate limited' });
  });

  it('rejects background media IDs that do not belong to the user or presets', async () => {
    recognizedPlaylist();
    h.prisma.resellerMedia.findFirst.mockResolvedValue(null);
    const result = await resellers.createOrder(resellerUser, {
      playlistUrl: 'http://spotify',
      design: { background: 1234 },
    });
    expect(result).toEqual({
      success: false,
      error: 'Invalid background media ID: 1234',
    });
    expect(h.prisma.payment.create).not.toHaveBeenCalled();
  });

  it('rejects media of the wrong type even when it exists', async () => {
    recognizedPlaylist();
    // Found for the user but typed as logo, requested as background
    h.prisma.resellerMedia.findFirst.mockResolvedValue({
      id: 5,
      mediaType: 'logo',
      filename: 'l.png',
    });
    const result = await resellers.createOrder(resellerUser, {
      playlistUrl: 'http://spotify',
      design: { background: 5 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid background media ID');
  });

  it('creates a zero-priced paid payment with reseller defaults and queues generation', async () => {
    recognizedPlaylist();
    const result = await resellers.createOrder(resellerUser, {
      playlistUrl: 'http://spotify',
      design: { hideCircle: true, selectedFont: 'Oswald' },
    });

    expect(result).toEqual({
      success: true,
      data: { orderId: '100000042', status: 'processing' },
    });

    expect(h.storeUser).toHaveBeenCalledWith({
      userId: 'shop@example.com',
      email: 'shop@example.com',
      displayName: 'Shop BV',
      locale: 'en',
    });
    expect(h.storePlaylists).toHaveBeenCalledWith(501, [
      expect.objectContaining({
        type: 'physical',
        playlistId: 'pl-abc',
        playlistName: 'Hits',
        numberOfTracks: 120,
        productType: 'cards',
        serviceType: 'spotify',
        price: 0,
      }),
    ]);
    expect(h.getOrderType).toHaveBeenCalledWith(120, false, 'cards', 'pl-abc', 'none');

    const createArgs = h.prisma.payment.create.mock.calls[0][0].data;
    expect(createArgs).toMatchObject({
      paymentId: 'reseller_RRRRRRRRRRRRRRRR',
      status: 'paid',
      totalPrice: 0,
      vibe: false,
      test: false,
      fullname: 'Shop BV',
      email: 'shop@example.com',
      user: { connect: { id: 501 } },
    });

    const php = createArgs.PaymentHasPlaylist.create[0];
    expect(php).toMatchObject({
      playlistId: 601,
      orderTypeId: 7,
      amount: 1,
      numberOfTracks: 120,
      type: 'physical',
      doubleSided: true,
      eco: false,
      printerType: PRINTER_TYPE.RESELLER,
      gamesEnabled: false,
      price: 0,
      hideCircle: true,
      // hideCircle without explicit qrBackgroundType => 'none'
      qrBackgroundType: 'none',
      // Oswald resolves to the full CSS family + its default size
      selectedFont: 'Oswald, Arial, sans-serif',
      selectedFontSize: '15px',
      qrColor: '#000000',
      qrBackgroundColor: '#ffffff',
      frontOpacity: 100,
      backOpacity: 50,
    });

    // Sequential order number derived from the payment DB id
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { orderId: '100000042' },
    });

    // PDF generation queued without the customer mail
    expect(h.queueGenerate).toHaveBeenCalledWith(
      'reseller_RRRRRRRRRRRRRRRR',
      '127.0.0.1',
      'pl-abc',
      false,
      true,
      false
    );
  });

  it('resolves numeric media IDs to stored filenames', async () => {
    recognizedPlaylist();
    h.prisma.resellerMedia.findFirst
      .mockResolvedValueOnce({ id: 21, mediaType: 'background', filename: 'bg.png' })
      .mockResolvedValueOnce({ id: 22, mediaType: 'background_back', filename: 'back.png' })
      .mockResolvedValueOnce({ id: 23, mediaType: 'logo', filename: 'logo.png' });

    const result = await resellers.createOrder(resellerUser, {
      playlistUrl: 'http://spotify',
      design: { background: 21, backgroundBack: 22, logo: 23 },
    });
    expect(result.success).toBe(true);

    const php = h.prisma.payment.create.mock.calls[0][0].data.PaymentHasPlaylist.create[0];
    expect(php.background).toBe('bg.png');
    expect(php.backgroundBack).toBe('back.png');
    expect(php.logo).toBe('logo.png');
    // No hideCircle and no explicit type => square QR background, Arial default
    expect(php.qrBackgroundType).toBe('square');
    expect(php.selectedFont).toBe('Arial, sans-serif');
    expect(php.selectedFontSize).toBe('16px');
  });

  it('accepts preset backgrounds owned by the admin user for both sides', async () => {
    recognizedPlaylist();
    // Not in user media, but found as admin preset
    h.prisma.resellerMedia.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 3,
        mediaType: 'preset_background',
        filename: 'background3.png',
      });

    const result = await resellers.createOrder(resellerUser, {
      playlistUrl: 'http://spotify',
      design: { background: 3 },
    });
    expect(result.success).toBe(true);
    const php = h.prisma.payment.create.mock.calls[0][0].data.PaymentHasPlaylist.create[0];
    expect(php.background).toBe('background3.png');
  });
});

describe('createPreview / getPreview', () => {
  it('caches a preview payload under a 32-char token and strips order-only fields', async () => {
    h.generateRandomString.mockReturnValueOnce('T'.repeat(32));

    const result = await resellers.createPreview(resellerUser, {
      design: {
        emoji: 'X',
        doubleSided: true,
        eco: true,
        fontColor: '#123456',
        selectedFont: 'Oswald',
      },
      sampleTrackName: 'My Song',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      previewUrlFront: `http://localhost:4200/en/card-preview-front/${'T'.repeat(32)}`,
      previewUrlBack: `http://localhost:4200/en/card-preview-back/${'T'.repeat(32)}`,
      token: 'T'.repeat(32),
    });

    const [key, value, ttl] = h.cacheSet.mock.calls[0];
    expect(key).toBe(`preview:${'T'.repeat(32)}`);
    expect(ttl).toBe(86400);
    const payload = JSON.parse(value);
    expect(payload).toMatchObject({
      fontColor: '#123456',
      selectedFont: 'Oswald, Arial, sans-serif',
      selectedFontSize: '15px',
      sampleTrackName: 'My Song',
      sampleTrackArtist: 'Sample Artist',
      sampleTrackYear: '2025',
    });
    // Order-only design fields must not leak into the preview
    expect(payload.emoji).toBeUndefined();
    expect(payload.doubleSided).toBeUndefined();
    expect(payload.eco).toBeUndefined();
  });

  it('builds absolute media URLs for numeric IDs in previews', async () => {
    h.prisma.resellerMedia.findFirst.mockResolvedValueOnce({
      id: 21,
      mediaType: 'background',
      filename: 'bg.png',
    });
    const result = await resellers.createPreview(resellerUser, {
      design: { background: 21 },
    });
    expect(result.success).toBe(true);
    const payload = JSON.parse(h.cacheSet.mock.calls[0][1]);
    expect(payload.background).toBe('http://localhost:3004/public/background/bg.png');
  });

  it('fails the preview when a media ID cannot be resolved', async () => {
    h.prisma.resellerMedia.findFirst.mockResolvedValue(null);
    const result = await resellers.createPreview(resellerUser, {
      design: { logo: 999 },
    });
    expect(result).toEqual({ success: false, error: 'Invalid logo media ID: 999' });
  });

  it('round-trips previews through the cache and 404s on expiry', async () => {
    h.cacheStore.set('preview:tok-1', JSON.stringify({ fontColor: '#fff' }));
    expect(await resellers.getPreview('tok-1')).toEqual({
      success: true,
      data: { fontColor: '#fff' },
    });
    expect(await resellers.getPreview('gone')).toEqual({
      success: false,
      error: 'Preview not found or expired',
    });
  });
});

describe('getOrderStatus', () => {
  function payment(overrides: any = {}) {
    return {
      id: 42,
      paymentId: 'reseller_x',
      status: 'paid',
      finalized: false,
      processedFirstTime: false,
      createdAt: new Date('2026-01-01'),
      PaymentHasPlaylist: [
        { filename: null, printerType: PRINTER_TYPE.RESELLER },
      ],
      ...overrides,
    };
  }

  it('returns not-found for unknown orders', async () => {
    h.prisma.payment.findFirst.mockResolvedValueOnce(null);
    expect(await resellers.getOrderStatus(9, '100000042')).toEqual({
      success: false,
      error: 'Order not found',
    });
  });

  it('hides non-reseller orders behind not-found', async () => {
    h.prisma.payment.findFirst.mockResolvedValueOnce(
      payment({
        PaymentHasPlaylist: [{ filename: 'x.pdf', printerType: PRINTER_TYPE.PRINTNBIND }],
      })
    );
    expect(await resellers.getOrderStatus(9, '100000042')).toEqual({
      success: false,
      error: 'Order not found',
    });
  });

  it('reports failed for unpaid orders', async () => {
    h.prisma.payment.findFirst.mockResolvedValueOnce(payment({ status: 'open' }));
    const result = await resellers.getOrderStatus(9, '100000042');
    expect(result.data?.status).toBe('failed');
  });

  it('reports processing with a manual-check comment while years are verified', async () => {
    h.prisma.payment.findFirst.mockResolvedValueOnce(
      payment({ processedFirstTime: true })
    );
    h.areAllTracksManuallyChecked.mockResolvedValueOnce(false);
    const result = await resellers.getOrderStatus(9, '100000042');
    expect(result.data).toMatchObject({
      status: 'processing',
      comment: 'Order years are being manually checked',
    });
  });

  it('reports finalizing when finalized but the PDF is not written yet', async () => {
    h.prisma.payment.findFirst.mockResolvedValueOnce(payment({ finalized: true }));
    const result = await resellers.getOrderStatus(9, '100000042');
    expect(result.data?.status).toBe('finalizing');
    expect(result.data?.pdfUrl).toBeUndefined();
  });

  it('reports done with the public PDF URL when the file exists', async () => {
    h.prisma.payment.findFirst.mockResolvedValueOnce(
      payment({
        finalized: true,
        PaymentHasPlaylist: [
          { filename: 'cards.pdf', printerType: PRINTER_TYPE.RESELLER },
        ],
      })
    );
    const result = await resellers.getOrderStatus(9, '100000042');
    expect(result.data).toMatchObject({
      status: 'done',
      pdfUrl: 'http://localhost:3004/public/pdf/cards.pdf',
    });
  });
});

describe('getPlaylistInfo', () => {
  it('combines playlist metadata with mapped track fields', async () => {
    h.getPlaylistFromUrl.mockResolvedValueOnce({
      success: true,
      serviceType: 'tidal',
      data: {
        id: 'p1',
        name: 'Mix',
        description: 'd',
        imageUrl: 'img',
        trackCount: 2,
      },
    });
    h.getTracksFromUrl.mockResolvedValueOnce({
      success: true,
      data: {
        tracks: [
          {
            name: 'A',
            artist: 'AA',
            album: 'Al',
            releaseDate: '2001',
            duration: 200,
            extra: 'must-not-leak',
          },
        ],
        skipped: { total: 0 },
      },
    });

    const result = await resellers.getPlaylistInfo('http://tidal/pl');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      serviceType: 'tidal',
      playlist: {
        id: 'p1',
        name: 'Mix',
        description: 'd',
        imageUrl: 'img',
        trackCount: 2,
      },
      tracks: [
        { name: 'A', artist: 'AA', album: 'Al', releaseDate: '2001', duration: 200 },
      ],
    });
    // skipped omitted when total is 0
    expect(result.data.skipped).toBeUndefined();
  });

  it('includes skip statistics when tracks were dropped', async () => {
    h.getPlaylistFromUrl.mockResolvedValueOnce({
      success: true,
      serviceType: 'spotify',
      data: { id: 'p', name: 'n', trackCount: 1 },
    });
    h.getTracksFromUrl.mockResolvedValueOnce({
      success: true,
      data: { tracks: [], skipped: { total: 3, local: 3 } },
    });
    const result = await resellers.getPlaylistInfo('u');
    expect(result.data.skipped).toEqual({ total: 3, local: 3 });
  });

  it('propagates playlist and track fetch failures', async () => {
    h.getPlaylistFromUrl.mockResolvedValueOnce({ success: false, error: 'nope' });
    expect(await resellers.getPlaylistInfo('u')).toEqual({
      success: false,
      error: 'nope',
    });

    h.getPlaylistFromUrl.mockResolvedValueOnce({
      success: true,
      data: { id: 'p', name: 'n', trackCount: 1 },
    });
    h.getTracksFromUrl.mockResolvedValueOnce({ success: false });
    expect(await resellers.getPlaylistInfo('u')).toEqual({
      success: false,
      error: 'Failed to fetch tracks',
    });
  });
});

describe('getPresetBackgrounds', () => {
  it('serves from cache when warm', async () => {
    h.cacheStore.set(
      'reseller:preset-backgrounds',
      JSON.stringify([{ mediaId: 1 }])
    );
    expect(await resellers.getPresetBackgrounds()).toEqual([{ mediaId: 1 }]);
    expect(h.prisma.resellerMedia.findMany).not.toHaveBeenCalled();
  });

  it('builds 20 preset entries with frontend URLs and caches them for 24h', async () => {
    h.prisma.resellerMedia.findMany.mockResolvedValueOnce([
      { id: 31, filename: 'background1.png' },
      { id: 32, filename: 'background2.png' },
    ]);

    const result = await resellers.getPresetBackgrounds();
    expect(result).toHaveLength(20);
    expect(result[0]).toEqual({
      mediaId: 31,
      thumbnail:
        'http://localhost:4200/assets/images/card_backgrounds/thumbnails/background1_thumb.png',
      full: 'http://localhost:4200/assets/images/card_backgrounds/background1.png',
    });
    // Filenames without a media row fall back to id 0
    expect(result[2].mediaId).toBe(0);

    const setCall = h.cacheSet.mock.calls.find(
      ([k]: any[]) => k === 'reseller:preset-backgrounds'
    );
    expect(setCall?.[2]).toBe(86400);
  });
});
