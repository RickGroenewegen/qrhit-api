import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import path from 'path';

/**
 * Pure unit tests for src/generator.ts — the send-to-printer pipeline
 * (sendToPrinter, runSendToPrinterPass, finalCheck failure handling, PDF
 * page-count validation), setupForPrinter, generateBoxInsertPdf and
 * createGameset. Same fake-deps harness as generator.test.ts.
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
vi.mock('cron', async () => {
  const { h } = await import('./harness');
  return {
    CronJob: class {
      constructor(...args: any[]) {
        h.cronJobs.push(args);
      }
    },
  };
});

import { outbound } from '../../helpers/recording-mock';
import {
  h,
  resetGeneratorMocks,
  makePayment,
  makePlaylist,
} from './harness';
import Generator from '../../../src/generator';

const gen = Generator.getInstance();

beforeEach(() => {
  outbound.reset();
  resetGeneratorMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Standard eligible physical setup for sendToPrinter. */
function arrangePrinter(paymentOver = {}, playlistOver = {}) {
  const payment = makePayment(paymentOver);
  const playlist = makePlaylist({ orderType: 'physical', ...playlistOver });
  h.prisma.payment.findFirst.mockResolvedValue(payment);
  h.data.getPlaylistsByPaymentId.mockResolvedValue([playlist]);
  h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
    filename: 'phys.pdf',
  });
  // track counts in sync, page count matches tracks*2
  h.prisma.playlistHasTrack.count.mockResolvedValue(playlist.numberOfTracks);
  h.pdf.countPDFPages.mockResolvedValue(playlist.numberOfTracks * 2);
  return { payment, playlist };
}

