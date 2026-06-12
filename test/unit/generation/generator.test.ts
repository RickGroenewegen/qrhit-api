import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

/**
 * Pure unit tests for src/generator.ts — generate() orchestration,
 * queueGenerate() dispatch and finalizeOrder(). Every collaborator
 * (Prisma, Mollie, PDF, QR, Data, Cache, queue, ...) is faked through
 * the shared harness; Mail/Pushover are the global recording proxies
 * from test/setup.ts.
 */

vi.mock('../../../src/prisma', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.prisma } };
});
vi.mock('../../../src/utils', async () => {
  const { h } = await import('./harness');
  return { default: function () { return h.utils; } };
});
vi.mock('../../../src/data', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.data } };
});
vi.mock('../../../src/spotify', () => ({
  default: { getInstance: () => ({}) },
}));
vi.mock('../../../src/providers', async () => {
  const { h } = await import('./harness');
  return {
    MusicProviderFactory: {
      getInstance: () => ({ getProvider: h.getProvider }),
    },
  };
});
vi.mock('../../../src/qr', async () => {
  const { h } = await import('./harness');
  return { default: function () { return h.qr; } };
});
vi.mock('../../../src/pdf', async () => {
  const { h } = await import('./harness');
  return { default: function () { return h.pdf; } };
});
vi.mock('../../../src/order', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.order } };
});
vi.mock('../../../src/analytics', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.analytics } };
});
vi.mock('../../../src/discount', async () => {
  const { h } = await import('./harness');
  return { default: function () { return h.discount; } };
});
vi.mock('../../../src/cache', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.cache } };
});
vi.mock('../../../src/generatorQueue', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.queue } };
});
vi.mock('../../../src/bingo', () => ({
  default: { getInstance: () => ({}) },
}));
vi.mock('../../../src/appleStorefront', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.appleStorefront } };
});
vi.mock('../../../src/finalCheck', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.finalCheck } };
});
vi.mock('../../../src/mollie', () => ({
  default: function () { return { mocked: 'mollie' }; },
}));
vi.mock('../../../src/suggestion', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.suggestion } };
});
vi.mock('../../../src/musicfetch', async () => {
  const { h } = await import('./harness');
  return { default: { getInstance: () => h.musicfetch } };
});
vi.mock('cron', () => ({ CronJob: class {} }));

import { outbound } from '../../helpers/recording-mock';
import {
  h,
  resetGeneratorMocks,
  makePayment,
  makePlaylist,
  makeMollie,
  dbTracksFixture,
} from './harness';
import Generator from '../../../src/generator';

const gen = Generator.getInstance();
const ORIG_REDIS_URL = process.env['REDIS_URL'];

beforeEach(() => {
  outbound.reset();
  resetGeneratorMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIG_REDIS_URL === undefined) delete process.env['REDIS_URL'];
  else process.env['REDIS_URL'] = ORIG_REDIS_URL;
});

