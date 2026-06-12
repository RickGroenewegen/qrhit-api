import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  storePlaylists,
  getPlaylist,
  getPlaylistsByPaymentId,
  getPlaylistBySlug,
  updatePaymentHasPlaylist,
  updatePlaylistDetails,
  deletePlaylistFromOrder,
  updatePlaylistAmount,
  changePlaylistType,
  updateGamesEnabled,
  updateAddHowToCard,
  updateHowToCardImage,
  resetJudgedStatus,
  updatePlaylistBlocked,
  loadBlocked,
  loadBlockedFromCache,
  buildMusicMatchExport,
  BLOCKED_PLAYLISTS_CACHE_KEY,
} from '../../../src/data/playlists';

/**
 * Pure unit tests for src/data/playlists.ts. All functions take a DataDeps
 * object, so every collaborator is a plain literal with vi.fn()s — no DB,
 * no Redis, no network.
 */

/** Flatten a tagged-template $queryRaw/$executeRaw call into { sql, values }. */
function flatten(call: any[]) {
  const [strings, ...values] = call;
  const q = (Prisma.sql as any)(strings, ...values);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), values: q.values };
}

function makeCache() {
  const arrays = new Map<string, string[]>();
  return {
    arrays,
    get: vi.fn(async (k: string) => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async (k: string) => {
      arrays.delete(k);
    }),
    setArray: vi.fn(async (k: string, v: string[]) => {
      arrays.set(k, v);
    }),
    getArray: vi.fn(async (k: string) => arrays.get(k) ?? null),
  };
}

function makeDeps() {
  const prisma = {
    playlist: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    paymentHasPlaylist: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(async () => ({})),
      count: vi.fn(),
      delete: vi.fn(async () => ({})),
    },
    payment: { update: vi.fn(async () => ({})) },
    orderType: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const cache = makeCache();
  return {
    deps: {
      prisma,
      cache,
      logger: { log: vi.fn() },
      appTheme: { reload: vi.fn(async () => undefined) },
      utils: { isMainServer: vi.fn(async () => true) },
      blockedPlaylists: new Set<number>(),
    } as any,
    prisma,
    cache,
  };
}

const baseCartItem = {
  playlistId: 'pl1',
  playlistName: 'My List!',
  image: 'img.jpg',
  price: 30,
  numberOfTracks: 10,
  productType: 'cards',
  type: 'physical',
  isSlug: false,
} as any;

