import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { outbound } from '../../helpers/recording-mock';

/**
 * Pure unit tests for src/suggestion.ts. Prisma, generator, music providers,
 * data layer and cache are all mocked; pushover goes through the global
 * recording proxy from test/setup.ts. No database or Redis is touched.
 */

const h = vi.hoisted(() => ({
  prisma: {
    payment: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    playlist: { findFirst: vi.fn(), update: vi.fn() },
    paymentHasPlaylist: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    userSuggestion: {
      upsert: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    track: { update: vi.fn() },
    trackExtraInfo: { upsert: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
  queueGenerate: vi.fn(),
  queueDigitalRedesign: vi.fn(),
  sendToPrinter: vi.fn(),
  finalizeOrder: vi.fn(),
  ensureLineQrCodes: vi.fn(),
  getProviderByString: vi.fn(),
  provider: { getPlaylist: vi.fn(), getTracks: vi.fn() },
  getStorefrontForLocale: vi.fn(),
  clearPlaylistCache: vi.fn(),
  storeTracks: vi.fn(),
  cacheDel: vi.fn(),
  mollieInstances: [] as any[],
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));
vi.mock('../../../src/mollie', () => ({
  default: class FakeMollie {
    constructor() {
      h.mollieInstances.push(this);
    }
  },
}));
vi.mock('../../../src/generator', () => ({
  default: {
    getInstance: () => ({
      queueGenerate: h.queueGenerate,
      queueDigitalRedesign: h.queueDigitalRedesign,
      sendToPrinter: h.sendToPrinter,
      finalizeOrder: h.finalizeOrder,
      ensureLineQrCodes: h.ensureLineQrCodes,
    }),
  },
}));
vi.mock('../../../src/spotify', () => ({ default: class {} }));
vi.mock('../../../src/services/MusicServiceRegistry', () => ({
  default: {
    getInstance: () => ({ getProviderByString: h.getProviderByString }),
  },
}));
vi.mock('../../../src/providers/AppleMusicProvider', () => ({
  default: {
    getInstance: () => ({ getStorefrontForLocale: h.getStorefrontForLocale }),
  },
}));
vi.mock('../../../src/data', () => ({
  default: {
    getInstance: () => ({
      clearPlaylistCache: h.clearPlaylistCache,
      storeTracks: h.storeTracks,
    }),
  },
}));
vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({
      del: h.cacheDel,
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      // Settings.getSetting() takes a Redis lock around its DB read, so the
      // double needs the lock pair too - without acquireLock the call throws
      // and isAutoMode() swallows it as "not auto".
      acquireLock: vi.fn(async () => true),
      releaseLock: vi.fn(async () => undefined),
    }),
  },
}));

import Suggestion from '../../../src/suggestion';

const suggestion = Suggestion.getInstance();

// --- raw SQL routing -------------------------------------------------------
// Each distinct $queryRaw in suggestion.ts (and the findLineByHash it calls in
// src/lineOwner.ts) contains a unique marker string, so a single dispatching
// implementation can serve any combination of them. Only the template's own
// strings are searched: the Prisma.sql fragments it embeds are values.
const SQL = {
  line: "pm.status = 'paid'", // findLineByHash (verifyLine)
  trackCheck: 'AS playlistDBId', // saveUserSuggestion track-in-line check
  access: 'SELECT 1', // deleteUserSuggestion access check
  corrections: 'suggestionCount', // getCorrections
  suggestions: 'as originalName', // processCorrections suggestion diff rows
  printerReady: 'eligableForPrinter = true', // checkIfReadyForPrinter counts
  paidTracks: 'as paidTracks', // validateTrackCountForReload
  userTracks: 'hasSuggestion', // getUserSuggestions track rows
};

type RawRoute = [marker: string, result: any[] | (() => any[])];

function routeRaw(routes: RawRoute[]) {
  h.prisma.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join(' ');
      const hit = routes.find(([marker]) => sql.includes(marker));
      if (!hit) return [];
      return typeof hit[1] === 'function' ? hit[1]() : hit[1];
    }
  );
}

// One findLineByHash row, in OWNED_LINE_COLUMNS' aliases: line 30 (physical)
// of payment 10, held by its buyer, user 5.
function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    type: 'physical',
    subType: null,
    ownerUserId: null,
    paymentDbId: 10,
    paymentId: 'pay_1',
    buyerId: 5,
    playlistDbId: 20,
    playlistId: 'pl_1',
    ownerId: 5,
    ownerHash: 'hash_1',
    ownerEmail: 'rick@example.com',
    ownerName: 'Rick G',
    ownerLocale: 'nl',
    ...overrides,
  };
}

const ownedLine = (overrides: Record<string, unknown> = {}): RawRoute => [
  SQL.line,
  [lineRow(overrides)],
];

const OWNED = ownedLine();
const NO_LINE: RawRoute = [SQL.line, []];
// A redeemed gift: the line belongs to user 8 now, and hash_1 is theirs
const GIFTED = { ownerUserId: 8, ownerId: 8, ownerName: 'Gift Recipient' };

function rawQueryCalls(marker: string) {
  return h.prisma.$queryRaw.mock.calls.filter((c) =>
    Array.from(c[0] as TemplateStringsArray)
      .join(' ')
      .includes(marker)
  );
}

function execCalls() {
  return h.prisma.$executeRaw.mock.calls.map((c) => ({
    sql: Array.from(c[0] as TemplateStringsArray).join(' ? '),
    values: c.slice(1),
  }));
}

function allMockFns(): ReturnType<typeof vi.fn>[] {
  const fns: any[] = [];
  for (const model of Object.values(h.prisma) as any[]) {
    if (typeof model === 'function') fns.push(model);
    else fns.push(...Object.values(model));
  }
  fns.push(
    h.queueGenerate,
    h.queueDigitalRedesign,
    h.sendToPrinter,
    h.finalizeOrder,
    h.ensureLineQrCodes,
    h.getProviderByString,
    h.provider.getPlaylist,
    h.provider.getTracks,
    h.getStorefrontForLocale,
    h.clearPlaylistCache,
    h.storeTracks,
    h.cacheDel
  );
  return fns;
}

beforeEach(() => {
  for (const fn of allMockFns()) fn.mockReset();
  h.prisma.$queryRaw.mockResolvedValue([]);
  h.prisma.$executeRaw.mockResolvedValue(0);
  h.queueGenerate.mockResolvedValue(undefined);
  h.queueDigitalRedesign.mockResolvedValue(undefined);
  h.sendToPrinter.mockResolvedValue(undefined);
  h.finalizeOrder.mockResolvedValue(undefined);
  h.ensureLineQrCodes.mockResolvedValue(false);
  h.clearPlaylistCache.mockResolvedValue(undefined);
  h.storeTracks.mockResolvedValue(undefined);
  h.cacheDel.mockResolvedValue(undefined);
  h.getProviderByString.mockReturnValue(h.provider);
  h.getStorefrontForLocale.mockReturnValue('storefront-nl');
  outbound.reset();
});