describe('generate()', () => {
  function arrange(paymentOver = {}, playlistOver = {}) {
    const payment = makePayment(paymentOver);
    const playlist = makePlaylist(playlistOver);
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([playlist]);
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: [{ id: 't1' }, { id: 't2' }] },
    });
    h.data.getTracks.mockResolvedValue([...dbTracksFixture]);
    const finalizeSpy = vi
      .spyOn(gen, 'finalizeOrder')
      .mockResolvedValue({ success: true });
    return { payment, playlist, mollie, finalizeSpy };
  }

  it('aborts before any processing when the payment is not successful', async () => {
    const { mollie } = arrange();
    mollie.checkPaymentStatus.mockResolvedValue({
      success: false,
      data: { status: 'open' },
    });

    await gen.generate('pay_1', '1.1.1.1', '', mollie);

    expect(mollie.getPayment).not.toHaveBeenCalled();
    expect(mollie.clearPDFs).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(outbound.records).toHaveLength(0);
  });

  it('aborts when the looked-up user does not match the paying user', async () => {
    const { mollie } = arrange();
    h.data.getUserByUserId.mockResolvedValue({ userId: 'somebody-else' });

    await gen.generate('pay_1', '1.1.1.1', '', mollie);

    expect(mollie.clearPDFs).not.toHaveBeenCalled();
    expect(h.data.getPlaylistsByPaymentId).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
  });

  it('processes a digital cards order end to end (mail, QR, analytics, status flags)', async () => {
    const { payment, playlist, mollie, finalizeSpy } = arrange();

    await gen.generate('pay_1', '9.9.9.9', '', mollie);

    // Old PDFs cleared before regeneration
    expect(mollie.clearPDFs).toHaveBeenCalledWith('pay_1');

    // Digital personal order: no invoice, main mail without attachment
    expect(h.order.createInvoice).not.toHaveBeenCalled();
    const mainMail = outbound.calls('Mail', 'sendEmail');
    expect(mainMail).toHaveLength(1);
    expect(mainMail[0].args).toEqual([
      'main_digital',
      payment,
      [playlist],
      '',
      '',
      '',
    ]);

    // Tracks stored with a 1-based order map in playlist order
    expect(h.data.storeTracks).toHaveBeenCalledTimes(1);
    const [plDbId, plId, tracks, orderMap, service, locale] =
      h.data.storeTracks.mock.calls[0];
    expect([plDbId, plId, service, locale]).toEqual([21, 'pl1', 'spotify', 'en']);
    expect(tracks.map((t: any) => t.id)).toEqual(['t1', 't2']);
    expect(orderMap.get('t1')).toBe(1);
    expect(orderMap.get('t2')).toBe(2);

    // QR codes: non-development => Lambda batch path
    expect(h.qr.generateQR).not.toHaveBeenCalled();
    expect(h.qr.generateQRLambda).toHaveBeenCalledTimes(2);
    const qrSubDir =
      h.prisma.payment.update.mock.calls[0][0].data.qrSubDir;
    expect(qrSubDir).toMatch(/^[0-9a-f]{16}$/);
    expect(h.qr.generateQRLambda).toHaveBeenCalledWith(
      `${process.env['API_URI']}/qr2/1/31`,
      `${process.env['PUBLIC_DIR']}/qr/${qrSubDir}/t1.png`,
      undefined
    );
    expect(h.utils.createDir).toHaveBeenCalledWith(
      `${process.env['PUBLIC_DIR']}/qr/${qrSubDir}`
    );

    // Analytics counters for a digital order
    expect(h.analytics.increaseCounter.mock.calls).toEqual(
      expect.arrayContaining([
        ['qr', 'generated', 2],
        ['purchase', 'digital', 1],
        ['finance', 'profit', 5],
        ['finance', 'turnover', 25],
      ])
    );

    // Payment status transitions, in order: qrSubDir then processedFirstTime
    expect(h.prisma.payment.update.mock.calls[0][0]).toEqual({
      where: { id: 11 },
      data: { qrSubDir },
    });
    expect(h.prisma.payment.update.mock.calls[1][0]).toMatchObject({
      where: { id: 11 },
      data: { processedFirstTime: true },
    });
    expect(
      h.prisma.payment.update.mock.calls[1][0].data.processedFirstTimeAt
    ).toBeInstanceOf(Date);

    // Tracks not all manually checked => no finalize yet
    expect(finalizeSpy).not.toHaveBeenCalled();

    // KA-CHING pushover with ip
    const push = outbound.calls('PushoverClient', 'sendMessage');
    expect(push).toHaveLength(1);
    expect(push[0].args[0].title).toBe('KA-CHING! € 5 verdiend!');
    expect(push[0].args[0].message).toBe(
      'Rick Tester (NL) heeft 1 set(s) met in totaal 2 kaarten besteld voor totaal € 25.'
    );
    expect(push[0].args[1]).toBe('9.9.9.9');
  });

  it('truncates oversized playlists to MAX_CARDS (digital) and MAX_CARDS_PHYSICAL (physical)', async () => {
    const { mollie } = arrange();
    const many = Array.from({ length: 3005 }, (_, i) => ({ id: `t${i}` }));
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: many },
    });

    await gen.generate('pay_1', '1.1.1.1', '', mollie);
    expect(h.data.storeTracks.mock.calls[0][2]).toHaveLength(3000);

    resetGeneratorMocks();
    const physical = arrange({}, { orderType: 'physical' });
    const manyPhysical = Array.from({ length: 1005 }, (_, i) => ({
      id: `t${i}`,
    }));
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: manyPhysical },
    });

    await gen.generate('pay_1', '1.1.1.1', '', physical.mollie);
    expect(h.data.storeTracks.mock.calls[0][2]).toHaveLength(1000);
  });

  it('creates an invoice and physical analytics for a physical order', async () => {
    const { payment, mollie } = arrange({}, { orderType: 'physical' });

    await gen.generate('pay_1', '1.1.1.1', '', mollie);

    expect(h.order.createInvoice).toHaveBeenCalledWith(payment);
    const mainMail = outbound.calls('Mail', 'sendEmail');
    expect(mainMail[0].args[0]).toBe('main_physical');
    expect(mainMail[0].args[5]).toBe('/tmp/invoice-42.pdf');
    expect(h.analytics.increaseCounter.mock.calls).toEqual(
      expect.arrayContaining([
        ['purchase', 'physical', 1],
        ['purchase', 'cards', 2],
      ])
    );
  });

  it('creates an invoice for digital business orders', async () => {
    const { payment, mollie } = arrange({ isBusinessOrder: true });
    await gen.generate('pay_1', '1.1.1.1', '', mollie);
    expect(h.order.createInvoice).toHaveBeenCalledWith(payment);
    expect(outbound.calls('Mail', 'sendEmail')[0].args[0]).toBe('main_digital');
  });

  it('skipMainMail suppresses both the main mail and the pushover', async () => {
    const { mollie } = arrange();
    await gen.generate('pay_1', '1.1.1.1', '', mollie, false, true);
    expect(outbound.calls('Mail', 'sendEmail')).toHaveLength(0);
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('onlyProductMail suppresses the main mail but still sends the pushover', async () => {
    const { mollie } = arrange();
    await gen.generate('pay_1', '1.1.1.1', '', mollie, false, false, true);
    expect(outbound.calls('Mail', 'sendEmail')).toHaveLength(0);
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(1);
  });

  it('giftcard orders skip track storage/QR and always finalize', async () => {
    const { mollie, finalizeSpy } = arrange(
      { totalPrice: 55, shipping: 5 },
      { productType: 'giftcard', orderType: 'physical' }
    );

    await gen.generate('pay_1', '4.4.4.4', '', mollie);

    expect(h.data.storeTracks).not.toHaveBeenCalled();
    expect(h.qr.generateQRLambda).not.toHaveBeenCalled();
    // areAllTracksManuallyChecked default false, but giftcards finalize anyway
    expect(finalizeSpy).toHaveBeenCalledWith('pay_1', mollie, false, false);

    const push = outbound.calls('PushoverClient', 'sendMessage');
    expect(push[0].args[0].message).toBe(
      'Rick Tester (NL) heeft een cadeaubon van € 50.00 besteld.'
    );
  });

  it('finalizes a cards order when all tracks are manually checked, forwarding flags', async () => {
    const { mollie, finalizeSpy } = arrange();
    h.data.areAllTracksManuallyChecked.mockResolvedValue(true);

    await gen.generate('pay_1', '1.1.1.1', '', mollie, true, true, false);

    // skipMail = skipMainMail && !onlyProductMail = true
    expect(finalizeSpy).toHaveBeenCalledWith('pay_1', mollie, true, true);
  });

  it('stores the Apple Music storefront extracted from track links', async () => {
    const { payment, mollie } = arrange({}, { serviceType: 'apple_music' });
    h.provider.getStorefrontForLocale.mockReturnValue('nl');
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: {
        tracks: [
          { id: 't1', serviceLink: 'https://music.apple.com/de/album/x?i=1' },
          { id: 't2' },
        ],
      },
    });

    await gen.generate('pay_1', '1.1.1.1', '', mollie);

    expect(h.provider.getStorefrontForLocale).toHaveBeenCalledWith('en');
    expect(h.provider.getTracks).toHaveBeenCalledWith(
      'pl1',
      true,
      undefined,
      undefined,
      'nl'
    );
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: { appleStoreFront: 'de' },
    });
    expect(h.appleStorefront.setStorefront).toHaveBeenCalledWith(31, 'de');
    expect(payment.id).toBe(11); // sanity: same fixture flowed through
  });

  it('rejects when the music provider fails, before any payment update', async () => {
    const { mollie } = arrange();
    h.provider.getTracks.mockResolvedValue({
      success: false,
      error: 'rate limited',
    });

    await expect(
      gen.generate('pay_1', '1.1.1.1', '', mollie)
    ).rejects.toThrow('Failed to fetch tracks from spotify: rate limited');
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('uses the serial QR path in development', async () => {
    const { mollie } = arrange();
    process.env['ENVIRONMENT'] = 'development';
    try {
      await gen.generate('pay_1', '1.1.1.1', '', mollie);
    } finally {
      process.env['ENVIRONMENT'] = 'test';
    }
    expect(h.qr.generateQRLambda).not.toHaveBeenCalled();
    expect(h.qr.generateQR).toHaveBeenCalledTimes(2);
  });

  it('refreshPlaylists still refetches and stores tracks (refresh flag only logs)', async () => {
    const { mollie } = arrange();

    await gen.generate('pay_1', '1.1.1.1', 'pl1,plX', mollie);

    // Actual behavior: the refresh flag only flips a local `exists` variable
    // that is never read again — the fetch/store path is identical.
    expect(h.provider.getTracks).toHaveBeenCalledTimes(1);
    expect(h.data.storeTracks).toHaveBeenCalledTimes(1);
  });

  it('swallows MusicFetch processing failures (fire-and-forget)', async () => {
    const { mollie } = arrange();
    process.env['MUSICFETCH_API_KEY'] = 'mf-key';
    h.musicfetch.processPlaylistTracks.mockRejectedValue(
      new Error('musicfetch 503')
    );

    await gen.generate('pay_1', '1.1.1.1', '', mollie);

    await vi.waitFor(() => {
      expect(h.musicfetch.processPlaylistTracks).toHaveBeenCalledWith(21);
    });
    // Let the rejection propagate through the .catch handler; the test
    // failing with an unhandled rejection here would expose a regression.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('fires MusicFetch processing when the API key is configured', async () => {
    const { mollie } = arrange();
    process.env['MUSICFETCH_API_KEY'] = 'mf-key';

    await gen.generate('pay_1', '1.1.1.1', '', mollie);

    await vi.waitFor(() => {
      expect(h.musicfetch.processPlaylistTracks).toHaveBeenCalledWith(21);
    });
  });
});

