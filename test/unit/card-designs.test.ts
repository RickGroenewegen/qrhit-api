import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/cardDesigns.ts: alternating card designs (card 1 gets
 * design 1, card 2 design 2, ..., starting again after the last one).
 *
 * The request sanitising is what stands between a customer's JSON and the
 * <style> blocks of the PDF templates, so most cases are about values that
 * must not get through. src/prisma is mocked; the DB helpers take a client.
 */

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => ({}) },
}));

import {
  CARD_DESIGN_COLUMNS,
  CARD_DESIGN_SELECT,
  MAX_EXTRA_DESIGNS,
  deckDesigns,
  designForCard,
  designIndexForCard,
  extraDesignRows,
  getExtraDesigns,
  pickCardDesign,
  replaceExtraDesigns,
  sanitizeCardDesign,
  sanitizeExtraDesigns,
} from '../../src/cardDesigns';

describe('sanitizeCardDesign', () => {
  it('keeps every valid value of a design the designer sends', () => {
    const design = sanitizeCardDesign({
      emoji: '🎵',
      background: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.png',
      logo: 'logo_1.webp',
      selectedFont: '"Fira Sans", Arial, sans-serif',
      selectedFontSize: '15px',
      hideCircle: false,
      qrBackgroundType: 'circle',
      qrColor: '#123456',
      qrBackgroundColor: '#fff',
      qrLogo: 'qr.png',
      qrLogoScale: 30,
      backgroundFrontType: 'solid',
      backgroundFrontColor: '#abcdef',
      useFrontGradient: true,
      gradientFrontColor: '#000000',
      gradientFrontDegrees: 90,
      gradientFrontPosition: 30,
      frontOpacity: 70,
      backgroundBackType: 'image',
      backgroundBack: 'back.png',
      backgroundBackColor: '#eeeeee',
      fontColor: '#ffffff',
      useGradient: true,
      gradientBackgroundColor: '#111111',
      gradientDegrees: 45,
      gradientPosition: 60,
      backOpacity: 20,
      sameAsFront: true,
    });

    expect(design).toEqual({
      emoji: '🎵',
      background: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.png',
      logo: 'logo_1.webp',
      selectedFont: '"Fira Sans", Arial, sans-serif',
      selectedFontSize: '15px',
      hideCircle: false,
      qrBackgroundType: 'circle',
      qrColor: '#123456',
      qrBackgroundColor: '#fff',
      qrLogo: 'qr.png',
      qrLogoScale: 30,
      backgroundFrontType: 'solid',
      backgroundFrontColor: '#abcdef',
      useFrontGradient: true,
      gradientFrontColor: '#000000',
      gradientFrontDegrees: 90,
      gradientFrontPosition: 30,
      frontOpacity: 70,
      backgroundBackType: 'image',
      backgroundBack: 'back.png',
      backgroundBackColor: '#eeeeee',
      fontColor: '#ffffff',
      useGradient: true,
      gradientBackgroundColor: '#111111',
      gradientDegrees: 45,
      gradientPosition: 60,
      backOpacity: 20,
      sameAsFront: true,
    });
  });

  it('gives an empty object the column defaults', () => {
    const design = sanitizeCardDesign({});
    expect(design).toMatchObject({
      emoji: null,
      background: null,
      logo: null,
      selectedFont: 'Arial, sans-serif',
      selectedFontSize: '16px',
      qrBackgroundType: 'square',
      qrColor: '#000000',
      qrBackgroundColor: '#ffffff',
      qrLogo: null,
      qrLogoScale: 25,
      backgroundFrontType: 'image',
      frontOpacity: 100,
      backgroundBackType: 'image',
      backOpacity: 50,
      gradientDegrees: 180,
      gradientPosition: 50,
      sameAsFront: false,
    });
    expect(Object.keys(design).sort()).toEqual([...CARD_DESIGN_COLUMNS].sort());
  });

  it('drops keys that are not design columns (preview URLs, ids)', () => {
    const design = sanitizeCardDesign({
      backgroundImage: 'data:image/png;base64,AAAA',
      logoImage: 'https://api/public/logo/x.png',
      id: 5,
      eco: true,
      doubleSided: true,
    });
    expect(design).not.toHaveProperty('backgroundImage');
    expect(design).not.toHaveProperty('logoImage');
    expect(design).not.toHaveProperty('id');
    // eco and doubleSided belong to the order line, not to a design.
    expect(design).not.toHaveProperty('eco');
    expect(design).not.toHaveProperty('doubleSided');
  });

  it('refuses filenames that could leave the upload folder or break the markup', () => {
    for (const bad of ['../x.png', 'a/b.png', "x.png');}body{", '.hidden', 'x y.png', 'a"b.png']) {
      const design = sanitizeCardDesign({ background: bad, backgroundBack: bad, logo: bad });
      expect(design.background).toBeNull();
      expect(design.backgroundBack).toBeNull();
      expect(design.logo).toBeNull();
    }
    expect(sanitizeCardDesign({ qrLogo: '../../private/x.png' }).qrLogo).toBeNull();
  });

  it('refuses CSS injection through colours and fonts', () => {
    const design = sanitizeCardDesign({
      fontColor: 'red;} body { display:none',
      qrColor: 'url(x)',
      backgroundBackColor: '#12345',
      selectedFont: 'Arial; } .x { color: red',
      selectedFontSize: '16px; color: red',
    });
    expect(design.fontColor).toBe('#000000');
    expect(design.qrColor).toBe('#000000');
    expect(design.backgroundBackColor).toBe('#ffffff');
    expect(design.selectedFont).toBe('Arial, sans-serif');
    expect(design.selectedFontSize).toBe('16px');
  });

  it('clamps numbers and falls back on garbage', () => {
    const design = sanitizeCardDesign({
      frontOpacity: 250,
      backOpacity: -5,
      gradientDegrees: '90',
      gradientPosition: 'abc',
      gradientFrontDegrees: '',
      qrLogoScale: 99,
    });
    expect(design.frontOpacity).toBe(100);
    expect(design.backOpacity).toBe(0);
    expect(design.gradientDegrees).toBe(90);
    expect(design.gradientPosition).toBe(50);
    expect(design.gradientFrontDegrees).toBe(180);
    expect(design.qrLogoScale).toBe(40);
    expect(sanitizeCardDesign({ qrLogoScale: null }).qrLogoScale).toBe(25);
  });

  it('reads MySQL tinyints and strings as booleans', () => {
    const design = sanitizeCardDesign({ useGradient: 1, useFrontGradient: 'true', sameAsFront: 0 });
    expect(design.useGradient).toBe(true);
    expect(design.useFrontGradient).toBe(true);
    expect(design.sameAsFront).toBe(false);
  });

  it('derives the QR shape from the legacy hideCircle flag', () => {
    expect(sanitizeCardDesign({ hideCircle: true }).qrBackgroundType).toBe('none');
    expect(sanitizeCardDesign({ qrBackgroundType: 'hexagon' }).qrBackgroundType).toBe('square');
  });

  it('strips markup from the emoji and caps its length', () => {
    expect(sanitizeCardDesign({ emoji: '<b>x</b>' }).emoji).toBe('bx/b');
    expect(sanitizeCardDesign({ emoji: 'x'.repeat(100) }).emoji).toHaveLength(32);
  });
});

