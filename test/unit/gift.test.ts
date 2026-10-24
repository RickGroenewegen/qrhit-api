import { describe, it, expect } from 'vitest';
import {
  GIFT_CODE_ALPHABET,
  GIFT_CODE_LENGTH,
  GIFT_MESSAGE_MAX,
  GIFT_NAME_MAX,
  GiftEligibilityLine,
  formatGiftCode,
  generateGiftCode,
  giftEligibility,
  looksLikeGiftCardCode,
  normalizeGiftCode,
  parseVoucherText,
  planAppDesignTransfer,
} from '../../src/gift';

describe('gift codes', () => {
  it('draws twelve characters a person can read off paper', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateGiftCode();
      expect(code).toHaveLength(GIFT_CODE_LENGTH);
      for (const char of code) expect(GIFT_CODE_ALPHABET).toContain(char);
    }
    expect(GIFT_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('prints as GIFT-XXXX-XXXX-XXXX and reads back from that', () => {
    const code = 'ABCDEFGHJKMN';
    expect(formatGiftCode(code)).toBe('GIFT-ABCD-EFGH-JKMN');
    expect(normalizeGiftCode(formatGiftCode(code))).toBe(code);
  });

  it('takes what someone typed: any case, spaces, dashes, with or without GIFT', () => {
    expect(normalizeGiftCode('gift abcd-efgh jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeGiftCode(' abcd efgh jkmn ')).toBe('ABCDEFGHJKMN');
    expect(normalizeGiftCode('GIFTABCDEFGHJKMN')).toBe('ABCDEFGHJKMN');
  });

  it('refuses what cannot be a code', () => {
    expect(normalizeGiftCode('')).toBeNull();
    expect(normalizeGiftCode(null)).toBeNull();
    expect(normalizeGiftCode(42)).toBeNull();
    expect(normalizeGiftCode('ABCD-EFGH-JKM')).toBeNull();
    // 0, O, 1, I and L are never in a code
    expect(normalizeGiftCode('ABCD-EFGH-JKM0')).toBeNull();
    expect(normalizeGiftCode('ABCD-EFGH-JKMI')).toBeNull();
  });

  it('tells a gift card code (XXXX-XXXX-XXXX-XXXX) from a gift code', () => {
    expect(looksLikeGiftCardCode('AB12-CD34-EF56-GH78')).toBe(true);
    expect(looksLikeGiftCardCode('GIFT-ABCD-EFGH-JKMN')).toBe(false);
    expect(looksLikeGiftCardCode('ABCD-EFGH-JKMN')).toBe(false);
  });
});

describe('giftEligibility (which sets can go on a voucher)', () => {
  type LineOverrides = Partial<Omit<GiftEligibilityLine, 'payment'>> & {
    payment?: Partial<GiftEligibilityLine['payment']>;
  };
  const line = (over: LineOverrides = {}) => {
    const { payment, ...rest } = over;
    return {
      type: 'digital',
      filenameDigital: 'cards.pdf',
      theme: null,
      blocked: false,
      suggestionsPending: false,
      ownerUserId: null,
      playlist: { type: 'cards' },
      ...rest,
      payment: {
        status: 'paid',
        sentToPrinter: false,
        refundedAt: null,
        companyList: false,
        ...payment,
      },
    } as GiftEligibilityLine;
  };

  it('gives digital cards once their PDF exists', () => {
    expect(giftEligibility(line())).toEqual({ ok: true });
    expect(giftEligibility(line({ filenameDigital: null }))).toEqual({ ok: false, reason: 'pdfNotReady' });
  });

  it('gives printed cards and sheets once the order went to the printer', () => {
    expect(giftEligibility(line({ type: 'physical' }))).toEqual({ ok: false, reason: 'notPrinted' });
    expect(giftEligibility(line({ type: 'physical', payment: { sentToPrinter: true } }))).toEqual({ ok: true });
    expect(giftEligibility(line({ type: 'sheets', payment: { sentToPrinter: true } }))).toEqual({ ok: true });
  });

  it('never gives what is not the buyer’s to hand over', () => {
    const cases: Array<[Parameters<typeof line>[0], string]> = [
      [{ payment: { status: 'open' } }, 'notPaid'],
      [{ payment: { refundedAt: new Date() } }, 'refunded'],
      [{ playlist: { type: 'giftcard' } }, 'giftcard'],
      [{ payment: { companyList: true } }, 'company'],
      [{ theme: 'acme' }, 'adminTheme'],
      [{ blocked: true }, 'blocked'],
      [{ ownerUserId: 12 }, 'changedHands'],
      [{ suggestionsPending: true }, 'correctionsPending'],
    ];
    for (const [over, reason] of cases) {
      expect(giftEligibility(line(over))).toEqual({ ok: false, reason });
    }
  });
});

describe('planAppDesignTransfer (what the recipient’s cards show)', () => {
  const theme = { mode: 'custom', hasTheme: true };

  it("moves the set's own design, kept active", () => {
    expect(planAppDesignTransfer({ override: theme, giverDefaultHasTheme: true, giverEntitled: true })).toEqual({
      carry: 'moved',
      keepActive: true,
      mode: null,
    });
  });

  it("copies the giver's default for a set that follows it", () => {
    const copied = { carry: 'copied', keepActive: true, mode: 'custom' };
    expect(planAppDesignTransfer({ override: null, giverDefaultHasTheme: true, giverEntitled: true })).toEqual(copied);
    expect(
      planAppDesignTransfer({
        override: { mode: 'default', hasTheme: false },
        giverDefaultHasTheme: true,
        giverEntitled: true,
      })
    ).toEqual(copied);
  });

  it('carries nothing active when the giver never owned App Designer', () => {
    expect(planAppDesignTransfer({ override: theme, giverDefaultHasTheme: true, giverEntitled: false })).toEqual({
      carry: 'draft',
      keepActive: false,
      mode: 'default',
    });
    expect(planAppDesignTransfer({ override: null, giverDefaultHasTheme: true, giverEntitled: false })).toEqual({
      carry: 'none',
      keepActive: false,
      mode: null,
    });
  });

  it('keeps the plain look for a set set to standard', () => {
    expect(
      planAppDesignTransfer({
        override: { mode: 'standard', hasTheme: true },
        giverDefaultHasTheme: true,
        giverEntitled: true,
      })
    ).toEqual({ carry: 'draft', keepActive: false, mode: null });
  });

  it('moves a custom row that was never saved as a draft', () => {
    expect(
      planAppDesignTransfer({
        override: { mode: 'custom', hasTheme: false },
        giverDefaultHasTheme: false,
        giverEntitled: true,
      })
    ).toEqual({ carry: 'draft', keepActive: false, mode: null });
  });

  it('carries nothing when there is no design anywhere', () => {
    expect(planAppDesignTransfer({ override: null, giverDefaultHasTheme: false, giverEntitled: true })).toEqual({
      carry: 'none',
      keepActive: false,
      mode: null,
    });
  });
});

describe('parseVoucherText', () => {
  it('needs who it is for and who it is from', () => {
    expect(() => parseVoucherText({ fromName: 'Mark' })).toThrow('recipientNameRequired');
    expect(() => parseVoucherText({ recipientName: 'Anna', fromName: '   ' })).toThrow('fromNameRequired');
  });

  it('tidies names, caps lengths and keeps line breaks in the message', () => {
    const parsed = parseVoucherText({
      recipientName: '  Anna \n  de Vries ',
      fromName: 'x'.repeat(100),
      message: 'Happy\r\n\r\n\r\n\r\nbirthday!' + 'y'.repeat(500),
      locale: 'nl',
    });
    expect(parsed.recipientName).toBe('Anna de Vries');
    expect(parsed.fromName).toHaveLength(GIFT_NAME_MAX);
    expect(parsed.message?.startsWith('Happy\n\nbirthday!')).toBe(true);
    expect(parsed.message).toHaveLength(GIFT_MESSAGE_MAX);
    expect(parsed.locale).toBe('nl');
  });

  it('stores no empty message and falls back to English for an unknown language', () => {
    const parsed = parseVoucherText({ recipientName: 'Anna', fromName: 'Mark', message: '  ', locale: 'xx' });
    expect(parsed.message).toBeNull();
    expect(parsed.locale).toBe('en');
  });
});
