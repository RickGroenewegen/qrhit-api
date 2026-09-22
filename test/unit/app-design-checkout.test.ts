import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

/**
 * App Designer bought at checkout: the designs the site makes from the card
 * designs (validateCheckoutDesigns), and what happens once the order is paid
 * (activateCheckoutPurchase): where each design goes, the purchase row that
 * switches it on and books it against its order, and idempotency.
 */

const { prismaMock, reload } = vi.hoisted(() => ({
  prismaMock: {
    payment: { findUnique: vi.fn(), update: vi.fn() },
    appDesign: { findUnique: vi.fn() },
    appDesignPurchase: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
  reload: vi.fn(),
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));
vi.mock('../../src/apptheme', () => ({
  default: { getInstance: () => ({ reload }) },
}));
vi.mock('../../src/cache', () => ({
  default: { getInstance: () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }) },
}));
vi.mock('../../src/chatgpt', () => ({ ChatGPT: class {} }));

import AppDesign, { validateCheckoutDesigns } from '../../src/appDesign';

const appDesign = AppDesign.getInstance();
const normalize = (body: any) => appDesign.normalizeInput(body);

const CARD_BG = 'a'.repeat(32) + '.png';
const CARD_LOGO = 'b'.repeat(32) + '.png';

const theme = (color = '#123456') => ({
  cssVariables: { '--app-background': color, '--app-text-color': '#ffffff' },
  showMusicalNotes: false,
  showRecord: true,
  showEqualizer: true,
});

const entry = (over: Record<string, any> = {}) => ({
  playlistId: 'sp1',
  design: { name: 'Party', backgroundType: 'image', backgroundColor: '#123456' },
  theme: theme(),
  name: 'Party',
  fontId: 'system',
  cardBackground: CARD_BG,
  cardLogo: CARD_LOGO,
  ...over,
});

const cart = [
  { productType: 'cards', playlistId: 'sp1', background: CARD_BG, logo: CARD_LOGO },
  { productType: 'cards', playlistId: 'sp2', background: '', logo: '' },
];

describe('validateCheckoutDesigns', () => {
  it('keeps one valid design per card in the cart, with that card\'s own uploads', () => {
    const result = validateCheckoutDesigns({ designs: [entry()] }, cart, normalize);
    expect([...result.keys()]).toEqual(['sp1']);
    const kept = result.get('sp1')!;
    expect(kept.cardBackground).toBe(CARD_BG);
    expect(kept.cardLogo).toBe(CARD_LOGO);
    // Assets never come from the design state itself.
    expect(kept.input.background).toBeNull();
    expect(kept.input.logo).toBeNull();
    expect(kept.input.helpText).toBeFalsy();
    expect(kept.input.theme.cssVariables['--app-background']).toBe('#123456');
  });

  it('drops designs for playlists that are not in the cart, and duplicates', () => {
    const result = validateCheckoutDesigns(
      { designs: [entry({ playlistId: 'nope' }), entry(), entry({ theme: theme('#654321') })] },
      cart,
      normalize
    );
    expect([...result.keys()]).toEqual(['sp1']);
    expect(result.get('sp1')!.input.theme.cssVariables['--app-background']).toBe('#123456');
  });

  it('refuses uploads the card does not use', () => {
    const other = 'c'.repeat(32) + '.png';
    const result = validateCheckoutDesigns(
      { designs: [entry({ playlistId: 'sp2', cardBackground: other, cardLogo: '../../etc/passwd' })] },
      cart,
      normalize
    );
    expect(result.get('sp2')).toMatchObject({ cardBackground: null, cardLogo: null });
  });

  it('sells nothing for a theme the grammar refuses or a missing payload', () => {
    const bad = entry({ theme: { cssVariables: { '--app-background': 'url(https://evil)' } } });
    expect(validateCheckoutDesigns({ designs: [bad] }, cart, normalize).size).toBe(0);
    expect(validateCheckoutDesigns(undefined, cart, normalize).size).toBe(0);
    expect(validateCheckoutDesigns({ designs: 'x' }, cart, normalize).size).toBe(0);
  });
});