describe('sendToPrinter()', () => {
  it('returns "Already being processed" when the lock is held, without releasing it', async () => {
    h.cache.acquireLock.mockResolvedValue(false);

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');

    expect(res).toEqual({ success: false, reason: 'Already being processed' });
    expect(h.cache.acquireLock).toHaveBeenCalledWith('printer:pay_1', 120);
    expect(h.cache.releaseLock).not.toHaveBeenCalled();
    expect(h.prisma.payment.findFirst).not.toHaveBeenCalled();
  });

  it('rejects payments that are not eligible and releases the lock', async () => {
    h.prisma.payment.findFirst.mockResolvedValue(
      makePayment({ canBeSentToPrinter: false })
    );

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');

    expect(res).toEqual({
      success: false,
      reason: 'Not eligible for printing',
    });
    expect(h.order.createOrder).not.toHaveBeenCalled();
    expect(h.cache.releaseLock).toHaveBeenCalledWith('printer:pay_1');
  });

  it('force=true resets sentToPrinter before processing', async () => {
    arrangePrinter();

    await gen.sendToPrinter('pay_1', '1.1.1.1', true);

    expect(h.prisma.payment.update.mock.calls[0][0]).toEqual({
      where: { paymentId: 'pay_1' },
      data: { sentToPrinter: false },
    });
  });

  it('happy path: validates, runs finalCheck, orders, marks sent and mails the customer', async () => {
    const { payment, playlist } = arrangePrinter();

    const res = await gen.sendToPrinter('pay_1', '2.2.2.2');
    expect(res).toEqual({ success: true });

    // playlist filename lookup
    expect(h.prisma.paymentHasPlaylist.findFirst).toHaveBeenCalledWith({
      select: { filename: true },
      where: { paymentId: 11, playlistId: 21, type: 'physical', subType: 'none' },
    });

    expect(h.finalCheck.runCheck).toHaveBeenCalledWith({
      id: 11,
      paymentId: 'pay_1',
      qrSubDir: 'qsub',
    });

    expect(h.order.createOrder).toHaveBeenCalledWith(
      payment,
      [{ playlist, filename: 'phys.pdf' }],
      'cards'
    );

    const sentUpdate = h.prisma.payment.update.mock.calls.find(
      (c) => c[0].data.sentToPrinter === true
    );
    expect(sentUpdate![0].where).toEqual({ id: 11 });
    expect(sentUpdate![0].data).toMatchObject({
      printApiOrderId: 'printapi-1',
      printApiOrderRequest: JSON.stringify({ items: 1 }),
      printApiOrderResponse: JSON.stringify({ id: 'printapi-1' }),
    });
    expect(sentUpdate![0].data.sentToPrinterAt).toBeInstanceOf(Date);

    const mails = outbound.calls('Mail', 'sendToPrinterMail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([payment, playlist, undefined]);
    expect(h.cache.releaseLock).toHaveBeenCalledWith('printer:pay_1');
  });

  it('passes the My Account bingo link in the printer mail for games-enabled playlists', async () => {
    arrangePrinter({}, { gamesEnabled: true });

    await gen.sendToPrinter('pay_1', '1.1.1.1');

    const mails = outbound.calls('Mail', 'sendToPrinterMail');
    expect(mails[0].args[2]).toBe(
      `${process.env['FRONTEND_URI']}/en/my-account`
    );
  });

  it('aborts with a siren pushover when the PDF page count is wrong', async () => {
    arrangePrinter();
    h.pdf.countPDFPages.mockResolvedValue(7); // expected 4, 7 is not 4 nor odd 5

    const res = await gen.sendToPrinter('pay_1', '3.3.3.3');

    expect(res).toEqual({ success: false, reason: 'PDF validation errors' });
    expect(h.order.createOrder).not.toHaveBeenCalled();
    expect(h.finalCheck.runCheck).not.toHaveBeenCalled();

    const push = outbound.calls('PushoverClient', 'sendMessage');
    expect(push).toHaveLength(1);
    expect(push[0].args[0]).toMatchObject({
      title: '🚨 PDF Validation Error - Order Not Sent',
      priority: 1,
    });
    expect(push[0].args[0].message).toContain('pay_1');
    expect(push[0].args[1]).toBe('3.3.3.3');
  });

  it('accepts an odd page count exactly one above the expected count', async () => {
    arrangePrinter();
    h.pdf.countPDFPages.mockResolvedValue(5); // expected 4, odd 5 tolerated

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');
    expect(res).toEqual({ success: true });
  });

  it('validates sheets playlists at 2 pages per 12-card iteration', async () => {
    arrangePrinter(
      {},
      { subType: 'sheets', numberOfTracks: 25, paymentHasPlaylistNumberOfTracks: 25 }
    );
    h.prisma.playlistHasTrack.count.mockResolvedValue(25);
    h.pdf.countPDFPages.mockResolvedValue(6); // ceil(25/12)*2

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');
    expect(res).toEqual({ success: true });
  });

  it('syncs stale track counts down to the real count before validating', async () => {
    const { playlist } = arrangePrinter(
      {},
      { numberOfTracks: 5, paymentHasPlaylistNumberOfTracks: 5 }
    );
    h.prisma.playlistHasTrack.count.mockResolvedValue(3);
    h.pdf.countPDFPages.mockResolvedValue(6); // 3 tracks * 2 after sync

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');
    expect(res).toEqual({ success: true });

    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: { numberOfTracks: 3 },
    });
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: { numberOfTracks: 3 },
    });
    expect(playlist.numberOfTracks).toBe(3);
  });

  it('treats other PDF read errors as validation failures too', async () => {
    arrangePrinter();
    h.pdf.countPDFPages.mockRejectedValue(new Error('corrupt xref table'));

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');

    expect(res).toEqual({ success: false, reason: 'PDF validation errors' });
    const push = outbound.calls('PushoverClient', 'sendMessage');
    expect(push[0].args[0].message).toContain('Failed to validate PDF');
    expect(push[0].args[0].message).toContain('corrupt xref table');
  });

  it('treats a missing PDF file (ENOENT) as a validation error', async () => {
    arrangePrinter();
    const err: any = new Error('no such file');
    err.code = 'ENOENT';
    h.pdf.countPDFPages.mockRejectedValue(err);

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');

    expect(res).toEqual({ success: false, reason: 'PDF validation errors' });
    const push = outbound.calls('PushoverClient', 'sendMessage');
    expect(push[0].args[0].message).toContain('PDF file not found');
  });

  it('puts the payment on hold (no customer mail) for a non-actionable finalCheck failure', async () => {
    arrangePrinter();
    h.finalCheck.runCheck.mockResolvedValue({
      ok: false,
      reason: 'pdf-missing',
      userActionable: false,
      details: 'printer pdf 0 bytes',
      paymentHasPlaylistId: 0,
      playlistDbId: 0,
      playlistId: '',
    });

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');

    expect(res).toEqual({
      success: false,
      reason: 'finalCheck:pdf-missing: printer pdf 0 bytes',
    });
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { printerHold: true },
    });
    const push = outbound.calls('PushoverClient', 'sendMessage');
    expect(push[0].args[0]).toMatchObject({
      title: '🚨 finalCheck failed - order on hold',
      sound: 'siren',
      priority: 1,
    });
    expect(h.data.resetJudgedStatus).not.toHaveBeenCalled();
    expect(outbound.calls('Mail', 'sendDesignAlterMail')).toHaveLength(0);
    expect(h.order.createOrder).not.toHaveBeenCalled();
  });

  it('user-actionable hitster failure resets the Judged flag and emails the customer', async () => {
    const { payment } = arrangePrinter();
    const flaggedImages = [
      {
        key: 'cardFront',
        filename: 'card-front.png',
        buffer: Buffer.from('card-front-png'),
      },
    ];
    h.finalCheck.runCheck.mockResolvedValue({
      ok: false,
      reason: 'hitster',
      userActionable: true,
      details: 'looks like a Hitster clone',
      paymentHasPlaylistId: 31,
      playlistDbId: 21,
      playlistId: 'pl1',
      flaggedImages,
    });

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');

    expect(res.success).toBe(false);
    expect(h.data.resetJudgedStatus).toHaveBeenCalledWith(31);
    // second findFirst loads the payment incl. user for the mail
    expect(h.prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { id: 11 },
      include: { user: { select: { hash: true } } },
    });
    const mails = outbound.calls('Mail', 'sendDesignAlterMail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      payment.email,
      'Rick Tester',
      'en',
      'pay_1',
      'userhash',
      'pl1',
      'hitster',
      flaggedImages,
    ]);
  });

  it('user-actionable inappropriate failure without an email address skips the customer mail', async () => {
    arrangePrinter({ email: null });
    h.finalCheck.runCheck.mockResolvedValue({
      ok: false,
      reason: 'inappropriate',
      userActionable: true,
      details: 'profanity on card 3',
      paymentHasPlaylistId: 31,
      playlistDbId: 21,
      playlistId: 'pl1',
    });

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');

    expect(res.success).toBe(false);
    expect(h.data.resetJudgedStatus).toHaveBeenCalledWith(31);
    expect(outbound.calls('Mail', 'sendDesignAlterMail')).toHaveLength(0);
  });

  it('converts a throwing finalCheck into a pdf-missing hold', async () => {
    arrangePrinter();
    h.finalCheck.runCheck.mockRejectedValue(new Error('parser exploded'));

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1');

    expect(res).toEqual({
      success: false,
      reason: 'finalCheck:pdf-missing: finalCheck threw: parser exploded',
    });
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { printerHold: true },
    });
  });

  it('skipFinalCheck bypasses finalCheck entirely', async () => {
    arrangePrinter();

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1', false, true);

    expect(res).toEqual({ success: true });
    expect(h.finalCheck.runCheck).not.toHaveBeenCalled();
  });

  it('PrintAPI failure: pushover fired, no customer mail, but sentToPrinter is still set (suspected bug)', async () => {
    arrangePrinter();
    h.order.createOrder.mockResolvedValue({
      success: false,
      request: { items: 1 },
      response: { error: 'address invalid' },
    });

    const res = await gen.sendToPrinter('pay_1', '4.4.4.4');

    expect(res).toEqual({ success: false, reason: 'PrintAPI error' });
    expect(outbound.calls('Mail', 'sendToPrinterMail')).toHaveLength(0);
    const push = outbound.calls('PushoverClient', 'sendMessage');
    expect(push[0].args[0].title).toBe('Fout tijdens Print&Bind bestelling');

    // Actual behavior: the payment is flagged sentToPrinter=true even though
    // the print order failed — documented here as observed behavior.
    const sentUpdate = h.prisma.payment.update.mock.calls.find(
      (c) => c[0].data.sentToPrinter === true
    );
    expect(sentUpdate).toBeTruthy();
  });

  it('inlayOnly: skips PDF validation, orders via orderInlayCard, no printer mail', async () => {
    const { payment, playlist } = arrangePrinter();

    const res = await gen.sendToPrinter('pay_1', '1.1.1.1', false, true, true);

    expect(res).toEqual({ success: true });
    expect(h.pdf.countPDFPages).not.toHaveBeenCalled();
    expect(h.order.orderInlayCard).toHaveBeenCalledWith(payment, [
      { playlist, filename: 'phys.pdf' },
    ]);
    expect(h.order.createOrder).not.toHaveBeenCalled();
    expect(outbound.calls('Mail', 'sendToPrinterMail')).toHaveLength(0);
    const sentUpdate = h.prisma.payment.update.mock.calls.find(
      (c) => c[0].data.sentToPrinter === true
    );
    expect(sentUpdate![0].data.printApiOrderId).toBe('inlay-1');
  });
});

