import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/orderBoard.ts, the admin's Order status board. What
 * matters: a sticky shows what the list's own calculator says (reseller,
 * boxes, box type), profit only when both prices are known, the company's
 * contact when none was picked; a contact from another company and an
 * unknown column are refused; a move is stamped, placed and put on the
 * company's Timeline, and a drop reorders the target column.
 */

const prismaMock = vi.hoisted(() => ({
  companyList: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    aggregate: vi.fn(),
  },
  user: { findUnique: vi.fn() },
  companyEvent: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

import {
  completeOrderBoardUpdate,
  parseOrderBoardFields,
  toBoardCard,
  updateBoardList,
} from '../../src/orderBoard';

function list(over: Record<string, any> = {}): any {
  return {
    id: 7,
    companyId: 3,
    name: 'Summer list',
    printer: 'schneider',
    numberOfCards: 192,
    numberOfBoxes: 0,
    calculationTromp: null,
    calculationSchneider: null,
    buyPrice: 600,
    sellPrice: 1000,
    sold: false,
    desiredDeliveryDate: null,
    deliveryAsap: false,
    orderStatus: 'interest',
    orderStatusAt: null,
    orderPosition: 0,
    orderNote: null,
    orderArchived: false,
    contactUserId: null,
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    Company: { id: 3, name: 'Acme', contact: 'Jan Jansen', contactemail: 'jan@acme.nl', contactphone: '0612345678' },
    ContactUser: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockResolvedValue([]);
  prismaMock.companyList.aggregate.mockResolvedValue({ _min: { orderPosition: 0 } });
});

describe('toBoardCard', () => {
  it('reads reseller, quantity and card count from the calculator of the list\'s own printer', () => {
    const card = toBoardCard(
      list({
        calculationSchneider: JSON.stringify({ quantity: 250, cardCount: 96, isReseller: true }),
        // The other printer's calculation is not this list's.
        calculationTromp: JSON.stringify({ quantity: 10, isReseller: false }),
      })
    );
    expect(card.isReseller).toBe(true);
    expect(card.boxes).toBe(250);
    expect(card.cardsPerBox).toBe(96);
    expect(card.printer).toBe('schneider');
  });

  it('prefers numberOfBoxes and falls back to numberOfCards', () => {
    const card = toBoardCard(list({ numberOfBoxes: 120, calculationSchneider: '{"quantity":50}' }));
    expect(card.boxes).toBe(120);
    expect(card.cardsPerBox).toBe(192);
    expect(card.isReseller).toBe(false);
  });

  it('survives a broken calculation', () => {
    const card = toBoardCard(list({ calculationSchneider: '{not json' }));
    expect(card.boxes).toBe(0);
    expect(card.isReseller).toBe(false);
  });

  it('gives the profit only when both prices are known', () => {
    expect(toBoardCard(list()).profit).toBe(400);
    expect(toBoardCard(list({ buyPrice: null })).profit).toBeNull();
    expect(toBoardCard(list({ sellPrice: null })).profit).toBeNull();
  });

  it('shows a Tromp list\'s printing type and its license when Tromp sold it', () => {
    const card = toBoardCard(
      list({
        printer: 'qrsong',
        calculationTromp: JSON.stringify({
          quantity: 500,
          printingType: 'voorbedrukt',
          trompSold: true,
          licenseCards: 100,
        }),
      })
    );
    expect(card.printer).toBe('qrsong');
    expect(card.trompPrintingType).toBe('voorbedrukt');
    expect(card.trompSold).toBe(true);
    expect(card.cardsPerBox).toBe(100);
    expect(card.boxes).toBe(500);
  });

  it('shows the picked contact, else the company\'s own', () => {
    const picked = toBoardCard(
      list({
        contactUserId: 9,
        ContactUser: { id: 9, displayName: 'Piet', email: 'piet@acme.nl', phone: null },
      })
    );
    expect(picked.contact).toEqual({ name: 'Piet', email: 'piet@acme.nl', phone: null, fromCompany: false });

    const fallback = toBoardCard(list());
    expect(fallback.contact).toEqual({
      name: 'Jan Jansen',
      email: 'jan@acme.nl',
      phone: '0612345678',
      fromCompany: true,
    });

    const none = toBoardCard(list({ Company: { id: 3, name: 'Acme', contact: null, contactemail: null, contactphone: null } }));
    expect(none.contact).toBeNull();
  });

  it('reads an unknown stored column as Interest', () => {
    expect(toBoardCard(list({ orderStatus: 'bogus' })).orderStatus).toBe('interest');
  });
});

describe('parseOrderBoardFields', () => {
  it('takes only the fields the body carries', () => {
    expect(parseOrderBoardFields({})).toEqual({ data: {} });
    expect(parseOrderBoardFields({ orderStatus: 'agreed' })).toEqual({ data: { orderStatus: 'agreed' } });
  });

  it('refuses an unknown column', () => {
    expect(parseOrderBoardFields({ orderStatus: 'won' })).toHaveProperty('error');
  });

  it('trims the note, empties it to null and refuses a long one', () => {
    expect(parseOrderBoardFields({ orderNote: '  call back  ' })).toEqual({ data: { orderNote: 'call back' } });
    expect(parseOrderBoardFields({ orderNote: '   ' })).toEqual({ data: { orderNote: null } });
    expect(parseOrderBoardFields({ orderNote: 'x'.repeat(501) })).toHaveProperty('error');
    expect(parseOrderBoardFields({ orderNote: 5 })).toHaveProperty('error');
  });

  it('takes the deadline as a day at 12:00 UTC, and ASAP as a flag', () => {
    expect(parseOrderBoardFields({ desiredDeliveryDate: '2026-11-20' })).toEqual({
      data: { desiredDeliveryDate: new Date('2026-11-20T12:00:00.000Z') },
    });
    expect(parseOrderBoardFields({ desiredDeliveryDate: null, deliveryAsap: true })).toEqual({
      data: { desiredDeliveryDate: null, deliveryAsap: true },
    });
    expect(parseOrderBoardFields({ desiredDeliveryDate: 'soon' })).toHaveProperty('error');
    expect(parseOrderBoardFields({ deliveryAsap: 'yes' })).toHaveProperty('error');
  });

  it('checks the contact id and the archive flag', () => {
    expect(parseOrderBoardFields({ contactUserId: null })).toEqual({ data: { contactUserId: null } });
    expect(parseOrderBoardFields({ contactUserId: '12' })).toEqual({ data: { contactUserId: 12 } });
    expect(parseOrderBoardFields({ contactUserId: 'abc' })).toHaveProperty('error');
    expect(parseOrderBoardFields({ orderArchived: 'yes' })).toHaveProperty('error');
  });
});

describe('completeOrderBoardUpdate', () => {
  it('refuses a contact from another company', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ companyId: 99 });
    const result = await completeOrderBoardUpdate({ contactUserId: 9 }, list());
    expect(result).toHaveProperty('error');
  });

  it('accepts a user of the list\'s company', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ companyId: 3 });
    const result = await completeOrderBoardUpdate({ contactUserId: 9 }, list());
    expect(result).toEqual({ statusChange: null });
  });

  it('drops an unchanged column without stamping it', async () => {
    const data: Record<string, any> = { orderStatus: 'interest' };
    expect(await completeOrderBoardUpdate(data, list())).toEqual({ statusChange: null });
    expect(data).toEqual({});
  });

  it('stamps a move and puts the list on top of its new column', async () => {
    prismaMock.companyList.aggregate.mockResolvedValue({ _min: { orderPosition: 2 } });
    const data: Record<string, any> = { orderStatus: 'agreed' };
    const result = await completeOrderBoardUpdate(data, list());
    expect(result).toEqual({ statusChange: { from: 'interest', to: 'agreed' } });
    expect(data.orderStatusAt).toBeInstanceOf(Date);
    expect(data.orderPosition).toBe(1);
  });
});