describe('queueGenerate()', () => {
  beforeEach(() => {
    (gen as any).generatorQueue = null;
  });

  it('processes directly (returning "direct") when no queue is available', async () => {
    delete process.env['REDIS_URL'];
    const generateSpy = vi
      .spyOn(gen, 'generate')
      .mockResolvedValue(undefined);

    const id = await gen.queueGenerate(
      'pay_1',
      '1.2.3.4',
      'pl1',
      true,
      false,
      true,
      'UA-test'
    );

    expect(id).toBe('direct');
    expect(generateSpy).toHaveBeenCalledWith(
      'pay_1',
      '1.2.3.4',
      'pl1',
      expect.objectContaining({ mocked: 'mollie' }),
      true,
      false,
      true,
      'UA-test'
    );
    expect(h.queue.addGenerateJob).not.toHaveBeenCalled();
  });

  it('runs the checkPrinter completion callback inline on the direct path', async () => {
    delete process.env['REDIS_URL'];
    vi.spyOn(gen, 'generate').mockResolvedValue(undefined);

    await gen.queueGenerate('pay_1', '1.2.3.4', '', false, false, false, '', {
      type: 'checkPrinter',
      paymentId: 'pay_1',
      clientIp: '1.2.3.4',
      paymentHasPlaylistId: 31,
    });

    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: {
        eligableForPrinter: true,
        eligableForPrinterAt: expect.any(Date),
      },
    });
    expect(h.suggestion.checkIfReadyForPrinter).toHaveBeenCalledWith(
      'pay_1',
      '1.2.3.4'
    );
  });

  it('enqueues onto the generator queue when Redis is configured', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const generateSpy = vi
      .spyOn(gen, 'generate')
      .mockResolvedValue(undefined);

    const id = await gen.queueGenerate(
      'pay_2',
      '5.5.5.5',
      '',
      false,
      true,
      false,
      'UA'
    );

    expect(id).toBe('job-77');
    expect(generateSpy).not.toHaveBeenCalled();
    expect(h.queue.addGenerateJob).toHaveBeenCalledWith({
      paymentId: 'pay_2',
      ip: '5.5.5.5',
      refreshPlaylists: '',
      forceFinalize: false,
      skipMainMail: true,
      onlyProductMail: false,
      userAgent: 'UA',
      onCompleteData: undefined,
    });
  });
});