// ---------------------------------------------------------------------------

describe('getUserSuggestions', () => {
  it('returns track rows plus full metadata when payment, playlist and php exist', async () => {
    h.prisma.payment.findFirst.mockResolvedValue({
      id: 10,
      canBeSentToPrinterAt: new Date('2026-06-13T10:00:00Z'),
      countrycode: 'NL',
      currency: 'EUR',
      locale: 'nl',
    });
    h.prisma.playlist.findFirst.mockResolvedValue({
      id: 20,
      serviceType: 'apple_music',
    });
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue({
      id: 30,
      type: 'physical',
      amount: 2,
      numberOfTracks: 100,
      boxEnabled: true,
      boxQuantity: 3,
    });
    // COUNT(*) comes back from MySQL as a BigInt
    const rows = [{ id: 1, name: 'Song', hasSuggestion: 'false', cardIndex: BigInt(4) }];
    routeRaw([OWNED, [SQL.userTracks, rows]]);

    const res = await suggestion.getUserSuggestions('pay_1', 'hash_1', 'pl_1');

    // cardIndex: the card's position in the deck, for its alternating design
    expect(res.suggestions).toEqual([
      { id: 1, name: 'Song', hasSuggestion: 'false', cardIndex: 4 },
    ]);
    expect(res.metadata).toEqual({
      payment: {
        canBeSentToPrinterAt: new Date('2026-06-13T10:00:00Z'),
        countrycode: 'NL',
        currency: 'EUR',
        locale: 'nl',
      },
      serviceType: 'apple_music',
      paymentHasPlaylistId: 30,
      playlistType: 'physical',
      numberOfTracks: 100,
      amount: 2,
      boxEnabled: true,
      boxQuantity: 3,
    });
    // php is the line the hash holds, and the track rows are that line's
    expect(h.prisma.paymentHasPlaylist.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 30 } })
    );
    expect(rawQueryCalls(SQL.userTracks)[0].slice(2)).toEqual(['pay_1', 30]);
  });

  it('falls back to defaults and skips the php lookup when the hash holds no line', async () => {
    // e.g. the giver's old link after the gift was redeemed
    h.prisma.payment.findFirst.mockResolvedValue(null);
    h.prisma.playlist.findFirst.mockResolvedValue({
      id: 20,
      serviceType: null,
    });
    routeRaw([NO_LINE, [SQL.userTracks, []]]);

    const res = await suggestion.getUserSuggestions('pay_x', 'hash', 'pl');

    expect(h.prisma.paymentHasPlaylist.findUnique).not.toHaveBeenCalled();
    // the track query is pinned to a line id no row has
    expect(rawQueryCalls(SQL.userTracks)[0].slice(2)).toEqual(['pay_x', 0]);
    expect(res.metadata).toEqual({
      payment: {
        canBeSentToPrinterAt: null,
        countrycode: null,
        currency: null,
        locale: null,
      },
      serviceType: 'spotify',
      paymentHasPlaylistId: null,
      playlistType: null,
      numberOfTracks: null,
      amount: 1,
      boxEnabled: false,
      boxQuantity: 0,
    });
  });
});

// ---------------------------------------------------------------------------