describe('updateBoardList', () => {
  it('moves a dropped list, renumbers the target column and writes the Timeline', async () => {
    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 3,
      name: 'Summer list',
      orderStatus: 'contact',
    });
    prismaMock.companyList.findUniqueOrThrow.mockResolvedValue(
      list({ orderStatus: 'offer_sent', orderPosition: 1 })
    );

    const result = await updateBoardList(7, { orderStatus: 'offer_sent', orderIds: [4, 7, 5] }, 1);

    expect(result.success).toBe(true);
    expect(prismaMock.companyList.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({ orderStatus: 'offer_sent', orderPosition: 1 }),
    });
    expect(prismaMock.companyList.updateMany).toHaveBeenCalledWith({
      where: { id: 4, orderStatus: 'offer_sent' },
      data: { orderPosition: 0 },
    });
    expect(prismaMock.companyList.updateMany).toHaveBeenCalledWith({
      where: { id: 5, orderStatus: 'offer_sent' },
      data: { orderPosition: 2 },
    });
    expect(prismaMock.companyEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 3,
        userId: 1,
        type: 'status_change',
        content: 'Order status of “Summer list”: Contact → Sent offer',
      }),
    });
  });

  it('reorders within a column without a Timeline line', async () => {
    prismaMock.companyList.findUnique.mockResolvedValue({
      id: 7,
      companyId: 3,
      name: 'Summer list',
      orderStatus: 'contact',
    });
    prismaMock.companyList.findUniqueOrThrow.mockResolvedValue(list({ orderStatus: 'contact' }));

    const result = await updateBoardList(7, { orderStatus: 'contact', orderIds: [7, 4] }, 1);

    expect(result.success).toBe(true);
    expect(prismaMock.companyList.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { orderPosition: 0 },
    });
    expect(prismaMock.companyEvent.create).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown list and 400 for bad order ids', async () => {
    prismaMock.companyList.findUnique.mockResolvedValue(null);
    expect(await updateBoardList(7, { orderNote: 'x' }, 1)).toMatchObject({ success: false, status: 404 });
    expect(await updateBoardList(7, { orderIds: ['a'] }, 1)).toMatchObject({ success: false, status: 400 });
    expect(await updateBoardList(7, {}, 1)).toMatchObject({ success: false, status: 400 });
  });
});
