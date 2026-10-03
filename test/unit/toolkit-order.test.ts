import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/toolkitOrder.ts: the qrsong toolkit's printer orders.
 * The point of these orders is what they do NOT do (no Mollie, no mail, never
 * Print&Bind), so the tests pin exactly what is written and queued.
 */

const h = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  paymentCreate: vi.fn(),
  paymentUpdate: vi.fn(),
  paymentFindUnique: vi.fn(),
  phpUpdate: vi.fn(),
  trackFindMany: vi.fn(),
  getPlaylistFromUrl: vi.fn(),
  storePlaylists: vi.fn(),
  getTracks: vi.fn(),
  getOrderType: vi.fn(),
  queueGenerate: vi.fn(),
}));

vi.mock('console-log-colors', () => ({
  color: new Proxy({}, { get: () => new Proxy((s: any) => s, { get: () => (s: any) => s }) }),
  white: new Proxy((s: any) => s, { get: () => (s: any) => s }),
}));
vi.mock('../../src/logger', () => ({ default: class Logger { log() {} logDev() {} } }));
vi.mock('../../src/prisma', () => ({
  default: {
    getInstance: () => ({
      user: { findFirst: h.userFindFirst },
      payment: { create: h.paymentCreate, update: h.paymentUpdate, findUnique: h.paymentFindUnique },
      paymentHasPlaylist: { update: h.phpUpdate },
      track: { findMany: h.trackFindMany },
    }),
  },
}));
vi.mock('../../src/data', () => ({
  default: { getInstance: () => ({ storePlaylists: h.storePlaylists, getTracks: h.getTracks }) },
}));
vi.mock('../../src/order', () => ({ default: { getInstance: () => ({ getOrderType: h.getOrderType }) } }));
vi.mock('../../src/generator', () => ({ default: { getInstance: () => ({ queueGenerate: h.queueGenerate }) } }));
vi.mock('../../src/utils', () => ({ default: class Utils { generateRandomString = () => 'abcdefghijklmnop'; } }));
vi.mock('../../src/services/MusicServiceRegistry', () => ({
  default: { getInstance: () => ({ getPlaylistFromUrl: h.getPlaylistFromUrl }) },
}));

import ToolkitOrder, { checkPrinter, checkTemplate, designColumns, ToolkitOrderError } from '../../src/toolkitOrder';
import path from 'path';

const PLAYLIST = '1xxLqfdEzvQ1yPMwKrxVAl';

describe('toolkit order validation', () => {
  it('only allows the printers we mail ourselves', () => {
    expect(checkPrinter(undefined)).toBe('schneiders');
    expect(checkPrinter('tromp')).toBe('tromp');
    expect(() => checkPrinter('printnbind')).toThrow(ToolkitOrderError);
    expect(() => checkPrinter('reseller')).toThrow(/schneiders, tromp/);
    expect(() => checkPrinter('kinkos')).toThrow(/unknown printerType/);
  });

  it('accepts only existing card templates', () => {
    const views = path.join(__dirname, '../../src/views');
    expect(checkTemplate(null, views)).toBeNull();
    expect(checkTemplate('', views)).toBeNull();
    expect(checkTemplate('facta', views)).toBe('facta');
    expect(() => checkTemplate('nope', views)).toThrow(/no card template/);
    expect(() => checkTemplate('../secrets', views)).toThrow(/no card template/);
  });

  it('fills checkout defaults, keeps given fields and refuses unknown ones', () => {
    const d = designColumns({ background: 'abc123.png', qrColor: '#ffffff', fontColor: '#ffffff' });
    expect(d.background).toBe('abc123.png');
    expect(d.qrColor).toBe('#ffffff');
    expect(d.qrBackgroundType).toBe('none');
    expect(d.backOpacity).toBe(100);
    expect(() => designColumns({ colour: 'red' } as any)).toThrow(/unknown design fields: colour/);
    expect(() => designColumns({ background: 'https://evil.example/x.png' })).toThrow(/uploaded file name/);
    expect(() => designColumns({ backOpacity: 150 })).toThrow(/0..100/);
  });
});

