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
// The quiz routes instantiate ChatGPT for AI question generation. Anything
// that would hit OpenAI is mocked at the module boundary; per-test return
// values are programmed through the hoisted holder.
const chatgptMock = vi.hoisted(() => ({
  generateQuizQuestions: vi.fn(),
  regenerateQuizQuestion: vi.fn(),
  generateWrongOptions: vi.fn(),
}));

vi.mock('../../src/chatgpt', () => ({
  ChatGPT: class ChatGPTMock {
    generateQuizQuestions = chatgptMock.generateQuizQuestions;
    regenerateQuizQuestion = chatgptMock.regenerateQuizQuestion;
    generateWrongOptions = chatgptMock.generateWrongOptions;
  },
}));

// A 1x1 transparent PNG, used for avatar/question image uploads (sharp
// processes it for real — tiny and fast).
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

/**
 * Seed a paid order with a playlist + tracks, the shape the quiz ownership
 * query (payments → users → payment_has_playlist → playlists) expects.
 */
async function seedPaidPlaylist(opts: {
  user: TestUser;
  trackCount: number;
  gamesEnabled?: boolean;
}): Promise<Fixture> {
  seq++;
  const tag = `quiz-${Date.now()}-${seq}`;
  const payment = await prisma().payment.create({
    data: {
      userId: opts.user.user.id,
      paymentId: `tr_${tag}`,
      status: 'paid',
      totalPrice: 25,
      fullname: 'Quiz Tester',
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
      name: `Quiz Playlist ${tag}`,
      image: 'test.png',
      numberOfTracks: opts.trackCount,
    },
  });
  await prisma().track.createMany({
    data: Array.from({ length: opts.trackCount }, (_, i) => ({
      trackId: `trk_${tag}_${String(i).padStart(3, '0')}`,
      name: `Test Song Number ${i}`,
      artist: `Test Artist ${i}`,
      year: 1970 + (i % 50),
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

/** Create a quiz with `n` simple year questions directly in the database. */
async function seedQuiz(fix: Fixture, n = 3, useAi = false) {
  return prisma().quiz.create({
    data: {
      paymentHasPlaylistId: fix.php.id,
      name: 'Seeded Quiz',
      timerSeconds: 20,
      listeningSeconds: 8,
      locale: 'en',
      useAi,
      questions: {
        create: fix.tracks.slice(0, n).map((t, i) => ({
          trackId: t.id,
          order: i,
          type: 'year',
          question: 'In which year was this song released?',
          correctAnswer: String(t.year),
        })),
      },
    },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
}

async function waitForGeneration(
  app: FastifyInstance,
  token: string,
  generationId: string
): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/quiz/generate/progress/${generationId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (body.status === 'complete' || body.status === 'error') return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Quiz generation did not finish in time');
}

describe('quiz routes', () => {
  let app: FastifyInstance;
  let owner: TestUser;
  let fix: Fixture;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();

    // The avatar/question-image routes write into PUBLIC_DIR subdirs but do
    // not create them; production provisions these on deploy.
    for (const dir of ['avatars', 'quiz_images']) {
      fs.mkdirSync(path.join(process.env['PUBLIC_DIR']!, dir), {
        recursive: true,
      });
    }

    owner = await createTestUser();
    fix = await seedPaidPlaylist({ user: owner, trackCount: 10 });
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('authentication', () => {
    it('rejects quiz endpoints without a token', async () => {
      const cases = [
        { method: 'POST' as const, url: '/api/quiz/generate' },
        { method: 'GET' as const, url: '/api/quiz/1' },
        { method: 'GET' as const, url: `/api/quiz/list/${fix.php.id}` },
        { method: 'DELETE' as const, url: '/api/quiz/1' },
      ];
      for (const c of cases) {
        const res = await app.inject({ ...c, payload: undefined });
        expect(res.statusCode).toBe(401);
      }
    });
  });

  describe('POST /api/quiz/generate', () => {
    it('rejects fewer than 5 selected tracks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/quiz/generate',
        headers: authHeader(owner.token),
        payload: {
          paymentId: fix.payment.paymentId,
          userHash: owner.user.hash,
          playlistId: fix.playlist.playlistId,
          selectedTracks: fix.tracks.slice(0, 3).map((t) => t.trackId),
          useAi: false,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
    });

    it('rejects a paymentId/userHash that does not own the playlist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/quiz/generate',
        headers: authHeader(owner.token),
        payload: {
          paymentId: 'tr_does_not_exist',
          userHash: owner.user.hash,
          playlistId: fix.playlist.playlistId,
          selectedTracks: fix.tracks.slice(0, 6).map((t) => t.trackId),
          useAi: false,
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized or playlist not found');
    });

    it('generates a non-AI quiz end to end (generate → poll progress → quiz in DB)', async () => {
      const selected = fix.tracks.slice(0, 6).map((t) => t.trackId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/quiz/generate',
        headers: authHeader(owner.token),
        payload: {
          paymentId: fix.payment.paymentId,
          userHash: owner.user.hash,
          playlistId: fix.playlist.playlistId,
          selectedTracks: selected,
          useAi: false,
          questionTypes: ['year'],
          name: 'Generated Quiz',
          timerSeconds: 25,
          listeningSeconds: 10,
          locale: 'en',
        },
      });
      expect(res.statusCode).toBe(200);
      const { success, generationId } = res.json();
      expect(success).toBe(true);
      expect(generationId).toBeTruthy();

      const progress = await waitForGeneration(app, owner.token, generationId);
      expect(progress.status).toBe('complete');
      expect(progress.quizId).toBeTruthy();

      const quiz = await prisma().quiz.findUnique({
        where: { id: progress.quizId },
        include: { questions: true },
      });
      expect(quiz).toBeTruthy();
      expect(quiz!.name).toBe('Generated Quiz');
      expect(quiz!.useAi).toBe(false);
      expect(quiz!.timerSeconds).toBe(25);
      expect(quiz!.questions).toHaveLength(6);
      for (const q of quiz!.questions) {
        expect(q.type).toBe('year');
        expect(q.correctAnswer).toMatch(/^\d{4}$/);
      }
      // No AI question generation may have happened for a non-AI quiz.
      expect(chatgptMock.generateQuizQuestions).not.toHaveBeenCalled();
    });

    it('returns 429 once the weekly AI quiz limit (3) is used up', async () => {
      const heavyUser = await createTestUser();
      const heavyFix = await seedPaidPlaylist({
        user: heavyUser,
        trackCount: 6,
      });
      for (let i = 0; i < 3; i++) await seedQuiz(heavyFix, 1, true);

      const usage = await app.inject({
        method: 'GET',
        url: `/api/quiz/ai-usage/${heavyUser.user.hash}`,
        headers: authHeader(heavyUser.token),
      });
      expect(usage.statusCode).toBe(200);
      expect(usage.json()).toMatchObject({ used: 3, remaining: 0, limit: 3 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/quiz/generate',
        headers: authHeader(heavyUser.token),
        payload: {
          paymentId: heavyFix.payment.paymentId,
          userHash: heavyUser.user.hash,
          playlistId: heavyFix.playlist.playlistId,
          selectedTracks: heavyFix.tracks.slice(0, 5).map((t) => t.trackId),
          // useAi omitted → defaults to AI → limit applies
        },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe('quiz.aiLimitReached');
    });

    it('returns 404 for an unknown generation progress id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/quiz/generate/progress/no-such-generation',
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('quiz CRUD', () => {
    it('GET /api/quiz/:quizId returns the quiz with track-enriched questions', async () => {
      const quiz = await seedQuiz(fix, 3);
      const res = await app.inject({
        method: 'GET',
        url: `/api/quiz/${quiz.id}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.quiz.id).toBe(quiz.id);
      expect(body.quiz.questions).toHaveLength(3);
      expect(body.quiz.questions[0].trackName).toBe(fix.tracks[0].name);
      expect(body.quiz.questions[0].trackArtist).toBe(fix.tracks[0].artist);
      expect(body.quiz.paymentHasPlaylist.playlist.name).toBe(
        fix.playlist.name
      );
    });

    it('GET /api/quiz/:quizId returns 404 for an unknown quiz', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/quiz/999999',
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('lists quizzes for a paymentHasPlaylist with question counts', async () => {
      const quiz = await seedQuiz(fix, 2);
      const res = await app.inject({
        method: 'GET',
        url: `/api/quiz/list/${fix.php.id}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const { quizzes } = res.json();
      const listed = quizzes.find((q: any) => q.id === quiz.id);
      expect(listed).toBeTruthy();
      expect(listed._count.questions).toBe(2);
    });

    it('updates quiz settings', async () => {
      const quiz = await seedQuiz(fix, 1);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/quiz/${quiz.id}`,
        headers: authHeader(owner.token),
        payload: { name: 'Renamed', timerSeconds: 30 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().quiz.name).toBe('Renamed');
      const inDb = await prisma().quiz.findUnique({ where: { id: quiz.id } });
      expect(inDb!.timerSeconds).toBe(30);
      expect(inDb!.listeningSeconds).toBe(8); // untouched
    });

    it('deletes a quiz and cascades its questions', async () => {
      const quiz = await seedQuiz(fix, 2);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/quiz/${quiz.id}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(
        await prisma().quiz.findUnique({ where: { id: quiz.id } })
      ).toBeNull();
      expect(
        await prisma().quizQuestion.count({ where: { quizId: quiz.id } })
      ).toBe(0);
    });

    it('SUSPECTED BUG: any authenticated user can read another user\'s quiz', async () => {
      // The quiz CRUD endpoints only check the "users" group — there is no
      // ownership check linking the quiz back to the requesting user. This
      // test documents the actual (insecure) behavior; if it starts failing
      // with a 403/404 the hole has been fixed and the assertion should flip.
      const quiz = await seedQuiz(fix, 1);
      const stranger = await createTestUser();
      const res = await app.inject({
        method: 'GET',
        url: `/api/quiz/${quiz.id}`,
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().quiz.id).toBe(quiz.id);
    });
  });

  describe('question CRUD', () => {
    it('updates a question', async () => {
      const quiz = await seedQuiz(fix, 1);
      const q = quiz.questions[0];
      const res = await app.inject({
        method: 'PUT',
        url: `/api/quiz/${quiz.id}/question/${q.id}`,
        headers: authHeader(owner.token),
        payload: {
          question: 'New question text?',
          correctAnswer: '1999',
          options: ['1998', '1999', '2000', '2001'],
        },
      });
      expect(res.statusCode).toBe(200);
      const inDb = await prisma().quizQuestion.findUnique({
        where: { id: q.id },
      });
      expect(inDb!.question).toBe('New question text?');
      expect(inDb!.correctAnswer).toBe('1999');
      expect(inDb!.options).toEqual(['1998', '1999', '2000', '2001']);
    });

    it('SUSPECTED BUG: updating a question under the wrong quiz id returns 500, not 404', async () => {
      // The route lets Prisma's P2025 "record not found" bubble into the
      // generic catch → 500. A 404 would be the correct status.
      const quizA = await seedQuiz(fix, 1);
      const quizB = await seedQuiz(fix, 1);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/quiz/${quizB.id}/question/${quizA.questions[0].id}`,
        headers: authHeader(owner.token),
        payload: { question: 'hijack' },
      });
      expect(res.statusCode).toBe(500);
      const untouched = await prisma().quizQuestion.findUnique({
        where: { id: quizA.questions[0].id },
      });
      expect(untouched!.question).not.toBe('hijack');
    });

    it('adds a blank question with the next order', async () => {
      const quiz = await seedQuiz(fix, 2);
      const res = await app.inject({
        method: 'POST',
        url: `/api/quiz/${quiz.id}/question`,
        headers: authHeader(owner.token),
        payload: { type: 'trivia' },
      });
      expect(res.statusCode).toBe(200);
      const { question } = res.json();
      expect(question.order).toBe(2);
      expect(question.type).toBe('trivia');
      expect(question.question).toBe('');
      expect(question.trackName).toBe(fix.tracks[0].name);
      expect(
        await prisma().quizQuestion.count({ where: { quizId: quiz.id } })
      ).toBe(3);
    });

    it('reorders questions', async () => {
      const quiz = await seedQuiz(fix, 3);
      const reversed = quiz.questions.map((q) => q.id).reverse();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/quiz/${quiz.id}/reorder`,
        headers: authHeader(owner.token),
        payload: { questionIds: reversed },
      });
      expect(res.statusCode).toBe(200);

      const after = await app.inject({
        method: 'GET',
        url: `/api/quiz/${quiz.id}`,
        headers: authHeader(owner.token),
      });
      expect(after.json().quiz.questions.map((q: any) => q.id)).toEqual(
        reversed
      );
    });

    it('rejects reorder without a questionIds array', async () => {
      const quiz = await seedQuiz(fix, 1);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/quiz/${quiz.id}/reorder`,
        headers: authHeader(owner.token),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('deletes a question', async () => {
      const quiz = await seedQuiz(fix, 2);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/quiz/${quiz.id}/question/${quiz.questions[0].id}`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(
        await prisma().quizQuestion.findUnique({
          where: { id: quiz.questions[0].id },
        })
      ).toBeNull();
    });
  });

  describe('AI-assisted question editing (mocked LLM)', () => {
    it('regenerates a question via the (mocked) LLM', async () => {
      const quiz = await seedQuiz(fix, 1);
      const q = quiz.questions[0];
      chatgptMock.regenerateQuizQuestion.mockResolvedValueOnce({
        question: 'Regenerated question?',
        options: ['A', 'B', 'C', 'D'],
        correctAnswer: 'B',
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/quiz/${quiz.id}/question/${q.id}/regenerate`,
        headers: authHeader(owner.token),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().question.question).toBe('Regenerated question?');
      expect(chatgptMock.regenerateQuizQuestion).toHaveBeenCalledTimes(1);
      const inDb = await prisma().quizQuestion.findUnique({
        where: { id: q.id },
      });
      expect(inDb!.correctAnswer).toBe('B');
    });

    it('returns 404 when regenerating an unknown question', async () => {
      const quiz = await seedQuiz(fix, 1);
      const res = await app.inject({
        method: 'POST',
        url: `/api/quiz/${quiz.id}/question/999999/regenerate`,
        headers: authHeader(owner.token),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it('generates wrong options via the (mocked) LLM and validates input', async () => {
      const quiz = await seedQuiz(fix, 1);
      const q = quiz.questions[0];

      const missing = await app.inject({
        method: 'POST',
        url: `/api/quiz/${quiz.id}/question/${q.id}/ai-options`,
        headers: authHeader(owner.token),
        payload: { question: 'Only a question' },
      });
      expect(missing.statusCode).toBe(400);

      chatgptMock.generateWrongOptions.mockResolvedValueOnce([
        'Wrong 1',
        'Wrong 2',
        'Wrong 3',
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/api/quiz/${quiz.id}/question/${q.id}/ai-options`,
        headers: authHeader(owner.token),
        payload: { question: 'Who sang it?', correctAnswer: 'Test Artist 0' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().wrongOptions).toEqual(['Wrong 1', 'Wrong 2', 'Wrong 3']);
    });
  });

  describe('images', () => {
    it('uploads and deletes a question image', async () => {
      const quiz = await seedQuiz(fix, 1);
      const q = quiz.questions[0];

      const up = await app.inject({
        method: 'POST',
        url: `/api/quiz/${quiz.id}/question/${q.id}/upload-image`,
        headers: authHeader(owner.token),
        payload: { image: PNG_1X1 },
      });
      expect(up.statusCode).toBe(200);
      const { filename } = up.json();
      expect(filename).toMatch(/\.png$/);
      const onDisk = path.join(
        process.env['PUBLIC_DIR']!,
        'quiz_images',
        filename
      );
      expect(fs.existsSync(onDisk)).toBe(true);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/quiz/${quiz.id}/question/${q.id}/image`,
        headers: authHeader(owner.token),
      });
      expect(del.statusCode).toBe(200);
      const inDb = await prisma().quizQuestion.findUnique({
        where: { id: q.id },
      });
      expect(inDb!.imageFilename).toBeNull();
      expect(fs.existsSync(onDisk)).toBe(false);
    });

    it('rejects an invalid avatar payload and accepts a valid one (public endpoint)', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/quiz/avatar',
        payload: { image: 'not-a-data-uri' },
      });
      expect(bad.statusCode).toBe(400);

      const ok = await app.inject({
        method: 'POST',
        url: '/api/quiz/avatar',
        payload: { image: PNG_1X1 },
      });
      expect(ok.statusCode).toBe(200);
      const { filename } = ok.json();
      expect(
        fs.existsSync(
          path.join(process.env['PUBLIC_DIR']!, 'avatars', filename)
        )
      ).toBe(true);
    });
  });

  describe('quiz room lifecycle (REST)', () => {
    it('creates a room for a quiz and exposes it to players', async () => {
      const quiz = await seedQuiz(fix, 3);
      const res = await app.inject({
        method: 'POST',
        url: `/api/quiz/${quiz.id}/room`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.roomId).toBeTruthy();
      expect(body.hostQrData).toBe(`QRSSM:RS:${body.roomId}`);
      expect(body.playerQrUrl).toBe(`quiz/${body.roomId}`);
      expect(body.questionCount).toBe(3);

      const dbRoom = await prisma().gameRoom.findUnique({
        where: { uuid: body.roomId },
      });
      expect(dbRoom).toBeTruthy();
      expect(dbRoom!.type).toBe('quiz');
      expect(dbRoom!.state).toBe('created');

      // Public player endpoint (no auth) sees the lobby.
      const player = await app.inject({
        method: 'GET',
        url: `/api/quiz/player/${body.roomId}`,
      });
      expect(player.statusCode).toBe(200);
      const playerBody = player.json();
      expect(playerBody.quizName).toBe('Seeded Quiz');
      expect(playerBody.room.phase).toBe('lobby');
      expect(playerBody.room.playerCount).toBe(0);
      expect(playerBody.room.totalQuestions).toBe(3);
    });

    it('refuses to create a room for a quiz without questions', async () => {
      const empty = await prisma().quiz.create({
        data: { paymentHasPlaylistId: fix.php.id, name: 'Empty' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/quiz/${empty.id}/room`,
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Quiz has no questions');
    });

    it('returns 404 for an unknown player room', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/quiz/player/00000000-0000-0000-0000-000000000000',
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