describe('activateCheckoutPurchase', () => {
  const stored = (playlistId: number, color: string, background: string | null = null) => ({
    playlistId,
    input: {
      design: { name: 'Party', backgroundType: 'solid' },
      theme: theme(color),
      name: 'Party',
      helpText: null,
      logo: null,
      background: null,
      fontId: 'system',
    },
    cardBackground: background,
    cardLogo: null,
  });

  const payment = (over: Record<string, any> = {}) => ({
    id: 40,
    paymentId: 'tr_order',
    userId: 7,
    status: 'paid',
    appDesignFee: 9,
    taxRate: 21,
    countrycode: 'NL',
    currency: 'EUR',
    exchangeRate: 1,
    PaymentHasPlaylist: [
      { id: 101, playlistId: 1 },
      { id: 102, playlistId: 2 },
      { id: 103, playlistId: 3 },
    ],
    appDesignRequest: {
      designs: [stored(1, '#111111'), stored(2, '#111111'), stored(3, '#333333')],
    },
    ...over,
  });

  let saveDesign: ReturnType<typeof vi.spyOn>;
  let processUpgradePayment: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    reload.mockReset();
    prismaMock.payment.findUnique.mockReset();
    prismaMock.payment.update.mockReset().mockResolvedValue({});
    prismaMock.appDesign.findUnique.mockReset().mockResolvedValue(null);
    saveDesign = vi.spyOn(appDesign, 'saveDesign').mockResolvedValue({} as any);
    processUpgradePayment = vi
      .spyOn(appDesign, 'processUpgradePayment')
      .mockResolvedValue({ success: true, created: true, purchaseId: 5 });
  });

  it('makes the first design the default and gives only a different look its own', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment());
    await appDesign.activateCheckoutPurchase(40);

    const scopes = saveDesign.mock.calls.map((call) => call[0]);
    expect(scopes).toEqual([{ userId: 7 }, { userId: 7, paymentHasPlaylistId: 103 }]);
    expect(processUpgradePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        molliePaymentId: 'tr_order',
        paymentId: 40,
        price: 9,
        taxRate: 21,
        countrycode: 'NL',
      })
    );
    const update = prismaMock.payment.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 40 });
    expect(update.data.appDesignRequest.appliedAt).toEqual(expect.any(String));
  });

  it('never overwrites a default the account already has', async () => {
    prismaMock.appDesign.findUnique.mockResolvedValue({ theme: { cssVariables: {} } });
    prismaMock.payment.findUnique.mockResolvedValue(payment());
    await appDesign.activateCheckoutPurchase(40);

    const scopes = saveDesign.mock.calls.map((call) => call[0]);
    expect(scopes).toEqual([
      { userId: 7, paymentHasPlaylistId: 101 },
      { userId: 7, paymentHasPlaylistId: 102 },
      { userId: 7, paymentHasPlaylistId: 103 },
    ]);
  });

  it("leaves an owner's default design alone for cards without a look of their own", async () => {
    prismaMock.appDesign.findUnique.mockResolvedValue({ theme: { cssVariables: {} } });
    const plain = stored(1, '#111111');
    plain.input.design.backgroundType = 'qrsong';
    const withLogo = stored(2, '#111111');
    withLogo.input.design.backgroundType = 'qrsong';
    withLogo.cardLogo = CARD_LOGO;
    prismaMock.payment.findUnique.mockResolvedValue(
      payment({ appDesignFee: 0, appDesignRequest: { designs: [plain, withLogo] } })
    );
    await appDesign.activateCheckoutPurchase(40);
    // Only the card with a logo gets its own design; the plain one keeps the default.
    expect(saveDesign.mock.calls.map((call) => call[0])).toEqual([{ userId: 7, paymentHasPlaylistId: 102 }]);
  });

  it('records no purchase when nothing was charged, but still makes the designs', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(payment({ appDesignFee: 0 }));
    await appDesign.activateCheckoutPurchase(40);
    expect(saveDesign).toHaveBeenCalled();
    expect(processUpgradePayment).not.toHaveBeenCalled();
    expect(prismaMock.payment.update).toHaveBeenCalled();
  });

  it('does nothing twice, for unpaid orders or orders without a request', async () => {
    const request = payment().appDesignRequest;
    for (const row of [
      payment({ appDesignRequest: { ...request, appliedAt: '2026-09-22T10:00:00Z' } }),
      payment({ status: 'open' }),
      payment({ appDesignRequest: null }),
    ]) {
      prismaMock.payment.findUnique.mockResolvedValueOnce(row);
      await appDesign.activateCheckoutPurchase(40);
    }
    expect(saveDesign).not.toHaveBeenCalled();
    expect(processUpgradePayment).not.toHaveBeenCalled();
  });

  it('tries again on the next webhook when the purchase could not be recorded', async () => {
    processUpgradePayment.mockResolvedValue({ success: false, created: false, error: 'db' });
    prismaMock.payment.findUnique.mockResolvedValue(payment());
    await appDesign.activateCheckoutPurchase(40);
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
  });

  it("copies the card's photo into the App Designer folder and publishes that copy", async () => {
    const publicDir = process.env['PUBLIC_DIR'] as string;
    await fs.mkdir(path.join(publicDir, 'background'), { recursive: true });
    await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 20, b: 60 } },
    })
      .png()
      .toFile(path.join(publicDir, 'background', CARD_BG));

    const withPhoto = stored(1, '#111111', CARD_BG);
    withPhoto.input.design.backgroundType = 'image';
    prismaMock.payment.findUnique.mockResolvedValue(
      payment({ appDesignRequest: { designs: [withPhoto] } })
    );
    await appDesign.activateCheckoutPurchase(40);

    const input = saveDesign.mock.calls[0][1] as any;
    expect(input.background).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(input.background).not.toBe(CARD_BG);
    expect(input.design.background).toBe(input.background);
    await expect(fs.access(appDesign.assetPath(input.background))).resolves.toBeUndefined();
  });
});