describe('sanitizeExtraDesigns', () => {
  it('treats anything but an array as no extra designs', () => {
    expect(sanitizeExtraDesigns(undefined)).toEqual([]);
    expect(sanitizeExtraDesigns(null)).toEqual([]);
    expect(sanitizeExtraDesigns({ background: 'x.png' })).toEqual([]);
    expect(sanitizeExtraDesigns('[]')).toEqual([]);
  });

  it('keeps at most nine extra designs (ten in total) and skips non-objects', () => {
    const input = [null, 'x', ...Array.from({ length: 12 }, (_, i) => ({ background: `b${i}.png` }))];
    const designs = sanitizeExtraDesigns(input);
    expect(designs).toHaveLength(MAX_EXTRA_DESIGNS);
    expect(designs[0].background).toBe('b0.png');
    expect(designs[8].background).toBe('b8.png');
  });
});

describe('deck order', () => {
  it('cycles through the designs card by card', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => designIndexForCard(3, i))).toEqual([0, 1, 2, 0, 1, 2, 0]);
  });

  it('puts every card on design 1 when there is one design', () => {
    expect(designIndexForCard(1, 7)).toBe(0);
    expect(designIndexForCard(0, 7)).toBe(0);
  });

  it('continues the cycle in a later PDF chunk (numbers run over the whole deck)', () => {
    // A printer chunk holds 50 cards: card 51 of a 3-design deck is design 3.
    expect(designIndexForCard(3, 50)).toBe(2);
    expect(designIndexForCard(7, 600)).toBe(600 % 7);
  });

  it('builds the deck from the order line and lays each extra design over it', () => {
    const php = { paymentHasPlaylistId: 9, background: 'one.png', addHowToCard: 1, qrColor: '#000000' };
    const extra = sanitizeCardDesign({ background: 'two.png', qrColor: '#ff0000' });
    const designs = deckDesigns(php, [extra]);

    expect(designs).toHaveLength(2);
    // Design 1 is the line itself, so a single-design deck renders unchanged.
    expect(designs[0]).toBe(php);
    expect(designs[1]).toMatchObject({
      paymentHasPlaylistId: 9,
      addHowToCard: 1,
      background: 'two.png',
      qrColor: '#ff0000',
    });
    expect(designForCard(designs, 3)).toBe(designs[1]);
    expect(deckDesigns(php)).toEqual([php]);
  });
});

