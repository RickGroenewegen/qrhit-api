import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader, TestUser } from '../helpers/auth';

// The production entrypoints (src/app.ts / src/worker.ts) globally patch
// PDF generation spins up headless Chromium against a render URL — far too
// heavy (and non-deterministic) for tests, so the module is mocked. The zip
// packaging, file bookkeeping and DB writes around it all run for real.
const pdfMock = vi.hoisted(() => ({
  generatePdfFromUrl: vi.fn(),
}));

vi.mock('../../src/pdf', () => ({
  default: class PdfMock {
    generatePdfFromUrl = pdfMock.generatePdfFromUrl;
  },
}));

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

/** Seed a paid order + playlist + tracks matching the bingo ownership query. */
async function seedPaidPlaylist(opts: {
  user: TestUser;
  trackCount: number;
  gamesEnabled?: boolean;
}): Promise<Fixture> {
  seq++;
  const tag = `bingo-${Date.now()}-${seq}`;
  const payment = await prisma().payment.create({
    data: {
      userId: opts.user.user.id,
      paymentId: `tr_${tag}`,
      status: 'paid',
      totalPrice: 25,
      fullname: 'Bingo Tester',
      email: opts.user.user.email,
      productPriceWithoutTax: 20,
      shippingPriceWithoutTax: 0,
      productVATPrice: 5,
      shippingVATPrice: 0,
      totalVATPrice: 5,
      qrSubDir: 'testsubdir',
    },
  });
  const playlist = await prisma().playlist.create({
    data: {
      playlistId: `pl_${tag}`,
      name: `Bingo Playlist ${tag}`,
      image: 'test.png',
      numberOfTracks: opts.trackCount,
    },
  });
  await prisma().track.createMany({
    data: Array.from({ length: opts.trackCount }, (_, i) => ({
      trackId: `trk_${tag}_${String(i).padStart(3, '0')}`,
      name: `Bingo Song ${i}`,
      artist: `Bingo Artist ${i}`,
      year: 1960 + (i % 60),
    })),
  });
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

describe('bingo routes', () => {
  let app: FastifyInstance;
  let owner: TestUser;
  let big: Fixture; // 80 tracks — passes the 75-track validity bar
  let small: Fixture; // 30 tracks — fails it

  const creds = (f: Fixture) => ({
    paymentId: f.payment.paymentId,
    userHash: f.user.user.hash,
    playlistId: f.playlist.playlistId,
  });

  beforeAll(async () => {
    pdfMock.generatePdfFromUrl.mockResolvedValue(
      Buffer.from('%PDF-1.4\nfake-test-pdf')
    );
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    // Scratch dirs persist between runs — start with a clean bingo dir so
    // "no leftover PDFs" assertions are about THIS run.
    const bingoDir = path.join(process.env['PUBLIC_DIR']!, 'bingo');
    fs.rmSync(bingoDir, { recursive: true, force: true });

    owner = await createTestUser();
    big = await seedPaidPlaylist({ user: owner, trackCount: 80 });
    small = await seedPaidPlaylist({ user: owner, trackCount: 30 });
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('POST /api/bingo/preview', () => {
    it('rejects missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/preview',
        payload: { paymentId: 'x' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects credentials that do not own the playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/preview',
        payload: { ...creds(big), userHash: 'wrong-hash' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized or playlist not found');
    });

    it('returns tracks and a valid config for a 80-track playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/preview',
        payload: { ...creds(big), contestants: 10, rounds: 3 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.trackCount).toBe(80);
      expect(body.tracks).toHaveLength(80);
      expect(body.playlistName).toBe(big.playlist.name);
      expect(body.validation.valid).toBe(true);
      expect(body.validation.sheetsNeeded).toBe(30);
      expect(body.existingBingoFiles).toEqual([]);
    });

    it('flags playlists under 75 tracks as invalid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/preview',
        payload: { ...creds(small) },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.validation.valid).toBe(false);
      expect(body.validation.warning).toContain('Minimum 75 tracks');
    });
  });

  describe('POST /api/bingo/generate — validation', () => {
    it('rejects missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/generate',
        payload: { ...creds(big) }, // no contestants/rounds
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects out-of-range contestants and rounds', async () => {
      const tooManyContestants = await app.inject({
        method: 'POST',
        url: '/api/bingo/generate',
        payload: { ...creds(big), contestants: 101, rounds: 2 },
      });
      expect(tooManyContestants.statusCode).toBe(400);

      const tooManyRounds = await app.inject({
        method: 'POST',
        url: '/api/bingo/generate',
        payload: { ...creds(big), contestants: 10, rounds: 11 },
      });
      expect(tooManyRounds.statusCode).toBe(400);
    });

    it('rejects configurations above 500 total sheets', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/generate',
        payload: { ...creds(big), contestants: 100, rounds: 6 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Maximum 500 sheets');
    });

    it('rejects bad ownership with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/generate',
        payload: {
          ...creds(big),
          paymentId: 'tr_unknown',
          contestants: 10,
          rounds: 2,
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when games are not enabled for the order', async () => {
      const disabled = await seedPaidPlaylist({
        user: owner,
        trackCount: 5,
        gamesEnabled: false,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/generate',
        payload: { ...creds(disabled), contestants: 10, rounds: 2 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('bingoNotEnabled');
    });

    it('rejects a track selection below the contestant-based minimum', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/generate',
        payload: {
          ...creds(big),
          contestants: 10,
          rounds: 2,
          selectedTracks: big.tracks.slice(0, 10).map((t) => t.trackId),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Minimum 40 tracks required');
    });
  });

  describe('POST /api/bingo/generate — happy path (PDF mocked)', () => {
    it('generates sheets + host cards, zips them and records a BingoFile', async () => {
      pdfMock.generatePdfFromUrl.mockClear();
      const res = await app.inject({
        method: 'POST',
        url: '/api/bingo/generate',
        payload: {
          ...creds(big),
          contestants: 10,
          rounds: 2,
          locale: 'en',
          generateHostCards: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.sheetsGenerated).toBe(20);
      expect(body.filename).toMatch(/_bingo_[0-9a-f]{16}\.zip$/);
      expect(body.downloadUrl).toContain(`/public/bingo/${body.filename}`);

      // One PDF for the cards, one for the host cards.
      expect(pdfMock.generatePdfFromUrl).toHaveBeenCalledTimes(2);
      expect(pdfMock.generatePdfFromUrl.mock.calls[0][0]).toContain(
        '/bingo/render/'
      );
      expect(pdfMock.generatePdfFromUrl.mock.calls[1][0]).toContain(
        '/bingo/render-hostcards/'
      );

      // ZIP really exists; intermediate PDFs were cleaned up.
      const bingoDir = path.join(process.env['PUBLIC_DIR']!, 'bingo');
      expect(fs.existsSync(path.join(bingoDir, body.filename))).toBe(true);
      expect(
        fs.readdirSync(bingoDir).filter((f) => f.endsWith('.pdf'))
      ).toEqual([]);

      const file = await prisma().bingoFile.findFirst({
        where: { filename: body.filename },
      });
      expect(file).toBeTruthy();
      expect(file!.paymentHasPlaylistId).toBe(big.php.id);
      expect(file!.contestants).toBe(10);
      expect(file!.rounds).toBe(2);
      expect(file!.trackCount).toBe(80);
      expect(file!.selectedTrackIds).toHaveLength(80);
    });
  });

  describe('GET /bingo/render/:configId', () => {
    it('returns 404 for an unknown/expired config', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/bingo/render/deadbeefdeadbeef',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/bingo/host/:filename', () => {
    let filename: string;

    beforeAll(async () => {
      filename = `seeded_host_${Date.now()}.zip`;
      await prisma().bingoFile.create({
        data: {
          paymentHasPlaylistId: big.php.id,
          filename,
          contestants: 8,
          rounds: 2,
          trackCount: 80,
        },
      });
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/bingo/host/${filename}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for an unknown filename', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/bingo/host/nope.zip',
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Bingo file not found');
    });

    it('refuses another user\'s bingo file', async () => {
      const stranger = await createTestUser();
      const res = await app.inject({
        method: 'GET',
        url: `/api/bingo/host/${filename}`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('returns numbered tracks for the owner', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/bingo/host/${filename}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.playlistName).toBe(big.playlist.name);
      expect(body.rounds).toBe(2);
      expect(body.contestants).toBe(8);
      expect(body.tracks).toHaveLength(80);
      expect(body.tracks[0].bingoNumber).toBe(1);
      expect(body.tracks[79].bingoNumber).toBe(80);
      expect(body.tracks[0].name).toBe('Bingo Song 0');
    });
  });

  describe('DELETE /api/bingo/file/:filename', () => {
    it('refuses deletion by a non-owner and deletes for the owner', async () => {
      const filename = `seeded_delete_${Date.now()}.zip`;
      const row = await prisma().bingoFile.create({
        data: {
          paymentHasPlaylistId: big.php.id,
          filename,
          contestants: 5,
          rounds: 1,
          trackCount: 80,
        },
      });

      const stranger = await createTestUser();
      const denied = await app.inject({
        method: 'DELETE',
        url: `/api/bingo/file/${filename}`,
        headers: authHeader(stranger.token),
      });
      expect(denied.statusCode).toBe(401);
      expect(
        await prisma().bingoFile.findUnique({ where: { id: row.id } })
      ).toBeTruthy();

      const ok = await app.inject({
        method: 'DELETE',
        url: `/api/bingo/file/${filename}`,
        headers: authHeader(owner.token),
      });
      expect(ok.statusCode).toBe(200);
      expect(
        await prisma().bingoFile.findUnique({ where: { id: row.id } })
      ).toBeNull();
    });
  });
});