describe('storePlaylists', () => {
  it('creates a new playlist with a slugified name and spotify default serviceType', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue(null);
    prisma.playlist.create.mockResolvedValue({ id: 7 });

    const ids = await storePlaylists(deps, 1, [{ ...baseCartItem }]);

    expect(ids).toEqual([7]);
    expect(prisma.playlist.create).toHaveBeenCalledWith({
      data: {
        playlistId: 'pl1',
        name: 'My List!',
        slug: 'my-list',
        image: 'img.jpg',
        price: 30,
        numberOfTracks: 10,
        type: 'cards',
        serviceType: 'spotify',
        giftcardAmount: 0,
        giftcardFrom: '',
        giftcardMessage: '',
        design: null,
      },
    });
  });

  it('computes giftcard amount as price minus extraPrice for physical giftcards', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue(null);
    prisma.playlist.create.mockResolvedValue({ id: 8 });

    await storePlaylists(deps, 1, [
      {
        ...baseCartItem,
        productType: 'giftcard',
        type: 'physical',
        extraPrice: 5,
        fromName: 'Rick',
        personalMessage: 'Enjoy!',
      },
    ]);

    const data = prisma.playlist.create.mock.calls[0][0].data;
    expect(data.giftcardAmount).toBe(25);
    expect(data.giftcardFrom).toBe('Rick');
    expect(data.giftcardMessage).toBe('Enjoy!');
  });

  it('digital giftcards keep the full price as giftcard amount', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue(null);
    prisma.playlist.create.mockResolvedValue({ id: 9 });

    await storePlaylists(deps, 1, [
      {
        ...baseCartItem,
        productType: 'giftcard',
        type: 'digital',
        extraPrice: 5, // must be ignored for digital
        fromName: 'A',
        personalMessage: 'B',
      },
    ]);

    expect(prisma.playlist.create.mock.calls[0][0].data.giftcardAmount).toBe(30);
  });

  it('a negative price still creates the playlist with giftcardAmount 0 for non-giftcards', async () => {
    // Covers the price<0 guard; note it only re-zeros an already-zero
    // extraPrice, so it is effectively a no-op (suspected leftover guard).
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue(null);
    prisma.playlist.create.mockResolvedValue({ id: 10 });

    await storePlaylists(deps, 1, [{ ...baseCartItem, price: -10 }]);

    const data = prisma.playlist.create.mock.calls[0][0].data;
    expect(data.price).toBe(-10);
    expect(data.giftcardAmount).toBe(0);
  });

  it('resolves slugs to the real playlistId before lookup', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findFirst.mockResolvedValue({ playlistId: 'real-id' });
    prisma.playlist.findUnique.mockResolvedValue(null);
    prisma.playlist.create.mockResolvedValue({ id: 11 });

    await storePlaylists(deps, 1, [
      { ...baseCartItem, playlistId: 'my-list', isSlug: true },
    ]);

    expect(prisma.playlist.findFirst).toHaveBeenCalledWith({
      where: { slug: 'my-list' },
    });
    expect(prisma.playlist.findUnique).toHaveBeenCalledWith({
      where: { playlistId: 'real-id' },
    });
    expect(prisma.playlist.create.mock.calls[0][0].data.playlistId).toBe('real-id');
  });

  it('updates an existing non-featured playlist and sets resetCache when requested', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({
      id: 3,
      featured: false,
      serviceType: 'tidal',
    });

    const ids = await storePlaylists(
      deps,
      1,
      [{ ...baseCartItem, price: 25, numberOfTracks: 12, playlistName: 'Renamed' }],
      true
    );

    expect(ids).toEqual([3]);
    expect(prisma.playlist.create).not.toHaveBeenCalled();
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: {
        price: 25,
        numberOfTracks: 12,
        name: 'Renamed',
        serviceType: 'tidal', // falls back to stored serviceType
        resetCache: true,
      },
    });
  });

  it('never resets the cache for featured playlists', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findUnique.mockResolvedValue({
      id: 4,
      featured: true,
      serviceType: null,
    });

    await storePlaylists(deps, 1, [{ ...baseCartItem }], true);

    const data = prisma.playlist.update.mock.calls[0][0].data;
    expect(data.resetCache).toBe(false);
    expect(data.serviceType).toBe('spotify'); // null stored type -> default
  });
});

describe('getPlaylist', () => {
  it('returns the first raw row for the given playlistId', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValue([{ id: 1, name: 'X' }, { id: 2 }]);

    const result = await getPlaylist(deps, 'pl1');

    expect(result).toEqual({ id: 1, name: 'X' });
    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain('FROM playlists');
    expect(sql).toContain('playlists.playlistId = ?');
    expect(values).toEqual(['pl1']);
  });
});

describe('getPlaylistsByPaymentId', () => {
  it('queries by paymentId only when no playlistId is given', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 1 }]);

    const rows = await getPlaylistsByPaymentId(deps, 'pay_1');

    expect(rows).toEqual([{ id: 1 }]);
    const [query, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(params).toEqual(['pay_1']);
    expect(query).not.toContain('AND playlists.playlistId = ?');
    expect(query).toContain('payments.paymentId = ?');
  });

  it('appends a playlistId filter and parameter when provided', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    await getPlaylistsByPaymentId(deps, 'pay_1', 'pl9');

    const [query, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(params).toEqual(['pay_1', 'pl9']);
    expect(query).toContain('AND playlists.playlistId = ?');
  });
});