describe('saveUserSuggestion', () => {
  const args = ['pay_1', 'hash_1', 'pl_1', 42] as const;
  const body = { name: 'New', artist: 'Artist', year: 1999 };

  it('rejects a hash that holds no line, without touching tracks', async () => {
    routeRaw([NO_LINE]);
    const ok = await suggestion.saveUserSuggestion(...args, body);
    expect(ok).toBe(false);
    expect(rawQueryCalls(SQL.trackCheck)).toHaveLength(0);
    expect(h.prisma.userSuggestion.upsert).not.toHaveBeenCalled();
  });

  it('rejects when the track does not belong to the line', async () => {
    routeRaw([OWNED, [SQL.trackCheck, []]]);
    const ok = await suggestion.saveUserSuggestion(...args, body);
    expect(ok).toBe(false);
    // the check is scoped to the line id, not to payment + playlist
    expect(rawQueryCalls(SQL.trackCheck)[0].slice(1)).toEqual([30, 42]);
    expect(h.prisma.userSuggestion.upsert).not.toHaveBeenCalled();
  });

  it('saves as the holder of a given set, not as the buyer', async () => {
    routeRaw([ownedLine(GIFTED), [SQL.trackCheck, [{ playlistDBId: 9 }]]]);
    h.prisma.userSuggestion.upsert.mockResolvedValue({ id: 333 });

    expect(await suggestion.saveUserSuggestion(...args, body)).toBe(true);

    expect(h.prisma.userSuggestion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_trackId: { userId: 8, trackId: 42 } },
        create: expect.objectContaining({ userId: 8 }),
      })
    );
  });

  it('upserts on (user, track): updates the fields, creates bound to the playlist from the access check', async () => {
    routeRaw([OWNED, [SQL.trackCheck, [{ playlistDBId: 9 }]]]);
    h.prisma.userSuggestion.upsert.mockResolvedValue({ id: 333 });

    const ok = await suggestion.saveUserSuggestion(...args, {
      ...body,
      extraNameAttribute: 'Remastered',
      extraArtistAttribute: 'feat. X',
    });

    expect(ok).toBe(true);
    const fields = {
      name: 'New',
      artist: 'Artist',
      year: 1999,
      extraNameAttribute: 'Remastered',
      extraArtistAttribute: 'feat. X',
    };
    expect(h.prisma.userSuggestion.upsert).toHaveBeenCalledWith({
      where: { userId_trackId: { userId: 5, trackId: 42 } },
      update: fields,
      create: { ...fields, trackId: 42, userId: 5, playlistId: 9 },
    });
  });

  it('retries once when a concurrent save created the row first', async () => {
    routeRaw([OWNED, [SQL.trackCheck, [{ playlistDBId: 9 }]]]);
    h.prisma.userSuggestion.upsert
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({ id: 333 });

    const ok = await suggestion.saveUserSuggestion(...args, body);

    expect(ok).toBe(true);
    expect(h.prisma.userSuggestion.upsert).toHaveBeenCalledTimes(2);
  });

  it('does not retry other database errors', async () => {
    routeRaw([OWNED, [SQL.trackCheck, [{ playlistDBId: 9 }]]]);
    h.prisma.userSuggestion.upsert.mockRejectedValue(
      Object.assign(new Error('fk'), { code: 'P2003' })
    );

    const ok = await suggestion.saveUserSuggestion(...args, body);

    expect(ok).toBe(false);
    expect(h.prisma.userSuggestion.upsert).toHaveBeenCalledTimes(1);
  });

  it('swallows database errors and returns false', async () => {
    routeRaw([
      OWNED,
      [
        SQL.trackCheck,
        () => {
          throw new Error('db down');
        },
      ],
    ]);
    const ok = await suggestion.saveUserSuggestion(...args, body);
    expect(ok).toBe(false);
    expect(h.prisma.userSuggestion.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('submitUserSuggestions', () => {
  const args = ['pay_1', 'hash_1', 'pl_1', '1.2.3.4'] as const;

  function arrange(opts: {
    count: number;
    php: any;
    payment?: any;
    line?: Record<string, unknown>;
  }) {
    routeRaw([ownedLine(opts.line)]);
    h.prisma.payment.findFirst.mockResolvedValue(
      opts.payment ?? { id: 10, userId: 5, fullname: 'Rick G' }
    );
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(opts.php);
    h.prisma.userSuggestion.count.mockResolvedValue(opts.count);
  }

  it('rejects a hash that holds no line', async () => {
    routeRaw([NO_LINE]);
    expect(await suggestion.submitUserSuggestions(...args)).toBe(false);
    expect(h.prisma.payment.findFirst).not.toHaveBeenCalled();
  });

  it('flags suggestionsPending and notifies pushover when corrections exist', async () => {
    arrange({ count: 3, php: { id: 30, type: 'physical' } });

    const ok = await suggestion.submitUserSuggestions(...args);

    expect(ok).toBe(true);
    // the line and its holder's suggestions, by id
    expect(h.prisma.paymentHasPlaylist.findUnique).toHaveBeenCalledWith({
      where: { id: 30 },
    });
    expect(h.prisma.userSuggestion.count).toHaveBeenCalledWith({
      where: { playlistId: 20, userId: 5 },
    });
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: { suggestionsPending: true, userConfirmedPrinting: true },
    });
    const pushes = outbound.calls('PushoverClient', 'sendMessage');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].args[0]).toEqual({
      title: 'QRSong! Correcties doorgegeven',
      message: '3 correcties doorgegeven door: Rick G',
      sound: 'incoming',
    });
    expect(pushes[0].args[1]).toBe('1.2.3.4');
    // corrections go to the admin review queue, not straight to regeneration
    expect(h.queueGenerate).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
  });

  it('physical order without corrections: locks printer flag and queues regeneration with checkPrinter callback', async () => {
    arrange({ count: 0, php: { id: 30, type: 'physical' } });

    const ok = await suggestion.submitUserSuggestions(...args);

    expect(ok).toBe(true);
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: { eligableForPrinter: false, userConfirmedPrinting: true },
    });
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1' },
      data: {
        userAgreedToPrinting: true,
        userAgreedToPrintingAt: expect.any(Date),
      },
    });
    expect(h.queueGenerate).toHaveBeenCalledWith(
      'pay_1',
      '',
      '',
      true,
      true,
      false,
      '',
      {
        type: 'checkPrinter',
        paymentId: 'pay_1',
        clientIp: '1.2.3.4',
        paymentHasPlaylistId: 30,
      }
    );
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('digital order without corrections: marks pending and queues regeneration with sendDigitalEmail callback', async () => {
    arrange({
      count: 0,
      php: { id: 31, type: 'digital' },
      line: { id: 31, type: 'digital' },
    });

    const ok = await suggestion.submitUserSuggestions(...args);

    expect(ok).toBe(true);
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1' },
      data: {
        userAgreedToPrinting: true,
        userAgreedToPrintingAt: expect.any(Date),
      },
    });
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: { suggestionsPending: true, userConfirmedPrinting: true },
    });
    expect(h.queueGenerate).toHaveBeenCalledWith(
      'pay_1',
      '',
      '',
      true,
      true,
      false,
      '',
      {
        type: 'sendDigitalEmail',
        paymentId: 'pay_1',
        playlistId: 'pl_1',
        userHash: 'hash_1',
      }
    );
  });

  it('returns false when no paymentHasPlaylist row exists', async () => {
    arrange({ count: 0, php: null });
    expect(await suggestion.submitUserSuggestions(...args)).toBe(false);
    expect(h.queueGenerate).not.toHaveBeenCalled();
  });

  it('returns false when a lookup throws', async () => {
    routeRaw([OWNED]);
    h.prisma.payment.findFirst.mockRejectedValue(new Error('boom'));
    expect(await suggestion.submitUserSuggestions(...args)).toBe(false);
  });

  it('refuses a given physical set: it has been printed', async () => {
    arrange({
      count: 0,
      php: { id: 30, type: 'physical' },
      line: { ...GIFTED, type: 'physical' },
    });

    expect(await suggestion.submitUserSuggestions(...args)).toBe(false);

    expect(h.prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.queueGenerate).not.toHaveBeenCalled();
    expect(h.queueDigitalRedesign).not.toHaveBeenCalled();
  });

  it('given digital set without corrections: rebuilds that line alone and leaves the buyer\'s consent alone', async () => {
    arrange({
      count: 0,
      php: { id: 31, type: 'digital' },
      line: { ...GIFTED, id: 31, type: 'digital' },
    });

    expect(await suggestion.submitUserSuggestions(...args)).toBe(true);

    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: { suggestionsPending: true, userConfirmedPrinting: true },
    });
    expect(h.queueDigitalRedesign).toHaveBeenCalledWith('pay_1', 31);
    // the order-wide rebuild would redo the buyer's lines and finalize the order
    expect(h.queueGenerate).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
  });

  it('given digital set with corrections: pushover names the holder, not the buyer', async () => {
    arrange({
      count: 2,
      php: { id: 31, type: 'digital' },
      line: { ...GIFTED, id: 31, type: 'digital' },
    });

    expect(await suggestion.submitUserSuggestions(...args)).toBe(true);

    expect(h.prisma.userSuggestion.count).toHaveBeenCalledWith({
      where: { playlistId: 20, userId: 8 },
    });
    const pushes = outbound.calls('PushoverClient', 'sendMessage');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].args[0].message).toBe(
      '2 correcties doorgegeven door: Gift Recipient'
    );
  });
});

// ---------------------------------------------------------------------------