describe('ToolkitOrder.create', () => {
  const service = ToolkitOrder.getInstance();

  beforeEach(() => {
    Object.values(h).forEach((fn) => fn.mockReset());
    h.userFindFirst.mockResolvedValue({ id: 7, email: 'west14@gmail.com', displayName: 'Rick Groenewegen' });
    h.getPlaylistFromUrl.mockResolvedValue({
      success: true,
      data: { name: 'Revant personeelsfeest 2026', trackCount: 48, imageUrl: 'https://i.scdn.co/x' },
    });
    h.storePlaylists.mockResolvedValue([555]);
    h.getOrderType.mockResolvedValue({ id: 16 });
    h.paymentCreate.mockResolvedValue({ id: 9001, PaymentHasPlaylist: [{ id: 12001 }] });
    h.paymentUpdate.mockResolvedValue({});
  });

  it('writes a paid, free order on printer hold, without marketing mail, and queues generation without mails', async () => {
    const result = await service.create({
      email: 'West14@gmail.com',
      playlistId: PLAYLIST,
      expectedTracks: 48,
      design: { background: 'front.png', backgroundBack: 'back.png', qrColor: '#ffffff', fontColor: '#ffffff' },
      fullname: 'Revant (DNP Giftmanagers)',
      companyName: 'DNP Giftmanagers',
    });

    expect(result).toEqual({
      paymentId: 'toolkit_abcdefghijklmnop',
      orderId: '100009001',
      paymentDbId: 9001,
      paymentHasPlaylistId: 12001,
      playlistDbId: 555,
      playlistName: 'Revant personeelsfeest 2026',
      trackCount: 48,
    });

    const data = h.paymentCreate.mock.calls[0][0].data;
    expect(data.status).toBe('paid');
    expect(data.totalPrice).toBe(0);
    expect(data.printerHold).toBe(true);
    expect(data.printerHoldReason).toBeUndefined(); // a hand-placed hold: nothing clears it
    expect(data.marketingEmails).toBe(false);
    expect(data.vibe).toBe(false);
    expect(data.email).toBe('west14@gmail.com');
    expect(data.isBusinessOrder).toBe(true);
    const line = data.PaymentHasPlaylist.create[0];
    expect(line.printerType).toBe('schneiders');
    expect(line.type).toBe('physical');
    expect(line.numberOfTracks).toBe(48);
    expect(line.background).toBe('front.png');
    expect(line.backgroundBack).toBe('back.png');
    expect(line.qrBackgroundType).toBe('none');

    expect(h.paymentUpdate).toHaveBeenCalledWith({ where: { id: 9001 }, data: { orderId: '100009001' } });
    // skipMainMail = true (5th argument): no invoice, no order mail, no Pushover.
    expect(h.queueGenerate).toHaveBeenCalledWith('toolkit_abcdefghijklmnop', '127.0.0.1', PLAYLIST, false, true, false);
  });

  it('refuses a playlist with another track count than expected, before writing anything', async () => {
    await expect(service.create({ email: 'west14@gmail.com', playlistId: PLAYLIST, expectedTracks: 47 })).rejects.toThrow(
      /48 tracks, expected 47/
    );
    expect(h.paymentCreate).not.toHaveBeenCalled();
    expect(h.queueGenerate).not.toHaveBeenCalled();
  });

  it('refuses Print&Bind, an unknown account and a bad playlist id', async () => {
    await expect(service.create({ email: 'west14@gmail.com', playlistId: PLAYLIST, printerType: 'printnbind' })).rejects.toThrow(
      ToolkitOrderError
    );
    h.userFindFirst.mockResolvedValue(null);
    await expect(service.create({ email: 'nobody@example.com', playlistId: PLAYLIST })).rejects.toThrow(/no account/);
    await expect(service.create({ email: 'west14@gmail.com', playlistId: 'not-a-playlist' })).rejects.toThrow(/playlistId/);
    expect(h.paymentCreate).not.toHaveBeenCalled();
  });
});

describe('ToolkitOrder.updateDesign', () => {
  const service = ToolkitOrder.getInstance();

  beforeEach(() => {
    Object.values(h).forEach((fn) => fn.mockReset());
  });

  it('changes only what is sent, and not once the order is at a printer', async () => {
    h.paymentFindUnique.mockResolvedValue({
      sentToPrinter: false,
      PaymentHasPlaylist: [{ id: 12001, qrColor: '#000000', backOpacity: 50, frontOpacity: 100, qrBackgroundType: 'square' }],
    });
    await service.updateDesign('toolkit_x', { design: { qrColor: '#ffffff', backOpacity: 100 } });
    expect(h.phpUpdate).toHaveBeenCalledWith({ where: { id: 12001 }, data: { qrColor: '#ffffff', backOpacity: 100 } });

    h.paymentFindUnique.mockResolvedValue({ sentToPrinter: true, PaymentHasPlaylist: [{ id: 12001 }] });
    await expect(service.updateDesign('toolkit_x', { design: { qrColor: '#000000' } })).rejects.toThrow(/already sent/);
  });
});