describe('getPlaylistBySlug', () => {
  it('selects only id and playlistId', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findFirst.mockResolvedValue({ id: 1, playlistId: 'pl1' });

    const res = await getPlaylistBySlug(deps, 'a-slug');

    expect(res).toEqual({ id: 1, playlistId: 'pl1' });
    expect(prisma.playlist.findFirst).toHaveBeenCalledWith({
      where: { slug: 'a-slug' },
      select: { id: true, playlistId: true },
    });
  });
});

describe('updatePaymentHasPlaylist', () => {
  it('fails when the line item does not exist', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);

    const res = await updatePaymentHasPlaylist(deps, 1, true, false);

    expect(res).toEqual({ success: false, error: 'PaymentHasPlaylist not found' });
    expect(prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
  });

  it('updates only eco/doubleSided when no optionals are given', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ playlistId: 20 });

    const res = await updatePaymentHasPlaylist(deps, 1, true, false);

    expect(res).toEqual({ success: true });
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { eco: true, doubleSided: false },
    });
    expect(prisma.playlist.update).not.toHaveBeenCalled();
    expect(deps.appTheme.reload).not.toHaveBeenCalled();
  });

  it('applies printerType, theme, box and template updates and reloads themes', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ playlistId: 20 });

    const res = await updatePaymentHasPlaylist(
      deps,
      1,
      false,
      true,
      'tromp',
      'tpl-x',
      '{"a":1}',
      'Dark',
      2
    );

    expect(res).toEqual({ success: true });
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        eco: false,
        doubleSided: true,
        printerType: 'tromp',
        boxQuantity: 2,
        boxEnabled: true,
        theme: '{"a":1}',
        themeName: 'Dark',
      },
    });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: { template: 'tpl-x' },
    });
    expect(deps.appTheme.reload).toHaveBeenCalledTimes(1);
  });

  it('boxQuantity 0 disables the box', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ playlistId: 20 });

    await updatePaymentHasPlaylist(deps, 1, true, true, undefined, undefined, undefined, undefined, 0);

    const data = prisma.paymentHasPlaylist.update.mock.calls[0][0].data;
    expect(data.boxQuantity).toBe(0);
    expect(data.boxEnabled).toBe(false);
  });

  it('returns the error message when the update throws', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ playlistId: 20 });
    prisma.paymentHasPlaylist.update.mockRejectedValue(new Error('db down'));

    const res = await updatePaymentHasPlaylist(deps, 1, true, false);

    expect(res).toEqual({ success: false, error: 'db down' });
  });
});

describe('updatePlaylistDetails', () => {
  it('fails when the line item does not exist', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);

    const res = await updatePlaylistDetails(deps, 1, 50);
    expect(res).toEqual({ success: false, error: 'PaymentHasPlaylist not found' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('updates both tables in a transaction and includes appleStoreFront when given', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ playlistId: 20 });

    const res = await updatePlaylistDetails(deps, 1, 50, 'us');

    expect(res).toEqual({ success: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { numberOfTracks: 50, appleStoreFront: 'us' },
    });
    expect(prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: { numberOfTracks: 50 },
    });
  });

  it('omits appleStoreFront when not provided', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ playlistId: 20 });

    await updatePlaylistDetails(deps, 1, 50);

    expect(prisma.paymentHasPlaylist.update.mock.calls[0][0].data).toEqual({
      numberOfTracks: 50,
    });
  });

  it('reports transaction failures', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ playlistId: 20 });
    prisma.$transaction.mockRejectedValue(new Error('tx failed'));

    const res = await updatePlaylistDetails(deps, 1, 50);
    expect(res).toEqual({ success: false, error: 'tx failed' });
  });
});

