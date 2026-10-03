import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

/**
 * GET /api/account/order-again/:paymentHasPlaylistId on a bare Fastify
 * instance: one past order line as "Order again" needs it, only for its owner.
 */

const h = vi.hoisted(() => ({
  lines: new Map<number, any>(),
}));

vi.mock('../../../src/prisma', () => ({
  default: {
    getInstance: () => ({
      user: {
        findUnique: async ({ where }: any) =>
          ({ 'anna@example.com': { id: 7 }, 'bob@example.com': { id: 8 } })[where.userId as string] ?? null,
      },
      paymentHasPlaylist: {
        findUnique: async ({ where }: any) => h.lines.get(where.id) ?? null,
      },
    }),
  },
}));
vi.mock('../../../src/account', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/mail', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/loginRateLimiter', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/auth', () => ({}));
vi.mock('../../../src/cookieAuth', () => ({ setAuthCookie: () => {}, clearAuthCookie: () => {} }));

import accountRoutes from '../../../src/routes/accountRoutes';

function line(overrides: Record<string, any> = {}) {
  return {
    id: 12,
    type: 'physical',
    subType: 'none',
    eco: false,
    doubleSided: true,
    allowDuplicates: true,
    gamesEnabled: true,
    background: 'front.png',
    qrColor: '#112233',
    selectedFont: 'Oswald',
    boxEnabled: true,
    boxFrontBackground: 'box-front.png',
    boxBackText: 'Happy 40th',
    payment: { userId: 7, status: 'paid', vibe: false },
    playlist: { playlistId: 'sp-1', serviceType: 'spotify', type: 'cards', name: 'Road Trip Hits', image: 'cover.jpg' },
    extraDesigns: [{ background: 'second.png', qrColor: '#445566' }],
    ...overrides,
  };
}

let app: FastifyInstance;
let currentUser = 'anna@example.com';

beforeAll(async () => {
  app = Fastify();
  const getAuthHandler = () => ({
    preHandler: async (request: any) => {
      request.user = { userId: currentUser };
    },
  });
  await accountRoutes(app, null, getAuthHandler);
  await app.ready();
});

afterAll(() => app.close());

async function get(id: number | string, user = 'anna@example.com') {
  currentUser = user;
  return app.inject({ method: 'GET', url: `/api/account/order-again/${id}` });
}

describe('order again', () => {
  it('returns the playlist, card type, card designs and box of the owner\'s order line', async () => {
    h.lines.set(12, line());
    const res = await get(12);
    expect(res.statusCode).toBe(200);
    const { order } = res.json();
    expect(order).toMatchObject({
      paymentHasPlaylistId: 12,
      playlistId: 'sp-1',
      serviceType: 'spotify',
      type: 'physical',
      doubleSided: true,
      allowDuplicates: true,
      gamesEnabled: true,
    });
    expect(order.design).toMatchObject({ background: 'front.png', qrColor: '#112233', selectedFont: 'Oswald' });
    expect(order.design.boxFrontBackground).toBeUndefined();
    expect(order.extraDesigns).toEqual([expect.objectContaining({ background: 'second.png', qrColor: '#445566' })]);
    expect(order.box).toMatchObject({ boxFrontBackground: 'box-front.png', boxBackText: 'Happy 40th' });
  });

  it('gives sheets back as sheets and never a box with them', async () => {
    h.lines.set(13, line({ id: 13, subType: 'sheets' }));
    const { order } = (await get(13)).json();
    expect(order.type).toBe('sheets');
    expect(order.box).toBeNull();
  });

  it('has no box when the order had none', async () => {
    h.lines.set(14, line({ id: 14, boxEnabled: false }));
    expect((await get(14)).json().order.box).toBeNull();
  });

  it('is not found for someone else\'s order or an unpaid one', async () => {
    h.lines.set(12, line());
    expect((await get(12, 'bob@example.com')).statusCode).toBe(404);
    h.lines.set(15, line({ id: 15, payment: { userId: 7, status: 'open', vibe: false } }));
    expect((await get(15)).statusCode).toBe(404);
    expect((await get(999)).statusCode).toBe(404);
    expect((await get('abc')).statusCode).toBe(400);
  });

  it('refuses gift cards and business orders', async () => {
    h.lines.set(16, line({ id: 16, playlist: { ...line().playlist, type: 'giftcard' } }));
    h.lines.set(17, line({ id: 17, payment: { userId: 7, status: 'paid', vibe: true } }));
    expect((await get(16)).json()).toMatchObject({ success: false, error: 'notReorderable' });
    expect((await get(17)).statusCode).toBe(400);
  });
});