describe('applyDesignChanges', () => {
  const args = ['pay_1', 'hash_1', 'pl_1', '9.9.9.9'] as const;

  function arrange(php: any, line?: Record<string, unknown>) {
    routeRaw([ownedLine(line)]);
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(php);
  }

  it('rejects a hash that holds no line', async () => {
    routeRaw([NO_LINE]);
    expect(await suggestion.applyDesignChanges(...args)).toBe(false);
    expect(h.prisma.paymentHasPlaylist.findUnique).not.toHaveBeenCalled();
  });

  it('returns false when the php row is missing', async () => {
    arrange(null);
    expect(await suggestion.applyDesignChanges(...args)).toBe(false);
    expect(h.queueGenerate).not.toHaveBeenCalled();
  });

  it('physical: resets printer eligibility, records consent and queues checkPrinter regeneration', async () => {
    arrange({ id: 30, type: 'physical' });

    const ok = await suggestion.applyDesignChanges(...args);

    expect(ok).toBe(true);
    expect(h.prisma.paymentHasPlaylist.findUnique).toHaveBeenCalledWith({
      where: { id: 30 },
    });
    expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: { eligableForPrinter: false, userConfirmedPrinting: true },
    });
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1' },
      data: {
        userAgreedToPrinting: true,
        userAgreedToPrintingAt: expect.any(Date),
      },
    });
    expect(h.queueGenerate).toHaveBeenCalledWith(
      'pay_1',
      '',
      '',
      true,
      true,
      false,
      '',
      {
        type: 'checkPrinter',
        paymentId: 'pay_1',
        clientIp: '9.9.9.9',
        paymentHasPlaylistId: 30,
      }
    );
  });

  it('digital: queues sendDigitalEmail regeneration without any pending state', async () => {
    arrange({ id: 31, type: 'digital' }, { id: 31, type: 'digital' });

    const ok = await suggestion.applyDesignChanges(...args);

    expect(ok).toBe(true);
    expect(h.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.queueGenerate).toHaveBeenCalledWith(
      'pay_1',
      '',
      '',
      true,
      true,
      false,
      '',
      {
        type: 'sendDigitalEmail',
        paymentId: 'pay_1',
        playlistId: 'pl_1',
        userHash: 'hash_1',
      }
    );
  });

  it('refuses a given physical set: it has been printed', async () => {
    arrange({ id: 30, type: 'physical' }, { ...GIFTED, type: 'physical' });

    expect(await suggestion.applyDesignChanges(...args)).toBe(false);

    expect(h.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.queueGenerate).not.toHaveBeenCalled();
    expect(h.queueDigitalRedesign).not.toHaveBeenCalled();
  });

  it('given digital set: queues the line\'s own rebuild instead of the order-wide one', async () => {
    arrange(
      { id: 31, type: 'digital' },
      { ...GIFTED, id: 31, type: 'digital' }
    );

    expect(await suggestion.applyDesignChanges(...args)).toBe(true);

    expect(h.queueDigitalRedesign).toHaveBeenCalledWith('pay_1', 31);
    expect(h.queueGenerate).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('deleteUserSuggestion', () => {
  const args = ['pay_1', 'hash_1', 'pl_1', 42] as const;

  it('rejects a hash that holds no line', async () => {
    routeRaw([NO_LINE]);
    expect(await suggestion.deleteUserSuggestion(...args)).toBe(false);
    expect(rawQueryCalls(SQL.access)).toHaveLength(0);
    expect(h.prisma.userSuggestion.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects when the track is not part of the line', async () => {
    routeRaw([OWNED, [SQL.access, []]]);
    expect(await suggestion.deleteUserSuggestion(...args)).toBe(false);
    expect(rawQueryCalls(SQL.access)[0].slice(1)).toEqual([30, 42]);
    expect(h.prisma.userSuggestion.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes the holder's suggestion on a given set, not the buyer's", async () => {
    routeRaw([ownedLine(GIFTED), [SQL.access, [{ 1: 1 }]]]);
    expect(await suggestion.deleteUserSuggestion(...args)).toBe(true);
    expect(h.prisma.userSuggestion.deleteMany).toHaveBeenCalledWith({
      where: { trackId: 42, userId: 8 },
    });
  });

  it('deletes all suggestions for this user and track', async () => {
    routeRaw([OWNED, [SQL.access, [{ 1: 1 }]]]);
    expect(await suggestion.deleteUserSuggestion(...args)).toBe(true);
    expect(h.prisma.userSuggestion.deleteMany).toHaveBeenCalledWith({
      where: { trackId: 42, userId: 5 },
    });
  });
});

// ---------------------------------------------------------------------------

describe('getCorrections', () => {
  it('returns the pending-corrections rows from the aggregate query', async () => {
    const rows = [
      { userId: 1, email: 'a@b.c', suggestionCount: 2, paymentId: 'p1' },
    ];
    routeRaw([[SQL.corrections, rows]]);
    expect(await suggestion.getCorrections()).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------

describe('processCorrections', () => {
  // The line's id, type and payment come from findLineByHash itself
  const LINE_PHYSICAL = ownedLine({ id: 30, type: 'physical' });
  const LINE_DIGITAL = ownedLine({ id: 31, type: 'digital' });

  const baseRow = {
    trackId: 42,
    originalName: 'Old Name',
    originalArtist: 'Old Artist',
    originalYear: 1990,
    suggestedName: 'Old Name',
    suggestedArtist: 'Old Artist',
    suggestedYear: 1990,
    suggestedExtraNameAttribute: null,
    suggestedExtraArtistAttribute: null,
    originalExtraNameAttribute: null,
    originalExtraArtistAttribute: null,
  };

  function call(
    overrides: Partial<{
      artistOnlyForMe: boolean;
      titleOnlyForMe: boolean;
      yearOnlyForMe: boolean;
      andSend: boolean;
    }> = {}
  ) {
    return suggestion.processCorrections(
      'pay_1',
      'hash_1',
      'pl_1',
      overrides.artistOnlyForMe ?? false,
      overrides.titleOnlyForMe ?? false,
      overrides.yearOnlyForMe ?? false,
      overrides.andSend ?? false,
      '1.2.3.4'
    );
  }

  it('rejects a hash that holds no line, before reading or writing anything', async () => {
    routeRaw([NO_LINE]);
    expect(await call()).toBe(false);
    expect(rawQueryCalls(SQL.suggestions)).toHaveLength(0);
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
  });

  it('takes the line id, type and payment from the owned line, with no lookup of its own', async () => {
    routeRaw([
      ownedLine({ id: 31, type: 'digital', paymentDbId: 12 }),
      [SQL.suggestions, []],
    ]);

    expect(await call()).toBe(true);

    // findLineByHash and the suggestion rows, nothing else
    expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    // the holder's suggestions on this line
    expect(rawQueryCalls(SQL.suggestions)[0].slice(1)).toEqual([5, 31]);
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { userAgreedToPrinting: false },
    });
  });

  it('applies global name/year corrections to the track and cleans up (physical, no send)', async () => {
    const printerSpy = vi
      .spyOn(Suggestion.prototype as any, 'checkIfReadyForPrinter')
      .mockResolvedValue(undefined);
    try {
      routeRaw([
        LINE_PHYSICAL,
        [
          SQL.suggestions,
          [
            {
              ...baseRow,
              suggestedName: 'New Name',
              suggestedYear: 1991,
            },
          ],
        ],
      ]);

      expect(await call()).toBe(true);

      // artist unchanged -> not in payload; changed fields + manuallyCorrected
      expect(h.prisma.track.update).toHaveBeenCalledTimes(1);
      expect(h.prisma.track.update).toHaveBeenCalledWith({
        where: { id: 42 },
        data: { name: 'New Name', year: 1991, manuallyCorrected: true },
      });
      expect(h.prisma.trackExtraInfo.upsert).not.toHaveBeenCalled();

      const execs = execCalls();
      const pendingClear = execs.find((e) =>
        e.sql.includes('suggestionsPending = false')
      );
      expect(pendingClear).toBeTruthy();
      // values: artistOnlyForMe, titleOnlyForMe, yearOnlyForMe, phpId
      expect(pendingClear!.values).toEqual([false, false, false, 30]);

      // physical: judged status is NOT reset
      expect(
        execs.some((e) => e.sql.includes('userConfirmedPrinting = false'))
      ).toBe(false);
      expect(h.prisma.payment.update).not.toHaveBeenCalled();

      const deletion = execs.find((e) =>
        e.sql.includes('DELETE FROM usersuggestions')
      );
      expect(deletion).toBeTruthy();
      // the line holder's suggestions, by user id
      expect(deletion!.values).toEqual([5, 'pl_1']);

      expect(h.clearPlaylistCache).toHaveBeenCalledWith('pl_1');

      // andSend=false + physical -> direct printer-readiness check, no regen
      expect(printerSpy).toHaveBeenCalledWith('pay_1', '1.2.3.4');
      expect(h.queueGenerate).not.toHaveBeenCalled();
      expect(h.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
    } finally {
      printerSpy.mockRestore();
    }
  });

  it('routes onlyForMe corrections to a trackExtraInfo upsert, still marking the global track manuallyCorrected', async () => {
    routeRaw([
      LINE_DIGITAL,
      [
        SQL.suggestions,
        [
          {
            ...baseRow,
            suggestedName: 'Local Name',
            suggestedArtist: 'Local Artist',
          },
        ],
      ],
    ]);
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 20 });

    expect(
      await call({ titleOnlyForMe: true, artistOnlyForMe: true })
    ).toBe(true);

    // Global track row only gets the manuallyCorrected marker
    expect(h.prisma.track.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { manuallyCorrected: true },
    });
    expect(h.prisma.trackExtraInfo.upsert).toHaveBeenCalledWith({
      where: { playlistId_trackId: { playlistId: 20, trackId: 42 } },
      update: { name: 'Local Name', artist: 'Local Artist' },
      create: {
        track: { connect: { id: 42 } },
        playlist: { connect: { id: 20 } },
        name: 'Local Name',
        artist: 'Local Artist',
      },
    });

    // onlyForMe flags are persisted on the php row
    const pendingClear = execCalls().find((e) =>
      e.sql.includes('suggestionsPending = false')
    );
    expect(pendingClear!.values).toEqual([true, true, false, 31]);
  });

  it('creates a trackExtraInfo row when extra attributes are added and none exists', async () => {
    routeRaw([
      LINE_DIGITAL,
      [
        SQL.suggestions,
        [
          {
            ...baseRow,
            suggestedExtraNameAttribute: 'Remaster 2020',
            suggestedExtraArtistAttribute: 'feat. Q',
          },
        ],
      ],
    ]);
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 20 });

    expect(await call()).toBe(true);

    expect(h.prisma.trackExtraInfo.upsert).toHaveBeenCalledWith({
      where: { playlistId_trackId: { playlistId: 20, trackId: 42 } },
      update: {
        extraNameAttribute: 'Remaster 2020',
        extraArtistAttribute: 'feat. Q',
      },
      create: {
        track: { connect: { id: 42 } },
        playlist: { connect: { id: 20 } },
        extraNameAttribute: 'Remaster 2020',
        extraArtistAttribute: 'feat. Q',
      },
    });
  });

  it('writes a track listed twice through one upsert key, one write at a time', async () => {
    // The 501-card order: the track came back twice, both lookups ran before
    // either create, and trackextrainfo got two rows for it.
    const row = { ...baseRow, suggestedYear: 2021 };
    routeRaw([LINE_DIGITAL, [SQL.suggestions, [row, row]]]);
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 20 });
    let inFlight = 0;
    let maxInFlight = 0;
    h.prisma.trackExtraInfo.upsert.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return {};
    });

    expect(await call({ yearOnlyForMe: true })).toBe(true);

    const keys = h.prisma.trackExtraInfo.upsert.mock.calls.map((c) => c[0].where);
    expect(keys).toEqual([
      { playlistId_trackId: { playlistId: 20, trackId: 42 } },
      { playlistId_trackId: { playlistId: 20, trackId: 42 } },
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('retries the trackExtraInfo upsert when a concurrent run created the row first', async () => {
    routeRaw([
      LINE_DIGITAL,
      [SQL.suggestions, [{ ...baseRow, suggestedYear: 2021 }]],
    ]);
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 20 });
    h.prisma.trackExtraInfo.upsert
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({});

    expect(await call({ yearOnlyForMe: true })).toBe(true);
    expect(h.prisma.trackExtraInfo.upsert).toHaveBeenCalledTimes(2);
  });

  it('clears an extra attribute to null when the suggestion empties it', async () => {
    routeRaw([
      LINE_DIGITAL,
      [
        SQL.suggestions,
        [
          {
            ...baseRow,
            suggestedExtraNameAttribute: '',
            originalExtraNameAttribute: 'Old Extra',
          },
        ],
      ],
    ]);
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 20 });

    expect(await call()).toBe(true);

    expect(h.prisma.trackExtraInfo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playlistId_trackId: { playlistId: 20, trackId: 42 } },
        update: { extraNameAttribute: null },
      })
    );
  });

  it('digital with no text changes: clears flags, resets judged status and re-enables suggestions', async () => {
    routeRaw([
      LINE_DIGITAL,
      [SQL.suggestions, [{ ...baseRow }]],
    ]);

    expect(await call()).toBe(true);

    expect(h.prisma.track.update).not.toHaveBeenCalled();

    const execs = execCalls();
    const reset = execs.find((e) =>
      e.sql.includes('userConfirmedPrinting = false')
    );
    expect(reset).toBeTruthy();
    expect(reset!.values).toEqual([31]);
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { userAgreedToPrinting: false },
    });
    // digital + andSend=false -> nothing queued, no printer check needed
    expect(h.queueGenerate).not.toHaveBeenCalled();
  });

  it('andSend on a physical order resets eligableForPrinter and queues a checkPrinter regeneration', async () => {
    const printerSpy = vi
      .spyOn(Suggestion.prototype as any, 'checkIfReadyForPrinter')
      .mockResolvedValue(undefined);
    try {
      routeRaw([LINE_PHYSICAL, [SQL.suggestions, []]]);

      expect(await call({ andSend: true })).toBe(true);

      expect(h.prisma.paymentHasPlaylist.update).toHaveBeenCalledWith({
        where: { id: 30 },
        data: { eligableForPrinter: false },
      });
      // The printer hold placed by finalCheck must be cleared so the corrected
      // order can re-enter the pipeline.
      expect(h.prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: {
          printerHold: false,
          printerHoldReason: null,
          printerHoldDetails: Prisma.DbNull,
        },
      });
      expect(h.queueGenerate).toHaveBeenCalledWith(
        'pay_1',
        '',
        '',
        true,
        true,
        false,
        '',
        {
          type: 'checkPrinter',
          paymentId: 'pay_1',
          clientIp: '1.2.3.4',
          paymentHasPlaylistId: 30,
        }
      );
      // the printer check is deferred to the generation callback
      expect(printerSpy).not.toHaveBeenCalled();
    } finally {
      printerSpy.mockRestore();
    }
  });

  it('andSend on a digital order queues a sendDigitalEmail regeneration', async () => {
    routeRaw([LINE_DIGITAL, [SQL.suggestions, []]]);

    expect(await call({ andSend: true })).toBe(true);

    expect(h.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
    expect(h.queueGenerate).toHaveBeenCalledWith(
      'pay_1',
      '',
      '',
      true,
      true,
      false,
      '',
      {
        type: 'sendDigitalEmail',
        paymentId: 'pay_1',
        playlistId: 'pl_1',
        userHash: 'hash_1',
      }
    );
  });

  it('returns false when the corrections transaction throws', async () => {
    routeRaw([
      LINE_PHYSICAL,
      [
        SQL.suggestions,
        [{ ...baseRow, suggestedName: 'X' }],
      ],
    ]);
    h.prisma.track.update.mockRejectedValue(new Error('deadlock'));
    expect(await call()).toBe(false);
  });

  it("given digital set, andSend: rebuilds that line alone and leaves the buyer's consent alone", async () => {
    routeRaw([
      ownedLine({ ...GIFTED, id: 31, type: 'digital' }),
      [SQL.suggestions, []],
    ]);

    expect(await call({ andSend: true })).toBe(true);

    // the line's own judged status is still reset for new suggestions
    const reset = execCalls().find((e) =>
      e.sql.includes('userConfirmedPrinting = false')
    );
    expect(reset!.values).toEqual([31]);
    // the holder's suggestions are the ones cleared
    const deletion = execCalls().find((e) =>
      e.sql.includes('DELETE FROM usersuggestions')
    );
    expect(deletion!.values).toEqual([8, 'pl_1']);
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.queueDigitalRedesign).toHaveBeenCalledWith('pay_1', 31);
    expect(h.queueGenerate).not.toHaveBeenCalled();
  });

  it('given physical set, andSend: nothing to rebuild or send to the printer', async () => {
    const printerSpy = vi
      .spyOn(Suggestion.prototype as any, 'checkIfReadyForPrinter')
      .mockResolvedValue(undefined);
    try {
      routeRaw([
        ownedLine({ ...GIFTED, type: 'physical' }),
        [SQL.suggestions, []],
      ]);

      expect(await call({ andSend: true })).toBe(true);

      // the corrections themselves are still applied and cleared
      expect(
        execCalls().some((e) => e.sql.includes('suggestionsPending = false'))
      ).toBe(true);
      expect(h.clearPlaylistCache).toHaveBeenCalledWith('pl_1');
      // no printer hold lifted, no eligibility reset, nothing queued
      expect(h.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
      expect(h.prisma.payment.update).not.toHaveBeenCalled();
      expect(h.queueGenerate).not.toHaveBeenCalled();
      expect(h.queueDigitalRedesign).not.toHaveBeenCalled();
      expect(printerSpy).not.toHaveBeenCalled();
    } finally {
      printerSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------

describe('extendPrinterDeadline', () => {
  it('refuses anyone but the buyer, the holder of a given set included', async () => {
    // hash_1 holds a line of the order, but the deadline is the whole order's
    routeRaw([ownedLine(GIFTED)]);
    h.prisma.payment.findFirst.mockResolvedValue(null);

    expect(
      await suggestion.extendPrinterDeadline('pay_1', 'hash_1', 'pl_1')
    ).toBe(false);

    // verifyBuyer: a paid payment whose own user has this hash
    expect(h.prisma.payment.findFirst).toHaveBeenCalledTimes(1);
    expect(h.prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1', status: 'paid', user: { hash: 'hash_1' } },
      select: { id: true },
    });
    expect(rawQueryCalls(SQL.line)).toHaveLength(0);
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
  });

  it('returns false when the payment row is gone after the buyer check', async () => {
    h.prisma.payment.findFirst
      .mockResolvedValueOnce({ id: 4 })
      .mockResolvedValueOnce(null);
    expect(
      await suggestion.extendPrinterDeadline('pay_1', 'hash_1', 'pl_1')
    ).toBe(false);
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
  });

  it('extends an existing deadline by exactly 24 hours', async () => {
    h.prisma.payment.findFirst.mockResolvedValue({
      id: 4,
      canBeSentToPrinterAt: new Date('2026-06-10T08:00:00Z'),
    });

    expect(
      await suggestion.extendPrinterDeadline('pay_1', 'hash_1', 'pl_1')
    ).toBe(true);
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { canBeSentToPrinterAt: new Date('2026-06-11T08:00:00Z') },
    });
  });

  it('starts from now + 24h when no deadline was set', async () => {
    h.prisma.payment.findFirst.mockResolvedValue({
      id: 4,
      canBeSentToPrinterAt: null,
    });
    const before = Date.now();

    expect(
      await suggestion.extendPrinterDeadline('pay_1', 'hash_1', 'pl_1')
    ).toBe(true);

    const newDate: Date =
      h.prisma.payment.update.mock.calls[0][0].data.canBeSentToPrinterAt;
    const delta = newDate.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000);
    expect(delta).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000);
  });
});