describe('deletePlaylistFromOrder', () => {
  it('refuses to delete the last playlist of an order', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({
      paymentId: 10,
      playlistId: 20,
    });
    prisma.paymentHasPlaylist.count.mockResolvedValue(1);

    const res = await deletePlaylistFromOrder(deps, 1);

    expect(res).toEqual({
      success: false,
      error: 'Cannot delete the last playlist from an order',
    });
    expect(prisma.paymentHasPlaylist.delete).not.toHaveBeenCalled();
    expect(prisma.paymentHasPlaylist.count).toHaveBeenCalledWith({
      where: { paymentId: 10 },
    });
  });

  it('deletes when the order has multiple playlists', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({
      paymentId: 10,
      playlistId: 20,
    });
    prisma.paymentHasPlaylist.count.mockResolvedValue(2);

    const res = await deletePlaylistFromOrder(deps, 1);

    expect(res).toEqual({ success: true });
    expect(prisma.paymentHasPlaylist.delete).toHaveBeenCalledWith({
      where: { id: 1 },
    });
  });

  it('fails when the line item does not exist', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);
    const res = await deletePlaylistFromOrder(deps, 1);
    expect(res).toEqual({ success: false, error: 'PaymentHasPlaylist not found' });
  });

  it('reports delete failures', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({
      paymentId: 10,
      playlistId: 20,
    });
    prisma.paymentHasPlaylist.count.mockResolvedValue(2);
    prisma.paymentHasPlaylist.delete.mockRejectedValue(new Error('fk'));

    const res = await deletePlaylistFromOrder(deps, 1);
    expect(res).toEqual({ success: false, error: 'fk' });
  });
});

describe('updatePlaylistAmount', () => {
  it('updates the amount', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 1 });

    const res = await updatePlaylistAmount(deps, 1, 3);

    expect(res).toEqual({ success: true });
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { amount: 3 },
    });
  });

  it('fails for unknown line items', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);
    const res = await updatePlaylistAmount(deps, 1, 3);
    expect(res).toEqual({ success: false, error: 'PaymentHasPlaylist not found' });
  });

  it('reports update failures', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 1 });
    prisma.paymentHasPlaylist.update.mockRejectedValue(new Error('oops'));
    const res = await updatePlaylistAmount(deps, 1, 3);
    expect(res).toEqual({ success: false, error: 'oops' });
  });
});