describe('runSendToPrinterPass()', () => {
  it('returns an empty summary when nothing is eligible', async () => {
    h.prisma.payment.findMany.mockResolvedValue([]);

    const summary = await gen.runSendToPrinterPass();

    expect(summary).toEqual({ checked: 0, sent: 0, held: 0, results: [] });
    // Default cron query filters on the printer eligibility flags
    const where = h.prisma.payment.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      sentToPrinter: false,
      printerHold: false,
      vibe: false,
    });
    expect(where.OR).toHaveLength(2);
  });

  it('blocks payments with pending suggestions and warns once via pushover', async () => {
    h.prisma.payment.findMany
      .mockResolvedValueOnce([
        {
          paymentId: 'pay_1',
          PaymentHasPlaylist: [{ suggestionsPending: true, playlistId: 21 }],
        },
      ])
      // needWarning lookup: not warned before
      .mockResolvedValueOnce([
        { id: 11, paymentId: 'pay_1', fullname: 'Rick', email: 'r@t.test' },
      ]);
    const sendSpy = vi.spyOn(gen, 'sendToPrinter');

    const summary = await gen.runSendToPrinterPass();

    expect(summary).toEqual({ checked: 0, sent: 0, held: 0, results: [] });
    expect(sendSpy).not.toHaveBeenCalled();

    const push = outbound.calls('PushoverClient', 'sendMessage');
    expect(push).toHaveLength(1);
    expect(push[0].args[0].title).toBe('⏳ Order stuck on user suggestions');
    expect(push[0].args[0].message).toContain(
      'PaymentHasPlaylist.suggestionsPending=true'
    );
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: {
        suggestionWarningSent: true,
        suggestionWarningSentAt: expect.any(Date),
      },
    });
  });

  it('blocks payments with unresolved UserSuggestion rows without re-warning', async () => {
    h.prisma.payment.findMany
      .mockResolvedValueOnce([
        {
          paymentId: 'pay_2',
          PaymentHasPlaylist: [{ suggestionsPending: false, playlistId: 21 }],
        },
      ])
      .mockResolvedValueOnce([]); // already warned
    h.prisma.userSuggestion.count.mockResolvedValue(2);

    const summary = await gen.runSendToPrinterPass();

    expect(summary.checked).toBe(0);
    expect(h.prisma.userSuggestion.count).toHaveBeenCalledWith({
      where: { playlistId: { in: [21] } },
    });
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
  });

  it('classifies outcomes: sent, held (finalCheck) and send-failed', async () => {
    const eligible = (paymentId: string) => ({
      paymentId,
      PaymentHasPlaylist: [{ suggestionsPending: false, playlistId: 21 }],
    });
    h.prisma.payment.findMany.mockResolvedValueOnce([
      eligible('pay_a'),
      eligible('pay_b'),
      eligible('pay_c'),
      eligible('pay_d'),
    ]);
    const sendSpy = vi
      .spyOn(gen, 'sendToPrinter')
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: false,
        reason: 'finalCheck:hitster: nope',
      })
      .mockResolvedValueOnce({ success: false, reason: 'PrintAPI error' })
      .mockRejectedValueOnce(new Error('network down'));

    const summary = await gen.runSendToPrinterPass();

    expect(sendSpy).toHaveBeenCalledWith('pay_a', '');
    expect(summary.checked).toBe(4);
    expect(summary.sent).toBe(1);
    expect(summary.held).toBe(1);
    expect(summary.results).toEqual([
      { paymentId: 'pay_a', outcome: 'sent' },
      { paymentId: 'pay_b', outcome: 'held', reason: 'finalCheck:hitster: nope' },
      { paymentId: 'pay_c', outcome: 'send-failed', reason: 'PrintAPI error' },
      { paymentId: 'pay_d', outcome: 'send-failed', reason: 'network down' },
    ]);
  });

  it('paymentId + force bypasses the suggestion eligibility filter', async () => {
    h.prisma.payment.findMany.mockResolvedValueOnce([
      {
        paymentId: 'pay_9',
        PaymentHasPlaylist: [{ suggestionsPending: true, playlistId: 21 }],
      },
    ]);
    const sendSpy = vi
      .spyOn(gen, 'sendToPrinter')
      .mockResolvedValue({ success: true });

    const summary = await gen.runSendToPrinterPass({
      paymentId: 'pay_9',
      force: true,
    });

    expect(h.prisma.payment.findMany.mock.calls[0][0].where).toEqual({
      paymentId: 'pay_9',
    });
    expect(sendSpy).toHaveBeenCalledWith('pay_9', '');
    expect(summary.sent).toBe(1);
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('paymentId without force still applies the suggestion filter', async () => {
    h.prisma.payment.findMany
      .mockResolvedValueOnce([
        {
          paymentId: 'pay_9',
          PaymentHasPlaylist: [{ suggestionsPending: true, playlistId: 21 }],
        },
      ])
      .mockResolvedValueOnce([]);
    const sendSpy = vi.spyOn(gen, 'sendToPrinter');

    const summary = await gen.runSendToPrinterPass({ paymentId: 'pay_9' });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(summary.checked).toBe(0);
  });
});