describe('storage helpers', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = {
      $transaction: vi.fn(async (operations: any[]) => operations),
      paymentHasPlaylistDesign: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(() => 'deleteMany'),
        createMany: vi.fn(() => 'createMany'),
      },
    };
  });

  it('numbers extra design rows from position 2', () => {
    const rows = extraDesignRows([sanitizeCardDesign({}), sanitizeCardDesign({})]);
    expect(rows.map((row) => row.position)).toEqual([2, 3]);
  });

  it('selects every design column for nested reads', () => {
    expect(Object.keys(CARD_DESIGN_SELECT).sort()).toEqual([...CARD_DESIGN_COLUMNS].sort());
    expect(Object.values(CARD_DESIGN_SELECT).every((v) => v === true)).toBe(true);
  });

  it('reads the design columns of a line in position order', async () => {
    prisma.paymentHasPlaylistDesign.findMany.mockResolvedValueOnce([
      { id: 1, paymentHasPlaylistId: 4, position: 2, createdAt: new Date(), ...sanitizeCardDesign({ background: 'x.png' }) },
    ]);
    const designs = await getExtraDesigns(4, prisma);

    expect(prisma.paymentHasPlaylistDesign.findMany).toHaveBeenCalledWith({
      where: { paymentHasPlaylistId: 4 },
      orderBy: { position: 'asc' },
    });
    expect(designs).toEqual([sanitizeCardDesign({ background: 'x.png' })]);
  });

  it('replaces the designs of a line in one transaction', async () => {
    await replaceExtraDesigns(4, [sanitizeCardDesign({ background: 'x.png' })], prisma);

    expect(prisma.paymentHasPlaylistDesign.deleteMany).toHaveBeenCalledWith({
      where: { paymentHasPlaylistId: 4 },
    });
    const { data } = prisma.paymentHasPlaylistDesign.createMany.mock.calls[0][0];
    expect(data).toEqual([
      { ...sanitizeCardDesign({ background: 'x.png' }), position: 2, paymentHasPlaylistId: 4 },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledWith(['deleteMany', 'createMany']);
  });

  it('only deletes when going back to one design', async () => {
    await replaceExtraDesigns(4, [], prisma);
    expect(prisma.paymentHasPlaylistDesign.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(['deleteMany']);
  });

  it('picks only design columns from a stored row', () => {
    const picked = pickCardDesign({ id: 3, position: 2, paymentHasPlaylistId: 1, qrColor: '#111111' });
    expect(picked).not.toHaveProperty('id');
    expect(picked).not.toHaveProperty('position');
    expect(picked.qrColor).toBe('#111111');
  });
});