describe('changePlaylistType', () => {
  const php = {
    id: 1,
    paymentId: 10,
    playlistId: 20,
    type: 'digital',
    subType: null,
    numberOfTracks: 120,
    payment: { paymentId: 'tr_abc' },
  };

  it('rejects an unknown productType', async () => {
    const { deps } = makeDeps();
    const res = await changePlaylistType(deps, 1, 'foo' as any);
    expect(res).toEqual({ success: false, error: 'Invalid productType: foo' });
  });

  it('is a no-op when the line item already has the requested type (null subType counts as none)', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ ...php });

    const res = await changePlaylistType(deps, 1, 'digital');

    expect(res).toEqual({ success: true, paymentId: 'tr_abc', changed: false });
    expect(prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
  });

  it('refuses when another line item occupies the target type/subType', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ ...php });
    prisma.paymentHasPlaylist.findFirst.mockResolvedValue({ id: 99 });

    const res = await changePlaylistType(deps, 1, 'cards');

    expect(res.success).toBe(false);
    expect(res.error).toContain('#99');
    expect(prisma.paymentHasPlaylist.findFirst).toHaveBeenCalledWith({
      where: {
        paymentId: 10,
        playlistId: 20,
        type: 'physical',
        subType: 'none',
        id: { not: 1 },
      },
      select: { id: true },
    });
  });

  it('switches digital -> cards: picks the smallest fitting tier and resets printer state', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ ...php });
    prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
    prisma.orderType.findFirst.mockResolvedValueOnce({ id: 5 });

    const res = await changePlaylistType(deps, 1, 'cards');

    expect(res).toEqual({ success: true, paymentId: 'tr_abc', changed: true });
    expect(prisma.orderType.findFirst).toHaveBeenCalledWith({
      where: { type: 'cards', digital: false, maxCards: { gte: 120 } },
      orderBy: { maxCards: 'asc' },
      select: { id: true },
    });
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        type: 'physical',
        subType: 'none',
        orderTypeId: 5,
        printApiUploaded: false,
        eligableForPrinter: false,
        eligableForPrinterAt: null,
        filename: null,
        filenameDigital: null,
      },
    });
  });

  it('falls back to the largest physical tier when track count exceeds all tiers', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ ...php });
    prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
    prisma.orderType.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 6 });

    const res = await changePlaylistType(deps, 1, 'sheets');

    expect(res.changed).toBe(true);
    expect(prisma.orderType.findFirst).toHaveBeenNthCalledWith(2, {
      where: { type: 'sheets', digital: false },
      orderBy: { maxCards: 'desc' },
      select: { id: true },
    });
    expect(prisma.paymentHasPlaylist.update.mock.calls[0][0].data.subType).toBe(
      'sheets'
    );
  });

  it('switching to digital does not constrain on maxCards', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({
      ...php,
      type: 'physical',
      subType: 'none',
    });
    prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
    prisma.orderType.findFirst.mockResolvedValueOnce({ id: 2 });

    await changePlaylistType(deps, 1, 'digital');

    expect(prisma.orderType.findFirst).toHaveBeenCalledWith({
      where: { type: 'cards', digital: true },
      orderBy: { maxCards: 'asc' },
      select: { id: true },
    });
  });

  it('errors when no OrderType matches', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ ...php });
    prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
    prisma.orderType.findFirst.mockResolvedValue(null);

    const res = await changePlaylistType(deps, 1, 'cards');

    expect(res.success).toBe(false);
    expect(res.error).toContain('No matching OrderType');
    expect(prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
  });

  it('fails when the line item does not exist', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);
    const res = await changePlaylistType(deps, 1, 'cards');
    expect(res).toEqual({ success: false, error: 'PaymentHasPlaylist not found' });
  });

  it('reports unexpected errors during the update', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ ...php });
    prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
    prisma.orderType.findFirst.mockResolvedValueOnce({ id: 5 });
    prisma.paymentHasPlaylist.update.mockRejectedValue(new Error('deadlock'));

    const res = await changePlaylistType(deps, 1, 'cards');
    expect(res).toEqual({ success: false, error: 'deadlock' });
  });
});

describe('small toggle updaters', () => {
  it('updateGamesEnabled updates the flag', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 1 });
    const res = await updateGamesEnabled(deps, 1, true);
    expect(res).toEqual({ success: true });
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { gamesEnabled: true },
    });
  });

  it('updateGamesEnabled fails for missing playlists', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);
    const res = await updateGamesEnabled(deps, 1, true);
    expect(res).toEqual({ success: false, error: 'Playlist not found' });
  });

  it('updateAddHowToCard includes the locale only when given', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 1 });

    await updateAddHowToCard(deps, 1, true, 'nl');
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { addHowToCard: true, addHowToCardLocale: 'nl' },
    });

    prisma.paymentHasPlaylist.update.mockClear();
    await updateAddHowToCard(deps, 1, false);
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { addHowToCard: false },
    });
  });

  it('updateHowToCardImage sets and clears the image', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 1 });

    const res = await updateHowToCardImage(deps, 1, null);
    expect(res).toEqual({ success: true });
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { howToCardImage: null },
    });
  });

  it('resetJudgedStatus resets both line item and payment flags in a transaction', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 1, paymentId: 10 });

    const res = await resetJudgedStatus(deps, 1);

    expect(res).toEqual({ success: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { userConfirmedPrinting: false },
    });
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { userAgreedToPrinting: false },
    });
  });

  it('every toggle updater fails cleanly for missing rows and on update errors', async () => {
    // not-found branches
    for (const fn of [
      () => updateAddHowToCard(makeMissing(), 1, true),
      () => updateHowToCardImage(makeMissing(), 1, 'x'),
      () => resetJudgedStatus(makeMissing(), 1),
    ]) {
      const res = await fn();
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/not found/i);
    }

    // catch branches
    const broken = () => {
      const { deps, prisma } = makeDeps();
      prisma.paymentHasPlaylist.findUnique.mockResolvedValue({
        id: 1,
        paymentId: 10,
      });
      prisma.paymentHasPlaylist.update.mockRejectedValue(new Error('err'));
      prisma.$transaction.mockRejectedValue(new Error('err'));
      return deps;
    };
    expect(await updateGamesEnabled(broken(), 1, true)).toEqual({
      success: false,
      error: 'err',
    });
    expect(await updateAddHowToCard(broken(), 1, true)).toEqual({
      success: false,
      error: 'err',
    });
    expect(await updateHowToCardImage(broken(), 1, 'x')).toEqual({
      success: false,
      error: 'err',
    });
    expect(await resetJudgedStatus(broken(), 1)).toEqual({
      success: false,
      error: 'err',
    });

    function makeMissing() {
      const { deps, prisma } = makeDeps();
      prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);
      return deps;
    }
  });
});