// ---------------------------------------------------------------------------

describe('checkIfReadyForPrinter', () => {
  const check = (paymentId = 'pay_1', ip = '1.2.3.4') =>
    (suggestion as any).checkIfReadyForPrinter(paymentId, ip);

  it('bails out silently for unknown payments', async () => {
    h.prisma.payment.findUnique.mockResolvedValue(null);
    await check();
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.sendToPrinter).not.toHaveBeenCalled();
  });

  it('does nothing while some physical playlists are still ineligible', async () => {
    h.prisma.payment.findUnique.mockResolvedValue({ id: 10 });
    routeRaw([[SQL.printerReady, [{ count: 1, total: 2 }]]]);
    await check();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.sendToPrinter).not.toHaveBeenCalled();
  });

  it('does nothing for payments without physical playlists (0/0)', async () => {
    h.prisma.payment.findUnique.mockResolvedValue({ id: 10 });
    routeRaw([[SQL.printerReady, [{ count: 0, total: 0 }]]]);
    await check();
    expect(h.prisma.payment.update).not.toHaveBeenCalled();
    expect(h.sendToPrinter).not.toHaveBeenCalled();
  });

  it('marks the payment printable and hands off to the printer when all playlists are ready', async () => {
    h.prisma.payment.findUnique.mockResolvedValue({ id: 10 });
    routeRaw([[SQL.printerReady, [{ count: 2, total: 2 }]]]);

    await check('pay_9', '8.8.8.8');

    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'pay_9' },
      data: { canBeSentToPrinter: true },
    });
    expect(h.sendToPrinter).toHaveBeenCalledWith('pay_9', '8.8.8.8');
  });

  it('swallows printer hand-off errors (payment stays marked printable)', async () => {
    h.prisma.payment.findUnique.mockResolvedValue({ id: 10 });
    routeRaw([[SQL.printerReady, [{ count: 1, total: 1 }]]]);
    h.sendToPrinter.mockRejectedValue(new Error('printer API down'));

    await expect(check()).resolves.toBeUndefined();
    expect(h.prisma.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1' },
      data: { canBeSentToPrinter: true },
    });
  });
});

