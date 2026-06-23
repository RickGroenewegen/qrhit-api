/**
 * Unit tests for src/vibe.ts — generatePDF orchestration: cleanup of old
 * playlist/payment, background image processing through sharp, the free
 * "generation queued by Mollie" early return, forceTemplate application
 * and the full finalize path (queueGenerate + status/link updates).
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

process.env['API_URI'] = 'https://api.test';
process.env['FRONTEND_URI'] = 'https://front.test';

function baseList(over: Record<string, any> = {}) {
  return {
    id: 5,
    name: 'Lijst',
    slug: 'lijst',
    companyId: 1,
    playlistId: null,
    paymentId: null,
    playlistUrl: 'https://open.spotify.com/playlist/pl123',
    background: null,
    background2: null,
    hideCircle: false,
    forceTemplate: null,
    showNames: true,
    numberOfCards: 200,
    numberOfTracks: 5,
    qrColor: '#000000',
    Company: { id: 1, name: 'Acme' },
    ...over,
  };
}

function arrange(list: any) {
  // include -> the generatePDF lookup; select -> getRanking's lookup
  h.prisma.companyList.findUnique.mockImplementation(async (args: any) =>
    args.include ? list : { id: 5, name: 'Lijst', numberOfTracks: 5, numberOfCards: 200 }
  );
  h.prisma.companyList.update.mockResolvedValue({ id: 5, slug: 'lijst' });
  h.discount.createDiscountCode.mockResolvedValue({ code: 'DISC100' });
  h.prisma.playlist.delete.mockResolvedValue({});
  h.prisma.payment.delete.mockResolvedValue({});
}

const fakeMollie = () => ({ getPaymentUri: h.mollie.getPaymentUri }) as any;

beforeEach(() => {
  resetAll();
});

describe('generatePDF — queued early return', () => {
  it('cleans up the previous playlist/payment and stops once Mollie queues generation', async () => {
    arrange(baseList({ playlistId: 77, paymentId: 88 }));
    h.mollie.getPaymentUri.mockResolvedValue({ data: { generationQueued: true } });

    const res = await vibe.generatePDF(5, fakeMollie(), '1.2.3.4');
    expect(res).toEqual({
      success: true,
      message: 'PDF generation queued by payment system',
    });

    // Old artifacts removed
    expect(h.prisma.playlist.delete).toHaveBeenCalledWith({ where: { id: 77 } });
    expect(h.prisma.payment.delete).toHaveBeenCalledWith({ where: { id: 88 } });

    // Status flipped and cache cleared
    expect(h.prisma.companyList.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: 'generating_pdf' },
    });
    expect(h.cacheDel).toHaveBeenCalledWith('companyListByDomain:lijst');

    // 100% discount at the fixed €100 price point
    expect(h.discount.createDiscountCode).toHaveBeenCalledWith(10000, '', '');

    // Payment request payload
    const params = h.mollie.getPaymentUri.mock.calls[0][0];
    expect(params.onzevibe).toBe(true);
    expect(params.locale).toBe('en');
    expect(params.extraOrderData.vibe).toBe(true);
    expect(params.cart.discounts).toEqual([
      { code: 'DISC100', amountLeft: 10000, fullAmount: 10000 },
    ]);
    const item = params.cart.items[0];
    expect(item).toMatchObject({
      productType: 'cards',
      playlistId: 'pl123', // parsed from playlistUrl
      playlistName: 'Lijst',
      numberOfTracks: 200, // numberOfCards drives the card count
      price: 10000,
      background: null,
      backgroundBack: null,
      backgroundBackType: 'solid',
    });

    // Nothing further: no generator, no finalize updates
    expect(h.generator.queueGenerate).not.toHaveBeenCalled();
  });

  it('skips cleanup when the list never had a playlist/payment', async () => {
    arrange(baseList());
    h.mollie.getPaymentUri.mockResolvedValue({ data: { generationQueued: true } });
    await vibe.generatePDF(5, fakeMollie(), '1.2.3.4');
    expect(h.prisma.playlist.delete).not.toHaveBeenCalled();
    expect(h.prisma.payment.delete).not.toHaveBeenCalled();
  });

  it('applies forceTemplate to the playlist even on the queued path', async () => {
    arrange(baseList({ forceTemplate: 'classic' }));
    h.mollie.getPaymentUri.mockResolvedValue({ data: { generationQueued: true } });
    h.prisma.playlist.findUnique.mockResolvedValue({ id: 301, template: null });
    h.prisma.playlist.update.mockResolvedValue({});

    await vibe.generatePDF(5, fakeMollie(), '1.2.3.4');
    expect(h.prisma.playlist.findUnique).toHaveBeenCalledWith({
      where: { playlistId: 'pl123' },
    });
    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 301 },
      data: { template: 'classic' },
    });
  });

  it('returns an error when the list does not exist', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    h.prisma.companyList.update.mockResolvedValue({ id: 5, slug: 'x' });
    const res = await vibe.generatePDF(5, fakeMollie(), '1.2.3.4');
    expect(res).toEqual({ success: false, error: 'Company list not found' });
    expect(h.mollie.getPaymentUri).not.toHaveBeenCalled();
  });
});

describe('generatePDF — background processing', () => {
  it('copies, resizes and composites the circle overlay onto the front background', async () => {
    arrange(baseList({ background: 'bg.png', background2: 'bg2.png' }));
    h.mollie.getPaymentUri.mockResolvedValue({ data: { generationQueued: true } });
    h.fs.copyFile.mockResolvedValue(undefined);
    h.fs.readFile.mockResolvedValue(Buffer.from('raw'));
    h.fs.writeFile.mockResolvedValue(undefined);

    await vibe.generatePDF(5, fakeMollie(), '1.2.3.4');

    // Front + back both went through sharp; only the front gets the circle
    expect(h.sharpCalls).toHaveLength(2);
    expect(h.sharpComposite).toHaveBeenCalledTimes(1);
    const overlay = h.sharpComposite.mock.calls[0][0][0];
    expect(overlay.input.toString()).toContain('<circle');

    // Both processed buffers written back
    expect(h.fs.writeFile).toHaveBeenCalledWith(
      `${process.env['PUBLIC_DIR']}/background/bg.png`,
      Buffer.from('processed-png')
    );
    expect(h.fs.writeFile).toHaveBeenCalledWith(
      `${process.env['PUBLIC_DIR']}/background/bg2.png`,
      Buffer.from('processed-png')
    );

    const item = h.mollie.getPaymentUri.mock.calls[0][0].cart.items[0];
    expect(item.background).toBe('bg.png');
    expect(item.backgroundBack).toBe('bg2.png');
    expect(item.backgroundBackType).toBe('image');
  });

  it('skips the circle overlay when hideCircle is set', async () => {
    arrange(baseList({ background: 'bg.png', hideCircle: true }));
    h.mollie.getPaymentUri.mockResolvedValue({ data: { generationQueued: true } });
    h.fs.copyFile.mockResolvedValue(undefined);
    h.fs.readFile.mockResolvedValue(Buffer.from('raw'));
    h.fs.writeFile.mockResolvedValue(undefined);

    await vibe.generatePDF(5, fakeMollie(), '1.2.3.4');
    expect(h.sharpComposite).not.toHaveBeenCalled();
  });

  it('falls back to no background when copy/processing fails', async () => {
    arrange(baseList({ background: 'bg.png', background2: 'bg2.png' }));
    h.mollie.getPaymentUri.mockResolvedValue({ data: { generationQueued: true } });
    h.fs.copyFile.mockRejectedValue(new Error('ENOENT'));

    await vibe.generatePDF(5, fakeMollie(), '1.2.3.4');
    const item = h.mollie.getPaymentUri.mock.calls[0][0].cart.items[0];
    expect(item.background).toBeNull();
    expect(item.backgroundBack).toBeNull();
    expect(item.backgroundBackType).toBe('solid');
  });
});

describe('generatePDF — full (non-queued) path', () => {
  it('queues the generator, applies counts and finalizes status + links', async () => {
    arrange(baseList());
    h.mollie.getPaymentUri.mockResolvedValue({
      data: { generationQueued: false, userId: 9, paymentId: 'pay_1' },
    });
    h.prisma.user.findUnique.mockResolvedValue({ id: 9, hash: 'uhash' });
    h.prisma.playlist.findUnique.mockResolvedValue({ id: 301, template: null });
    h.prisma.companyListSubmission.findMany.mockResolvedValue([]); // empty ranking
    h.prisma.companyListSubmissionTrack.findMany.mockResolvedValue([]);
    h.prisma.track.findMany.mockResolvedValue([]);
    h.generator.queueGenerate.mockResolvedValue(undefined);
    h.mollie.getPayment.mockResolvedValue({ id: 88 });
    h.prisma.playlistHasTrack.count
      .mockResolvedValueOnce(50) // total tracks
      .mockResolvedValueOnce(5); // unchecked tracks

    await vibe.generatePDF(5, fakeMollie(), '9.9.9.9');

    expect(h.generator.queueGenerate).toHaveBeenCalledWith(
      'pay_1',
      '9.9.9.9',
      '',
      true,
      true,
      false
    );
    expect(h.mollie.getPayment).toHaveBeenCalledWith('pay_1');

    const updates = h.prisma.companyList.update.mock.calls.map((c) => c[0].data);
    expect(updates[0]).toEqual({ status: 'generating_pdf' });
    expect(updates).toContainEqual({
      playlistId: 301,
      paymentId: 88,
      numberOfUncheckedTracks: 5,
      totalSpotifyTracks: 50,
    });
    expect(updates).toContainEqual({
      status: 'pdf_complete',
      downloadLink: 'https://api.test/download/pay_1/uhash/pl123/printer',
      reviewLink: 'https://front.test/usersuggestions/pay_1/uhash/pl123/0',
    });

    // Cache cleared for both the initial and the final status flips
    expect(h.cacheDel).toHaveBeenCalledWith('companyListByDomain:lijst');
    expect(h.cacheDel.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('applies forceTemplate via the fallback when the playlist has none yet', async () => {
    arrange(baseList({ forceTemplate: 'classic' }));
    h.mollie.getPaymentUri.mockResolvedValue({
      data: { generationQueued: false, userId: 9, paymentId: 'pay_1' },
    });
    h.prisma.user.findUnique.mockResolvedValue({ id: 9, hash: 'uhash' });
    h.prisma.playlist.findUnique.mockResolvedValue({ id: 301, template: null });
    h.prisma.playlist.update.mockResolvedValue({});
    h.prisma.companyListSubmission.findMany.mockResolvedValue([]);
    h.prisma.companyListSubmissionTrack.findMany.mockResolvedValue([]);
    h.prisma.track.findMany.mockResolvedValue([]);
    h.mollie.getPayment.mockResolvedValue({ id: 88 });
    h.prisma.playlistHasTrack.count.mockResolvedValue(0);

    await vibe.generatePDF(5, fakeMollie(), '9.9.9.9');

    // Applied once right after payment creation and once via the fallback
    const templateUpdates = h.prisma.playlist.update.mock.calls.filter(
      (c) => c[0].data.template === 'classic'
    );
    expect(templateUpdates.length).toBeGreaterThanOrEqual(1);
    expect(templateUpdates[0][0].where).toEqual({ id: 301 });
  });
});
