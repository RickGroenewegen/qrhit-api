import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader, TestUser } from '../helpers/auth';

// The production entrypoints (src/app.ts / src/worker.ts) globally patch
interface Fixture {
  user: TestUser;
  payment: any;
  playlist: any;
  php: any;
  tracks: any[];
}

let seq = 0;
let cachedOrderTypeId: number | null = null;

async function getOrderTypeId(): Promise<number> {
  if (cachedOrderTypeId === null) {
    const ot = await prisma().orderType.create({
      data: {
        name: 'digital',
        description: 'Digital cards',
        amount: 13,
        amountWithMargin: 13,
        maxCards: 3000,
        digital: true,
      },
    });
    cachedOrderTypeId = ot.id;
  }
  return cachedOrderTypeId;
}

/** Seed a paid order + playlist + tracks (same shape the game routes join on). */
async function seedPaidPlaylist(opts: {
  user: TestUser;
  trackCount: number;
  gamesEnabled?: boolean;
}): Promise<Fixture> {
  seq++;
  const tag = `game-${Date.now()}-${seq}`;
  const payment = await prisma().payment.create({
    data: {
      userId: opts.user.user.id,
      paymentId: `tr_${tag}`,
      status: 'paid',
      totalPrice: 25,
      fullname: 'Game Tester',
      email: opts.user.user.email,
      productPriceWithoutTax: 20,
      shippingPriceWithoutTax: 0,
      productVATPrice: 5,
      shippingVATPrice: 0,
      totalVATPrice: 5,
    },
  });
  const playlist = await prisma().playlist.create({
    data: {
      playlistId: `pl_${tag}`,
      name: `Game Playlist ${tag}`,
      image: 'test.png',
      numberOfTracks: opts.trackCount,
    },
  });
  if (opts.trackCount > 0) {
    await prisma().track.createMany({
      data: Array.from({ length: opts.trackCount }, (_, i) => ({
        trackId: `trk_${tag}_${String(i).padStart(3, '0')}`,
        name: `Game Song ${i}`,
        artist: `Game Artist ${i}`,
        year: 1980 + (i % 40),
      })),
    });
  }
  const tracks = await prisma().track.findMany({
    where: { trackId: { startsWith: `trk_${tag}_` } },
    orderBy: { id: 'asc' },
  });
  await prisma().playlistHasTrack.createMany({
    data: tracks.map((t, i) => ({
      playlistId: playlist.id,
      trackId: t.id,
      order: i + 1,
    })),
  });
  const php = await prisma().paymentHasPlaylist.create({
    data: {
      paymentId: payment.id,
      playlistId: playlist.id,
      amount: 1,
      numberOfTracks: opts.trackCount,
      orderTypeId: await getOrderTypeId(),
      type: 'digital',
      price: 25,
      priceWithoutVAT: 20,
      priceVAT: 5,
      gamesEnabled: opts.gamesEnabled ?? true,
    },
  });
  return { user: opts.user, payment, playlist, php, tracks };
}