describe('updatePlaylistBlocked', () => {
  it('blocks: adds to the in-memory set and writes the Redis array', async () => {
    const { deps, prisma, cache } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 5 });

    const res = await updatePlaylistBlocked(deps, 5, true);

    expect(res).toEqual({ success: true });
    expect(prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { blocked: true },
    });
    expect(deps.blockedPlaylists.has(5)).toBe(true);
    expect(cache.setArray).toHaveBeenCalledWith(BLOCKED_PLAYLISTS_CACHE_KEY, ['5']);
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('unblocking the last playlist deletes the cache key instead', async () => {
    const { deps, prisma, cache } = makeDeps();
    deps.blockedPlaylists.add(5);
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 5 });

    const res = await updatePlaylistBlocked(deps, 5, false);

    expect(res).toEqual({ success: true });
    expect(deps.blockedPlaylists.size).toBe(0);
    expect(cache.setArray).not.toHaveBeenCalled();
    expect(cache.del).toHaveBeenCalledWith(BLOCKED_PLAYLISTS_CACHE_KEY);
  });

  it('fails for unknown playlists', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);
    const res = await updatePlaylistBlocked(deps, 5, true);
    expect(res).toEqual({ success: false, error: 'Playlist not found' });
  });

  it('reports update failures without touching the cache', async () => {
    const { deps, prisma, cache } = makeDeps();
    prisma.paymentHasPlaylist.findUnique.mockResolvedValue({ id: 5 });
    prisma.paymentHasPlaylist.update.mockRejectedValue(new Error('locked'));

    const res = await updatePlaylistBlocked(deps, 5, true);
    expect(res).toEqual({ success: false, error: 'locked' });
    expect(cache.setArray).not.toHaveBeenCalled();
  });
});