describe('setSendToPrinterCron()', () => {
  it('registers an hourly Amsterdam cron whose tick runs the printer pass', async () => {
    gen.setSendToPrinterCron();

    expect(h.cronJobs).toHaveLength(1);
    const [schedule, callback, onComplete, start, tz] = h.cronJobs[0];
    expect(schedule).toBe('0 * * * *');
    expect(onComplete).toBeNull();
    expect(start).toBe(true);
    expect(tz).toBe('Europe/Amsterdam');

    const passSpy = vi
      .spyOn(gen, 'runSendToPrinterPass')
      .mockResolvedValue({ checked: 0, sent: 0, held: 0, results: [] });
    await callback();
    expect(passSpy).toHaveBeenCalledTimes(1);
    expect(passSpy).toHaveBeenCalledWith();
  });
});

describe('setupForPrinter()', () => {
  it('resets the print API status to Submitted and clears the tracking link', async () => {
    await gen.setupForPrinter('pay_1');

    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1' },
      data: { printApiStatus: 'Submitted', printApiTrackingLink: null },
    });
  });
});

describe('generateBoxInsertPdf()', () => {
  it('renders the box URL, adds bleed and stores the filename', async () => {
    const result = await gen.generateBoxInsertPdf(31, 'pay_1');

    expect(result).toBe('box_pay_1_31.pdf');
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

  it('appends the explicit insert count to the render URL', async () => {
    await gen.generateBoxInsertPdf(31, 'pay_1', 3);

    expect(h.pdf.generateFromUrl.mock.calls[0][0]).toBe(
      `${process.env['API_URI']}/qr/pdf-box/31/pay_1?count=3`
    );
  });
});

describe('createGameset()', () => {
  it('throws when the payment_has_playlist entry does not exist', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);

    await expect(gen.createGameset('pay_1', 99)).rejects.toThrow(
      'Payment has playlist entry not found: 99'
    );
  });

  it('builds a downloadable ZIP with one QR per track plus tracks.json', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue({
      id: 31,
      playlist: {
        playlistId: 'pl1',
        tracks: [
          {
            order: 1,
            track: {
              id: 1,
              artist: 'ABBA',
              name: 'SOS',
              spotifyLink: 'https://open.spotify.com/track/abc123?si=x',
            },
          },
          {
            order: 2,
            track: { id: 2, artist: 'Queen', name: null, spotifyLink: null },
          },
        ],
      },
    });
    // The mock must actually write the SVG, or archiver fails on finalize.
    h.qr.generateQR.mockImplementation(
      async (_link: string, outPath: string) => {
        await fsp.writeFile(outPath, '<svg/>');
      }
    );

    const url = await gen.createGameset('pay_1', 31);

    expect(url).toMatch(/^\/public\/gamesets\/gameset_pay_1_pl1_\d+\.zip$/);
    const zipPath = path.join(
      process.env['PUBLIC_DIR']!,
      'gamesets',
      path.basename(url)
    );
    expect(fsSync.existsSync(zipPath)).toBe(true);
    expect(fsSync.statSync(zipPath).size).toBeGreaterThan(0);

    expect(h.qr.generateQR).toHaveBeenCalledTimes(2);
    expect(h.qr.generateQR).toHaveBeenCalledWith(
      'https://api.musicmatchgame.com/31/1',
      expect.stringContaining('00001_track_1_abba_sos.svg'),
      '#000000',
      'svg'
    );
    // Track without name/spotifyLink falls back to "untitled" and empty link
    expect(h.qr.generateQR).toHaveBeenCalledWith(
      'https://api.musicmatchgame.com/31/2',
      expect.stringContaining('00002_track_2_queen_untitled.svg'),
      '#000000',
      'svg'
    );

    await fsp.rm(zipPath, { force: true });
  });
});