describe('importCardAsset', () => {
  it('refuses anything but a card upload name and survives a missing file', async () => {
    expect(await appDesign.importCardAsset('logo', '../secret.png')).toBeNull();
    expect(await appDesign.importCardAsset('logo', 'd'.repeat(32) + '.png')).toBeNull();
  });
});

// The dashboard's switch (users.appDesignEnabled) beats the purchases while
// it is set; a purchase clears it again.
describe('isEntitled / setEnabled', () => {
  beforeEach(() => {
    // The checkout tests above spy on processUpgradePayment; this block runs
    // the real one.
    vi.restoreAllMocks();
    prismaMock.user.findUnique.mockReset();
    prismaMock.user.update.mockReset().mockResolvedValue({ hash: 'h' });
    prismaMock.appDesignPurchase.count.mockReset();
    reload.mockClear();
  });

  it('follows the purchases when the switch is not set', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ appDesignEnabled: null });
    prismaMock.appDesignPurchase.count.mockResolvedValue(0);
    expect(await appDesign.isEntitled(5)).toBe(false);
    prismaMock.appDesignPurchase.count.mockResolvedValue(1);
    expect(await appDesign.isEntitled(5)).toBe(true);
  });

  it('lets the switch override the purchases either way', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ appDesignEnabled: true });
    prismaMock.appDesignPurchase.count.mockResolvedValue(0);
    expect(await appDesign.isEntitled(5)).toBe(true);

    prismaMock.user.findUnique.mockResolvedValue({ appDesignEnabled: false });
    prismaMock.appDesignPurchase.count.mockResolvedValue(3);
    expect(await appDesign.isEntitled(5)).toBe(false);
  });

  it('stores the switch and reloads the served themes', async () => {
    await appDesign.setEnabled(5, false);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { appDesignEnabled: false },
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a purchase puts the account back on its purchases', async () => {
    prismaMock.appDesignPurchase.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ appDesignEnabled: false });
    prismaMock.appDesignPurchase.count.mockResolvedValue(0);
    prismaMock.appDesignPurchase.create.mockResolvedValue({ id: 9 });
    const result = await appDesign.processUpgradePayment({
      userId: 5,
      molliePaymentId: 'tr_switch',
      price: 9,
      taxRate: 21,
      countrycode: 'NL',
      currency: 'EUR',
      amountCharged: 9,
    });
    expect(result).toEqual({ success: true, created: true, purchaseId: 9 });
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 }, data: { appDesignEnabled: null } })
    );
  });
});