describe('game room routes', () => {
  let app: FastifyInstance;
  let host: TestUser;
  let stranger: TestUser;
  let fix: Fixture;
  let bingoFilename: string;

  async function createBingoRoom(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/game/room',
      headers: authHeader(host.token),
      payload: { type: 'bingo', hostFilename: bingoFilename },
    });
    expect(res.statusCode).toBe(200);
    return res.json().roomId;
  }

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    host = await createTestUser();
    stranger = await createTestUser();
    fix = await seedPaidPlaylist({ user: host, trackCount: 10 });

    // A bingo file links a room's hostFilename to the playlist's tracks so
    // the room can pre-load its trackId → bingoNumber mapping.
    bingoFilename = `game_suite_${Date.now()}.zip`;
    await prisma().bingoFile.create({
      data: {
        paymentHasPlaylistId: fix.php.id,
        filename: bingoFilename,
        contestants: 10,
        rounds: 2,
        trackCount: 10,
      },
    });
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('POST /api/game/room', () => {
    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/room',
        payload: { type: 'bingo' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an unknown room type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/room',
        headers: authHeader(host.token),
        payload: { type: 'chess' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Unknown room type: chess');
    });

    it('creates a bingo room with a pre-loaded track mapping', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/room',
        headers: authHeader(host.token),
        payload: { type: 'bingo', hostFilename: bingoFilename },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.roomId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(body.qrData).toBe(`QRSSM:RS:${body.roomId}`);

      const dbRoom = await prisma().gameRoom.findUnique({
        where: { uuid: body.roomId },
      });
      expect(dbRoom).toBeTruthy();
      expect(dbRoom!.type).toBe('bingo');
      expect(dbRoom!.userId).toBe(host.user.id);
      expect(dbRoom!.state).toBe('created');

      // Host can read the full room state, including the bingo plugin
      // defaults and the trackId → bingoNumber mapping.
      const state = await app.inject({
        method: 'GET',
        url: `/api/game/room/${body.roomId}`,
        headers: authHeader(host.token),
      });
      expect(state.statusCode).toBe(200);
      const { room } = state.json();
      expect(room.type).toBe('bingo');
      expect(room.state).toBe('created');
      expect(room.pluginData.gameMode).toBe('HORIZONTAL');
      expect(room.pluginData.playedTrackIds).toEqual([]);
      expect(Object.keys(room.pluginData.trackMapping)).toHaveLength(10);
      expect(room.pluginData.trackMapping[String(fix.tracks[0].id)]).toBe(1);
      expect(room.pluginData.trackMapping[String(fix.tracks[9].id)]).toBe(10);
    });
  });

  describe('GET /api/game/room/:roomId', () => {
    it('returns 404 for an unknown room', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/game/room/00000000-0000-0000-0000-000000000000',
        headers: authHeader(host.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses non-owners with 403', async () => {
      const roomId = await createBingoRoom();
      const res = await app.inject({
        method: 'GET',
        url: `/api/game/room/${roomId}`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/game/message', () => {
    it('rejects a missing message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Message is required');
    });

    it('rejects an unknown message type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: 'ZZ:whatever' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Unknown message type: ZZ');
    });

    it('RS: joining an unknown room fails', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: 'RS:00000000-0000-0000-0000-000000000000' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: false,
        error: 'Room not found or expired',
      });
    });

    it('RS: joining a bingo room activates it', async () => {
      const roomId = await createBingoRoom();
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: `RS:${roomId}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.action).toBe('joinedRoom');
      expect(body.storeRoomId).toBe(roomId);
      expect(body.data.type).toBe('bingo');

      const state = await app.inject({
        method: 'GET',
        url: `/api/game/room/${roomId}`,
        headers: authHeader(host.token),
      });
      expect(state.json().room.state).toBe('active');
    });

    it('RV: validates an existing room and reports unknown ones', async () => {
      const roomId = await createBingoRoom();
      const valid = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: 'RV', roomId },
      });
      expect(valid.json()).toMatchObject({
        success: true,
        data: { valid: true, type: 'bingo', state: 'created' },
      });

      const invalid = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: 'RV' },
      });
      expect(invalid.json()).toMatchObject({
        success: false,
        data: { valid: false, reason: 'not_found' },
      });
    });

    it('TS: maps a scanned track to its bingo number and records it', async () => {
      const roomId = await createBingoRoom();
      const third = fix.tracks[2]; // bingoNumber 3
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: `TS:${third.id}`, roomId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.bingoNumber).toBe(3);
      expect(body.data.playedCount).toBe(1);

      // Re-scanning the same track does not double-count it.
      const again = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: `TS:${third.id}`, roomId },
      });
      expect(again.json().data.playedCount).toBe(1);

      const state = await app.inject({
        method: 'GET',
        url: `/api/game/room/${roomId}`,
        headers: authHeader(host.token),
      });
      expect(state.json().room.pluginData.playedTrackIds).toEqual([3]);
    });

    it('TS: rejects a track that is not in the bingo playlist', async () => {
      const roomId = await createBingoRoom();
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: 'TS:999999', roomId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: false,
        error: 'Track not in bingo playlist',
      });
    });
  });

  describe('POST /api/game/room/:roomId/plugin', () => {
    it('validates plugin actions and merges plugin data for the owner', async () => {
      const roomId = await createBingoRoom();

      const invalid = await app.inject({
        method: 'POST',
        url: `/api/game/room/${roomId}/plugin`,
        headers: authHeader(host.token),
        payload: { action: 'updateGameMode', data: { gameMode: 'SPIRAL' } },
      });
      expect(invalid.statusCode).toBe(400);

      const ok = await app.inject({
        method: 'POST',
        url: `/api/game/room/${roomId}/plugin`,
        headers: authHeader(host.token),
        payload: { action: 'updateGameMode', data: { gameMode: 'VERTICAL' } },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().pluginData.gameMode).toBe('VERTICAL');
    });

    it('refuses plugin updates from non-owners', async () => {
      const roomId = await createBingoRoom();
      const res = await app.inject({
        method: 'POST',
        url: `/api/game/room/${roomId}/plugin`,
        headers: authHeader(stranger.token),
        payload: { action: 'updateGameMode', data: { gameMode: 'VERTICAL' } },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/game/room/:roomId', () => {
    it('only the owner can end a room; ended rooms refuse joins', async () => {
      const roomId = await createBingoRoom();

      const denied = await app.inject({
        method: 'DELETE',
        url: `/api/game/room/${roomId}`,
        headers: authHeader(stranger.token),
      });
      expect(denied.statusCode).toBe(403);

      const ok = await app.inject({
        method: 'DELETE',
        url: `/api/game/room/${roomId}`,
        headers: authHeader(host.token),
      });
      expect(ok.statusCode).toBe(200);

      const dbRoom = await prisma().gameRoom.findUnique({
        where: { uuid: roomId },
      });
      expect(dbRoom!.state).toBe('ended');
      expect(dbRoom!.endedAt).toBeTruthy();

      const rejoin = await app.inject({
        method: 'POST',
        url: '/api/game/message',
        payload: { message: `RS:${roomId}` },
      });
      expect(rejoin.json()).toMatchObject({
        success: false,
        error: 'Room has ended',
      });
    });

    it('returns 404 for an unknown room', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/game/room/00000000-0000-0000-0000-000000000000',
        headers: authHeader(host.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/game/timeline/:paymentHasPlaylistId', () => {
    it('validates id, ownership and the gamesEnabled flag', async () => {
      const bad = await app.inject({
        method: 'GET',
        url: '/api/game/timeline/abc',
        headers: authHeader(host.token),
      });
      expect(bad.statusCode).toBe(400);

      const missing = await app.inject({
        method: 'GET',
        url: '/api/game/timeline/999999',
        headers: authHeader(host.token),
      });
      expect(missing.statusCode).toBe(404);

      const notOwner = await app.inject({
        method: 'GET',
        url: `/api/game/timeline/${fix.php.id}`,
        headers: authHeader(stranger.token),
      });
      expect(notOwner.statusCode).toBe(403);

      const disabled = await seedPaidPlaylist({
        user: host,
        trackCount: 0,
        gamesEnabled: false,
      });
      const notEnabled = await app.inject({
        method: 'GET',
        url: `/api/game/timeline/${disabled.php.id}`,
        headers: authHeader(host.token),
      });
      expect(notEnabled.statusCode).toBe(403);
      expect(notEnabled.json().error).toBe(
        'QRGames not enabled for this playlist'
      );
    });

    it('returns year-bearing tracks for the owner', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/game/timeline/${fix.php.id}`,
        headers: authHeader(host.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.playlistName).toBe(fix.playlist.name);
      expect(body.tracks).toHaveLength(10);
      expect(body.tracks[0].year).toBe(1980);
      expect(body.tracks[0].name).toBe('Game Song 0');
    });
  });

  describe('POST /api/game/calculate-price', () => {
    it('validates input, ownership and the already-enabled state', async () => {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/game/calculate-price',
        headers: authHeader(host.token),
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const unknown = await app.inject({
        method: 'POST',
        url: '/api/game/calculate-price',
        headers: authHeader(host.token),
        payload: { paymentHasPlaylistIds: [999999] },
      });
      expect(unknown.statusCode).toBe(404);

      const notOwner = await app.inject({
        method: 'POST',
        url: '/api/game/calculate-price',
        headers: authHeader(stranger.token),
        payload: { paymentHasPlaylistIds: [fix.php.id] },
      });
      expect(notOwner.statusCode).toBe(403);

      // fix.php already has games enabled.
      const alreadyEnabled = await app.inject({
        method: 'POST',
        url: '/api/game/calculate-price',
        headers: authHeader(host.token),
        payload: { paymentHasPlaylistIds: [fix.php.id] },
      });
      expect(alreadyEnabled.statusCode).toBe(400);
      expect(alreadyEnabled.json().error).toContain('already enabled');
    });

    it('prices upgrades with the volume discount (EUR presentment fallback)', async () => {
      const a = await seedPaidPlaylist({
        user: host,
        trackCount: 0,
        gamesEnabled: false,
      });
      const b = await seedPaidPlaylist({
        user: host,
        trackCount: 0,
        gamesEnabled: false,
      });

      const single = await app.inject({
        method: 'POST',
        url: '/api/game/calculate-price',
        headers: authHeader(host.token),
        payload: { paymentHasPlaylistIds: [a.php.id] },
      });
      expect(single.statusCode).toBe(200);
      expect(single.json()).toMatchObject({
        success: true,
        count: 1,
        basePrice: 5,
        totalPrice: 5,
        discount: 0,
        presentment: { currency: 'EUR', total: 5, rate: 1 },
      });

      const dual = await app.inject({
        method: 'POST',
        url: '/api/game/calculate-price',
        headers: authHeader(host.token),
        payload: { paymentHasPlaylistIds: [a.php.id, b.php.id] },
      });
      expect(dual.statusCode).toBe(200);
      expect(dual.json()).toMatchObject({
        count: 2,
        pricePerPlaylist: 4.5,
        totalPrice: 9,
        discount: 10,
        savings: 1,
      });
      expect(dual.json().playlists).toHaveLength(2);
    });
  });
});
