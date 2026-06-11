import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import Utils from '../../src/utils';
import Discount from '../../src/discount';

const DAY = 24 * 60 * 60 * 1000;

describe('discount routes', () => {
  let app: FastifyInstance;
  let recaptcha: any;

  beforeAll(async () => {
    // checkDiscount verifies a captcha against Google; never in tests.
    recaptcha = vi
      .spyOn(Utils.prototype, 'verifyRecaptcha')
      .mockResolvedValue({ isHuman: true, score: 0.9 });
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    await prisma().discountCode.createMany({
      data: [
        { code: 'VALID-25', amount: 25 },
        { code: 'EXPIRED-10', amount: 10, endDate: new Date(Date.now() - DAY) },
        {
          code: 'FUTURE-10',
          amount: 10,
          startDate: new Date(Date.now() + DAY),
        },
        { code: 'DIGITAL-15', amount: 15, digital: true },
      ],
    });

    const partial = await prisma().discountCode.create({
      data: { code: 'PARTIAL-50', amount: 50 },
    });
    await prisma().discountCodedUses.createMany({
      data: [
        { discountCodeId: partial.id, amount: 10 },
        { discountCodeId: partial.id, amount: 15 },
      ],
    });

    const exhausted = await prisma().discountCode.create({
      data: { code: 'EMPTY-20', amount: 20 },
    });
    await prisma().discountCodedUses.create({
      data: { discountCodeId: exhausted.id, amount: 25 },
    });
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  const check = (code: string, digital: boolean) =>
    app.inject({
      method: 'POST',
      url: `/discount/${code}/${digital}`,
      payload: { token: 'tok' },
    });

  describe('POST /discount/:code/:digital (checkDiscount)', () => {
    it('accepts a valid unused code with the full amount left', async () => {
      const res = await check('VALID-25', false);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        fullAmount: 25,
        amountLeft: 25,
      });
    });

    it('subtracts recorded uses from the amount left', async () => {
      const res = await check('PARTIAL-50', false);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.fullAmount).toBe(50);
      expect(body.amountLeft).toBeCloseTo(25, 2); // 50 - 10 - 15
    });

    it('rejects an unknown code', async () => {
      const res = await check('NO-SUCH-CODE', false);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: false,
        message: 'discountCodeNotFound',
      });
    });

    it('rejects a code whose end date has passed', async () => {
      const res = await check('EXPIRED-10', false);
      expect(res.json()).toEqual({
        success: false,
        message: 'discountNotActive',
      });
    });

    it('rejects a code whose start date is in the future', async () => {
      const res = await check('FUTURE-10', false);
      expect(res.json()).toEqual({
        success: false,
        message: 'discountNotActive',
      });
    });

    it('rejects an exhausted code, exposing the (negative) balance', async () => {
      const res = await check('EMPTY-20', false);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.message).toBe('discountCodeExhausted');
      expect(body.fullAmount).toBe(20);
      expect(body.amountLeft).toBeCloseTo(-5, 2); // 20 - 25 used
    });

    it('rejects a digital-only code for physical orders but accepts it for digital ones', async () => {
      const physical = await check('DIGITAL-15', false);
      expect(physical.json()).toEqual({
        success: false,
        message: 'notApplicableForRealOrders',
      });

      const digital = await check('DIGITAL-15', true);
      expect(digital.json()).toEqual({
        success: true,
        fullAmount: 15,
        amountLeft: 15,
      });
    });

    it('returns 500 when the captcha verification fails (checkDiscount throws)', async () => {
      recaptcha.mockResolvedValueOnce({ isHuman: false, score: 0.1 });
      const res = await check('VALID-25', false);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('Discount.calculateVolumeDiscount', () => {
    const discount = new Discount();
    const digitalItem = (numberOfTracks: number, price: number) => ({
      productType: 'cards',
      type: 'digital',
      numberOfTracks,
      amount: 1,
      price,
    });

    it('returns 0 for fewer than two digital playlists', async () => {
      expect(
        await discount.calculateVolumeDiscount({
          items: [digitalItem(500, 13)],
        })
      ).toBe(0);
    });

    it('ignores physical and non-card items when counting digital playlists', async () => {
      const result = await discount.calculateVolumeDiscount({
        items: [
          digitalItem(500, 13),
          { ...digitalItem(500, 49), type: 'physical' },
          { ...digitalItem(500, 13), productType: 'giftcard' },
        ],
      });
      expect(result).toBe(0);
    });

    it('applies the interpolated tier: 2 × 500 cards → 12.5% volume pricing', async () => {
      // 1000 cards: discount = (1000-500) × (0.5/2000) = 12.5%
      // → 1000 × 0.026 × 0.875 = 22.75 → ceil 23 vs 2 × 13 = 26 → 3.00
      const result = await discount.calculateVolumeDiscount({
        items: [digitalItem(500, 13), digitalItem(500, 13)],
      });
      expect(result).toBeCloseTo(3, 2);
    });

    it('caps at the 50% tier from 2500 cards', async () => {
      // 2500 cards at max 50%: 2500 × 0.013 = 32.5 → ceil 33.
      // Individually a 1250-card playlist costs 27 → current 54 → 21.00.
      const result = await discount.calculateVolumeDiscount({
        items: [digitalItem(1250, 27), digitalItem(1250, 27)],
      });
      expect(result).toBeCloseTo(21, 2);
    });

    it('never returns a negative discount', async () => {
      // Two tiny playlists: volume price (floor 13) exceeds 2 × 5 = 10.
      const result = await discount.calculateVolumeDiscount({
        items: [digitalItem(50, 5), digitalItem(50, 5)],
      });
      expect(result).toBe(0);
    });
  });
});