// ---------------------------------------------------------------------------

describe('reloadPlaylist', () => {
  const reload = () => suggestion.reloadPlaylist('pay_1', 'hash_1', 'pl_1');

  it('rejects a hash that holds no line', async () => {
    routeRaw([NO_LINE]);
    expect(await reload()).toEqual({ success: false, error: 'Unauthorized' });
    expect(h.prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(h.getProviderByString).not.toHaveBeenCalled();
  });

  it('fails when the payment row is missing', async () => {
    routeRaw([OWNED]);
    h.prisma.payment.findFirst.mockResolvedValue(null);
    expect(await reload()).toEqual({
      success: false,
      error: 'Payment not found',
    });
  });

  it('fails when the playlist row is missing', async () => {
    routeRaw([OWNED]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue(null);
    expect(await reload()).toEqual({
      success: false,
      error: 'Playlist not found',
    });
  });

  it('rate-limits reloads within one minute and reports retryAfter', async () => {
    routeRaw([OWNED]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 3 });
    const lastReload = new Date(Date.now() - 30_000);
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: lastReload,
    });

    const res = await reload();

    expect(res.success).toBe(false);
    expect(res.error).toBe('rate_limit_exceeded');
    expect(res.lastReloadAt).toBe(lastReload.toISOString());
    expect(res.retryAfter).toBeGreaterThan(0);
    expect(res.retryAfter).toBeLessThanOrEqual(31);
    expect(h.getProviderByString).not.toHaveBeenCalled();
  });

  it('proceeds past a stale rate-limit timestamp but fails when the payment/playlist pairing is gone', async () => {
    routeRaw([OWNED, [SQL.paidTracks, []]]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 3 });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: new Date(Date.now() - 5 * 60_000),
    });

    expect(await reload()).toEqual({
      success: false,
      error: 'Payment or playlist not found',
      paidTracks: undefined,
      currentTracks: undefined,
    });
  });

  const tracksOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `trk_${i + 1}` }));

  it('blocks the reload when the service now has more tracks than were paid for', async () => {
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [{ paidTracks: 10, playlistDbId: 3, serviceType: 'spotify', locale: 'en' }],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 3 });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: null,
    });
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: tracksOf(15) },
    });

    expect(await reload()).toEqual({
      success: false,
      error: 'track_limit_exceeded',
      paidTracks: 10,
      currentTracks: 15,
    });
    expect(h.provider.getTracks).toHaveBeenCalledWith('pl_1', {
      cache: false,
      allowDuplicates: false,
      storefront: undefined,
    });
    expect(h.storeTracks).not.toHaveBeenCalled();
  });

  it('counts the tracks after the duplicate filter, not the service total', async () => {
    // The order took 95 cards from a playlist of 100 with 5 duplicates. The
    // service still reports 100, but the filtered list fits the paid cards.
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [{ paidTracks: 95, playlistDbId: 3, serviceType: 'spotify', locale: 'de', allowDuplicates: 0 }],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 3, numberOfTracks: 95 });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: null,
    });
    h.provider.getPlaylist.mockResolvedValue({
      success: true,
      data: { trackCount: 100 },
    });
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: tracksOf(95), total: 95 },
    });

    const res = await reload();

    expect(res).toEqual({
      success: true,
      message: 'Playlist reloaded successfully',
      paidTracks: 95,
      currentTracks: 95,
    });
    expect(h.provider.getPlaylist).not.toHaveBeenCalled();
    expect(h.provider.getTracks).toHaveBeenCalledTimes(1);
    expect(h.storeTracks).toHaveBeenCalledTimes(1);
    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { numberOfTracks: 95 },
    });
  });

  it("fetches with the line's own allowDuplicates, so kept versions survive a reload", async () => {
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [{ paidTracks: 50, playlistDbId: 3, serviceType: 'spotify', locale: 'en', allowDuplicates: 1 }],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 3, numberOfTracks: 48 });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: null,
    });
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: tracksOf(48) },
    });

    const res = await reload();

    expect(res.success).toBe(true);
    expect(h.provider.getTracks).toHaveBeenCalledWith('pl_1', {
      cache: false,
      allowDuplicates: true,
      storefront: undefined,
    });
  });

  it('rejects unsupported music services', async () => {
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [{ paidTracks: 10, playlistDbId: 3, serviceType: 'deezer', locale: 'en' }],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 3 });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: null,
    });
    h.getProviderByString.mockReturnValue(undefined);

    const res = await reload();
    expect(res.success).toBe(false);
    expect(res.error).toBe('Unsupported music service: deezer');
  });

  it('uses the locale-derived storefront for Apple Music lookups', async () => {
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [
          {
            paidTracks: 10,
            playlistDbId: 3,
            serviceType: 'apple_music',
            locale: 'nl',
          },
        ],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 3 });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: null,
    });
    h.getStorefrontForLocale.mockReturnValue('nl');
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: tracksOf(99) },
    });

    const res = await reload();

    expect(h.getStorefrontForLocale).toHaveBeenCalledWith('nl');
    expect(h.provider.getTracks).toHaveBeenCalledWith('pl_1', {
      cache: false,
      allowDuplicates: false,
      storefront: 'nl',
    });
    // 99 > 10 stops the flow right after the storefront-aware fetch
    expect(res.error).toBe('track_limit_exceeded');
    expect(h.storeTracks).not.toHaveBeenCalled();
  });

  it('fails cleanly when fetching fresh tracks errors out', async () => {
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [{ paidTracks: 50, playlistDbId: 3, serviceType: 'spotify', locale: 'nl' }],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({
      id: 3,
      numberOfTracks: 40,
    });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: null,
    });
    h.provider.getTracks.mockResolvedValue({ success: false });

    const res = await reload();
    expect(res).toEqual({
      success: false,
      error: 'Failed to fetch tracks from spotify',
      paidTracks: undefined,
      currentTracks: undefined,
    });
    expect(h.storeTracks).not.toHaveBeenCalled();
    expect(h.prisma.playlist.update).not.toHaveBeenCalled();
    expect(h.ensureLineQrCodes).not.toHaveBeenCalled();
  });

  it('stores fresh tracks, syncs counts, busts caches and stamps lastReloadAt on success', async () => {
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [{ paidTracks: 50, playlistDbId: 3, serviceType: 'spotify', locale: 'nl' }],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({
      id: 3,
      numberOfTracks: 40,
    });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: null,
    });
    const tracks = [...tracksOf(41), { id: 'trk_last' }];
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks },
    });

    const res = await reload();

    expect(res).toEqual({
      success: true,
      message: 'Playlist reloaded successfully with updated track count',
      paidTracks: 50,
      currentTracks: 42,
    });
    // the paid track count is the line's own, found by its id
    expect(rawQueryCalls(SQL.paidTracks)[0].slice(1)).toEqual([30]);
    expect(h.provider.getTracks).toHaveBeenCalledWith('pl_1', {
      cache: false,
      allowDuplicates: false,
      storefront: undefined,
    });

    expect(h.storeTracks).toHaveBeenCalledTimes(1);
    const [dbId, plId, storedTracks, order, service, locale] =
      h.storeTracks.mock.calls[0];
    expect([dbId, plId, storedTracks, service, locale]).toEqual([
      3,
      'pl_1',
      tracks,
      'spotify',
      'nl',
    ]);
    expect(order).toBeInstanceOf(Map);
    expect(order.size).toBe(42);
    expect(order.get('trk_1')).toBe(1);
    expect(order.get('trk_last')).toBe(42);

    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { numberOfTracks: 42 },
    });
    expect(h.cacheDel).toHaveBeenCalledWith('tracks2_pl_1_40');
    expect(h.cacheDel).toHaveBeenCalledWith('tracks2_pl_1_42');
    expect(h.prisma.paymentHasPlaylist.updateMany).toHaveBeenCalledWith({
      where: { paymentId: 9, playlistId: 3 },
      data: { lastReloadAt: expect.any(Date) },
    });
    // Songs added since the order get their QR codes (order 100009458 had
    // none for its new songs on 2026-10-27)
    expect(h.ensureLineQrCodes).toHaveBeenCalledWith('pay_1', 30);
  });

  it('still reports the reload when making the QR codes fails: every render checks again', async () => {
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [{ paidTracks: 50, playlistDbId: 3, serviceType: 'spotify', locale: 'en' }],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({ id: 3, numberOfTracks: 40 });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({ lastReloadAt: null });
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: tracksOf(40) },
    });
    h.ensureLineQrCodes.mockRejectedValue(new Error('Lambda down'));

    const res = await reload();
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.success).toBe(true);
    expect(h.ensureLineQrCodes).toHaveBeenCalledWith('pay_1', 30);
  });

  it('reports the plain success message when the track count is unchanged', async () => {
    routeRaw([
      OWNED,
      [
        SQL.paidTracks,
        [{ paidTracks: 50, playlistDbId: 3, serviceType: 'spotify', locale: 'en' }],
      ],
    ]);
    h.prisma.payment.findFirst.mockResolvedValue({ id: 9 });
    h.prisma.playlist.findFirst.mockResolvedValue({
      id: 3,
      numberOfTracks: 40,
    });
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      lastReloadAt: null,
    });
    h.provider.getTracks.mockResolvedValue({
      success: true,
      data: { tracks: tracksOf(40) },
    });

    const res = await reload();
    expect(res.success).toBe(true);
    expect(res.message).toBe('Playlist reloaded successfully');
  });

  it('maps unexpected exceptions to a generic failure', async () => {
    h.prisma.$queryRaw.mockRejectedValue(new Error('connection lost'));
    expect(await reload()).toEqual({
      success: false,
      error: 'Failed to reload playlist',
    });
  });

  it('bypasses the rate limiter entirely in development mode', async () => {
    const prevEnv = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = 'development';
    try {
      routeRaw([OWNED, [SQL.paidTracks, []]]);

      const res = await suggestion.reloadPlaylist('pay_1', 'hash_1', 'pl_1');

      // straight past the rate-limit block into validation
      expect(h.prisma.paymentHasPlaylist.findFirst).not.toHaveBeenCalled();
      expect(res.success).toBe(false);
      expect(res.error).toBe('Payment or playlist not found');
    } finally {
      process.env.ENVIRONMENT = prevEnv;
    }
  });
});