describe('finalizeOrder()', () => {
  it('bails out without touching the DB when the lock is held elsewhere', async () => {
    h.cache.acquireLock.mockResolvedValue(false);
    const mollie = makeMollie(makePayment());

    const res = await gen.finalizeOrder('pay_1', mollie);

    expect(res).toEqual({
      success: false,
      error: 'Order finalization already in progress',
    });
    expect(mollie.getPayment).not.toHaveBeenCalled();
    // Lock was never acquired, so it must not be released either
    expect(h.cache.releaseLock).not.toHaveBeenCalled();
  });

  it('refuses to re-finalize an already finalized payment (and releases the lock)', async () => {
    const mollie = makeMollie(makePayment({ finalized: true }));

    const res = await gen.finalizeOrder('pay_1', mollie);

    expect(res).toEqual({ success: false, error: 'Order already finalized' });
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.cache.releaseLock).toHaveBeenCalledWith('finalizeOrder:pay_1');
  });

  it('finalizes a digital order: creates missing items, generates the digital PDF and emails it', async () => {
    const payment = makePayment();
    const playlist = makePlaylist();
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([playlist]);
    h.prisma.paymentHasPlaylistItem.findMany
      .mockResolvedValueOnce([]) // backward-compat: nothing yet
      .mockResolvedValueOnce([{ id: 41, index: 1 }]);

    const res = await gen.finalizeOrder('pay_1', mollie);
    expect(res).toEqual({ success: true });

    expect(h.cache.acquireLock).toHaveBeenCalledWith('finalizeOrder:pay_1');
    expect(h.prisma.payment.update.mock.calls[0][0]).toMatchObject({
      where: { id: 11 },
      data: { finalized: true },
    });
    expect(
      h.prisma.payment.update.mock.calls[0][0].data.finalizedAt
    ).toBeInstanceOf(Date);

    expect(h.prisma.paymentHasPlaylistItem.createMany).toHaveBeenCalledWith({
      data: [{ paymentHasPlaylistId: 31, index: 1 }],
    });

    // Only the digital PDF is generated for digital orders
    expect(h.pdf.generatePDF).toHaveBeenCalledTimes(1);
    expect(h.pdf.generatePDF).toHaveBeenCalledWith(
      'pay_1_21_my_list_digital_cards_1.pdf',
      playlist,
      payment,
      'digital',
      'qsub',
      false,
      'printnbind',
      1
    );

    expect(h.prisma.paymentHasPlaylistItem.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: {
        filename: '',
        filenameDigital: 'pay_1_21_my_list_digital_cards_1.pdf',
      },
    });
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: {
        filename: '',
        filenameDigital: 'pay_1_21_my_list_digital_cards_1.pdf',
      },
    });

    const mails = outbound.calls('Mail', 'sendEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'digital',
      payment,
      [playlist],
      '',
      'pay_1_21_my_list_digital_cards_1.pdf',
      '',
      undefined,
    ]);

    // No physical playlists => printer window never opened
    const printerUpdates = h.prisma.payment.update.mock.calls.filter(
      (c) => c[0].data.canBeSentToPrinter
    );
    expect(printerUpdates).toHaveLength(0);
    expect(h.cache.releaseLock).toHaveBeenCalledWith('finalizeOrder:pay_1');
  });

  it('links bingo-enabled digital orders to My Account in the mail', async () => {
    const payment = makePayment();
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([
      makePlaylist({ gamesEnabled: true }),
    ]);
    h.prisma.paymentHasPlaylistItem.findMany.mockResolvedValue([
      { id: 41, index: 1 },
    ]);

    await gen.finalizeOrder('pay_1', mollie);

    const mails = outbound.calls('Mail', 'sendEmail');
    expect(mails[0].args[6]).toBe(
      `${process.env['FRONTEND_URI']}/en/my-account`
    );
  });

  it('finalizes a physical order: printer PDFs per copy, 36h printer window, finalized mail once', async () => {
    const payment = makePayment();
    const playlist = makePlaylist({ orderType: 'physical', amount: 2 });
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([playlist]);
    h.prisma.paymentHasPlaylistItem.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 41, index: 1 },
        { id: 42, index: 2 },
      ]);

    const before = Date.now();
    const res = await gen.finalizeOrder('pay_1', mollie);
    expect(res).toEqual({ success: true });

    // Two items created from amount
    expect(h.prisma.paymentHasPlaylistItem.createMany).toHaveBeenCalledWith({
      data: [
        { paymentHasPlaylistId: 31, index: 1 },
        { paymentHasPlaylistId: 31, index: 2 },
      ],
    });

    // digital + printer PDF per item = 4 generatePDF calls
    expect(h.pdf.generatePDF).toHaveBeenCalledTimes(4);
    expect(h.pdf.generatePDF).toHaveBeenCalledWith(
      'pay_1_21_my_list_printer_cards_2.pdf',
      playlist,
      payment,
      'printer',
      'qsub',
      false,
      'printnbind',
      2,
      false
    );

    // Printer window opens ~36h out
    const printerUpdate = h.prisma.payment.update.mock.calls.find(
      (c) => c[0].data.canBeSentToPrinter
    );
    expect(printerUpdate![0].where).toEqual({ id: 11 });
    const at = printerUpdate![0].data.canBeSentToPrinterAt as Date;
    expect(at).toBeInstanceOf(Date);
    expect(Math.abs(at.getTime() - (before + 36 * 3600 * 1000))).toBeLessThan(
      10000
    );

    // One finalized mail despite two copies, no digital mail
    const finalized = outbound.calls('Mail', 'sendFinalizedMail');
    expect(finalized).toHaveLength(1);
    expect(finalized[0].args).toEqual([
      payment,
      `${process.env['FRONTEND_URI']}/en/usersuggestions/pay_1/userhash/pl1/0`,
      playlist,
    ]);
    expect(outbound.calls('Mail', 'sendEmail')).toHaveLength(0);
  });

  it('skipMail suppresses both the digital and finalized mails', async () => {
    const payment = makePayment();
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([
      makePlaylist({ orderType: 'physical' }),
    ]);
    h.prisma.paymentHasPlaylistItem.findMany.mockResolvedValue([
      { id: 41, index: 1 },
    ]);

    await gen.finalizeOrder('pay_1', mollie, false, true);

    expect(outbound.calls('Mail', 'sendEmail')).toHaveLength(0);
    expect(outbound.calls('Mail', 'sendFinalizedMail')).toHaveLength(0);
  });

  it('selects printer templates: CompanyList override > vibe > schneiders', async () => {
    const cases = [
      {
        paymentOver: {},
        playlistOver: { orderType: 'physical', template: 'company_x' },
        expected: 'company_x',
      },
      {
        paymentOver: { vibe: true },
        playlistOver: { orderType: 'physical' },
        expected: 'printer_vibe',
      },
      {
        paymentOver: {},
        playlistOver: { orderType: 'physical', printerType: 'schneiders' },
        expected: 'schneiders',
      },
    ];

    for (const { paymentOver, playlistOver, expected } of cases) {
      resetGeneratorMocks();
      const payment = makePayment(paymentOver);
      const mollie = makeMollie(payment);
      h.data.getPlaylistsByPaymentId.mockResolvedValue([
        makePlaylist(playlistOver),
      ]);
      h.prisma.paymentHasPlaylistItem.findMany.mockResolvedValue([
        { id: 41, index: 1 },
      ]);

      await gen.finalizeOrder('pay_1', mollie);

      const printerCall = h.pdf.generatePDF.mock.calls.find((c) =>
        (c[0] as string).includes('_printer')
      );
      expect(printerCall![3]).toBe(expected);
    }
  });

  it('US + double-sided + eco + sheets order uses the matching templates and filenames', async () => {
    const payment = makePayment({ countrycode: 'US' });
    const playlist = makePlaylist({
      orderType: 'physical',
      doubleSided: 1,
      eco: 1,
      subType: 'sheets',
    });
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([playlist]);
    h.prisma.paymentHasPlaylistItem.findMany.mockResolvedValue([
      { id: 41, index: 1 },
    ]);

    await gen.finalizeOrder('pay_1', mollie);

    expect(h.pdf.generatePDF).toHaveBeenCalledWith(
      'pay_1_21_my_list_digital_sheets_eco_1.pdf',
      playlist,
      payment,
      'digital_double_us',
      'qsub',
      true,
      'printnbind',
      1
    );
    expect(h.pdf.generatePDF).toHaveBeenCalledWith(
      'pay_1_21_my_list_printer_sheets_eco_1.pdf',
      playlist,
      payment,
      'printer_sheets',
      'qsub',
      false,
      'printnbind',
      1,
      false
    );
  });

  it('generates the box insert PDF when the box option is enabled', async () => {
    const payment = makePayment();
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([
      makePlaylist({ orderType: 'physical', boxEnabled: true, boxQuantity: 2 }),
    ]);
    h.prisma.paymentHasPlaylistItem.findMany.mockResolvedValue([
      { id: 41, index: 1 },
    ]);

    await gen.finalizeOrder('pay_1', mollie);

    expect(h.pdf.generateFromUrl).toHaveBeenCalledWith(
      `${process.env['API_URI']}/qr/pdf-box/31/pay_1`,
      `${process.env['PUBLIC_DIR']}/box-insert/box_pay_1_31.pdf`,
      { width: 120, height: 120 }
    );
    expect(h.pdf.addBleed).toHaveBeenCalledWith(
      `${process.env['PUBLIC_DIR']}/box-insert/box_pay_1_31.pdf`,
      3
    );
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: { boxFilename: 'box_pay_1_31.pdf' },
    });
  });

  it('finalizes a physical giftcard: discount code, both PDFs, voucher mail with invoice', async () => {
    const payment = makePayment();
    const playlist = makePlaylist({
      productType: 'giftcard',
      orderType: 'physical',
      giftcardAmount: 50,
      giftcardFrom: 'Oma',
      giftcardMessage: 'Gefeliciteerd!',
    });
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([playlist]);

    const res = await gen.finalizeOrder('pay_1', mollie);
    expect(res).toEqual({ success: true });

    expect(h.discount.createDiscountCode).toHaveBeenCalledWith(
      50,
      'Oma',
      'Gefeliciteerd!'
    );

    const hash = crypto
      .createHmac('sha256', process.env['PLAYLIST_SECRET']!)
      .update('pl1')
      .digest('hex');
    expect(h.pdf.generateGiftcardPDF).toHaveBeenCalledWith(
      `${hash}_digital.pdf`,
      playlist,
      { code: 'GIFT123', amount: 50 },
      payment,
      'digital',
      'qsub'
    );
    expect(h.pdf.generateGiftcardPDF).toHaveBeenCalledWith(
      `${hash}_printer.pdf`,
      playlist,
      { code: 'GIFT123', amount: 50 },
      payment,
      'printer',
      'qsub'
    );
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: {
        filename: `${hash}_printer.pdf`,
        filenameDigital: `${hash}_digital.pdf`,
      },
    });

    // Physical voucher => invoice attached and printer window opened
    expect(h.order.createInvoice).toHaveBeenCalledWith(payment);
    const mails = outbound.calls('Mail', 'sendEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'voucher_physical',
      payment,
      [playlist],
      `${hash}_printer.pdf`,
      `${hash}_digital.pdf`,
      '/tmp/invoice-42.pdf',
    ]);
    const printerUpdate = h.prisma.payment.update.mock.calls.find(
      (c) => c[0].data.canBeSentToPrinter
    );
    expect(printerUpdate).toBeTruthy();
    expect(outbound.calls('Mail', 'sendFinalizedMail')).toHaveLength(1);
  });

  it('finalizes a digital personal giftcard without printer PDF or invoice', async () => {
    const payment = makePayment();
    const playlist = makePlaylist({
      productType: 'giftcard',
      orderType: 'digital',
      giftcardAmount: 25,
      giftcardFrom: 'Me',
      giftcardMessage: 'Hi',
    });
    const mollie = makeMollie(payment);
    h.data.getPlaylistsByPaymentId.mockResolvedValue([playlist]);

    await gen.finalizeOrder('pay_1', mollie);

    // Only the digital giftcard PDF
    expect(h.pdf.generateGiftcardPDF).toHaveBeenCalledTimes(1);
    expect(h.pdf.generateGiftcardPDF.mock.calls[0][4]).toBe('digital');
    expect(h.order.createInvoice).not.toHaveBeenCalled();

    const mails = outbound.calls('Mail', 'sendEmail');
    expect(mails[0].args[0]).toBe('voucher_digital');
    expect(mails[0].args[3]).toBe(''); // no printer filename
    expect(mails[0].args[5]).toBe(''); // no invoice
    // No printer window
    const printerUpdate = h.prisma.payment.update.mock.calls.find(
      (c) => c[0].data.canBeSentToPrinter
    );
    expect(printerUpdate).toBeUndefined();
  });
});