describe('loadBlocked', () => {
  // Note: cluster.isPrimary is true inside the Vitest fork, so the
  // main-server branch is reachable via deps.utils.isMainServer.
  it('replaces the in-memory set and stores ids in Redis on the main server', async () => {
    const { deps, prisma, cache } = makeDeps();
    deps.blockedPlaylists.add(999); // stale entry must be cleared
    prisma.paymentHasPlaylist.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    await loadBlocked(deps);

    expect(prisma.paymentHasPlaylist.findMany).toHaveBeenCalledWith({
      where: { blocked: true },
      select: { id: true },
    });
    expect([...deps.blockedPlaylists]).toEqual([1, 2]);
    expect(cache.setArray).toHaveBeenCalledWith(BLOCKED_PLAYLISTS_CACHE_KEY, ['1', '2']);
  });

  it('clears the cache key when nothing is blocked', async () => {
    const { deps, prisma, cache } = makeDeps();
    prisma.paymentHasPlaylist.findMany.mockResolvedValue([]);

    await loadBlocked(deps);

    expect(cache.setArray).not.toHaveBeenCalled();
    expect(cache.del).toHaveBeenCalledWith(BLOCKED_PLAYLISTS_CACHE_KEY);
  });

  it('does not touch Redis on non-main servers (ENVIRONMENT=test)', async () => {
    const { deps, prisma, cache } = makeDeps();
    deps.utils.isMainServer.mockResolvedValue(false);
    prisma.paymentHasPlaylist.findMany.mockResolvedValue([{ id: 1 }]);

    await loadBlocked(deps);

    expect(deps.blockedPlaylists.has(1)).toBe(true); // set still updated
    expect(cache.setArray).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('swallows database errors and logs them', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findMany.mockRejectedValue(new Error('boom'));

    await expect(loadBlocked(deps)).resolves.toBeUndefined();
    expect(deps.logger.log).toHaveBeenCalled();
  });
});

describe('loadBlockedFromCache', () => {
  it('hydrates the set from the cached id array without hitting the DB', async () => {
    const { deps, prisma, cache } = makeDeps();
    cache.arrays.set(BLOCKED_PLAYLISTS_CACHE_KEY, ['3', '4']);

    await loadBlockedFromCache(deps);

    expect([...deps.blockedPlaylists]).toEqual([3, 4]);
    expect(prisma.paymentHasPlaylist.findMany).not.toHaveBeenCalled();
  });

  it('falls back to the database when the cache is empty', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findMany.mockResolvedValue([{ id: 7 }]);

    await loadBlockedFromCache(deps);

    expect(prisma.paymentHasPlaylist.findMany).toHaveBeenCalled();
    expect(deps.blockedPlaylists.has(7)).toBe(true);
  });

  it('swallows cache errors', async () => {
    const { deps, cache } = makeDeps();
    cache.getArray.mockRejectedValue(new Error('redis gone'));

    await expect(loadBlockedFromCache(deps)).resolves.toBeUndefined();
    expect(deps.logger.log).toHaveBeenCalled();
  });
});

describe('buildMusicMatchExport', () => {
  it('exports musicmatch spotify playlists with short-coded links and drops empty ones', async () => {
    const { deps, prisma } = makeDeps();
    prisma.paymentHasPlaylist.findMany.mockResolvedValue([
      {
        id: 1,
        playlist: {
          name: 'A',
          tracks: [
            {
              track: {
                id: 11,
                trackId: 't11',
                spotifyLink: 'sp-link',
                youtubeMusicLink: 'ym-link',
                deezerLink: 'dz-link',
                appleMusicLink: 'am-link',
                tidalLink: 'td-link',
              },
            },
            // missing trackId -> filtered out
            {
              track: {
                id: 12,
                trackId: null,
                spotifyLink: 'x',
              },
            },
          ],
        },
      },
      // all tracks unusable -> whole playlist dropped
      {
        id: 2,
        playlist: { name: 'B', tracks: [{ track: { id: 13, trackId: null } }] },
      },
    ]);

    const before = Math.floor(Date.now() / 1000);
    const result = await buildMusicMatchExport(deps);
    const after = Math.floor(Date.now() / 1000);

    expect(prisma.paymentHasPlaylist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          printerType: 'musicmatch',
          playlist: { serviceType: 'spotify' },
        },
        orderBy: { id: 'asc' },
      })
    );
    expect(result.h).toBe(true);
    expect(result.t).toBeGreaterThanOrEqual(before);
    expect(result.t).toBeLessThanOrEqual(after);
    expect(result.p).toEqual([
      {
        i: 1,
        n: 'A',
        t: [
          {
            i: 11,
            l: 't11',
            ln: {
              sp: 'sp-link',
              am: 'am-link',
              dz: 'dz-link',
              td: 'td-link',
              ym: 'ym-link',
            },
          },
        ],
      },
    ]);
  });
});