// ---------------------------------------------------------------------------

describe('regenerateAndMail', () => {
  it('refuses anyone but the buyer, the holder of a given set included', async () => {
    // rebuilding every line of the order is the buyer's to ask for
    routeRaw([ownedLine(GIFTED)]);
    h.prisma.payment.findFirst.mockResolvedValue(null);

    expect(await suggestion.regenerateAndMail('pay_1', 'hash_1')).toEqual({
      success: false,
      error: 'Unauthorized',
    });

    expect(h.prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { paymentId: 'pay_1', status: 'paid', user: { hash: 'hash_1' } },
      select: { id: true },
    });
    expect(h.finalizeOrder).not.toHaveBeenCalled();
  });

  it('fires finalizeOrder with the mollie client and resolves immediately', async () => {
    h.prisma.payment.findFirst.mockResolvedValue({ id: 10 });
    const res = await suggestion.regenerateAndMail('pay_1', 'hash_1');
    expect(res).toEqual({ success: true });
    expect(h.finalizeOrder).toHaveBeenCalledTimes(1);
    const [paymentId, mollie, flag] = h.finalizeOrder.mock.calls[0];
    expect(paymentId).toBe('pay_1');
    expect(h.mollieInstances).toContain(mollie);
    expect(flag).toBe(true);
  });

  it('maps synchronous failures to a generic error result', async () => {
    h.prisma.payment.findFirst.mockRejectedValue(new Error('connection lost'));
    expect(await suggestion.regenerateAndMail('pay_1', 'hash_1')).toEqual({
      success: false,
      error: 'Failed to regenerate PDFs',
    });
  });

  it('still reports success when the fire-and-forget regeneration fails later', async () => {
    h.prisma.payment.findFirst.mockResolvedValue({ id: 10 });
    h.finalizeOrder.mockRejectedValue(new Error('pdf exploded'));
    const res = await suggestion.regenerateAndMail('pay_1', 'hash_1');
    expect(res).toEqual({ success: true });
    // let the rejected promise settle through the .catch handler
    await new Promise((r) => setImmediate(r));
  });
});
