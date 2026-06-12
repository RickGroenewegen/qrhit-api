import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import CacheInstance from '../../src/cache';
import {
  startTestWsServer,
  WsTestClient,
  TestWsServer,
} from '../helpers/wsServer';

/**
 * Live quiz-protocol tests against the real NativeWebSocketServer:
 * host actions (startQuiz → showQuestion → showReveal → showRanking →
 * nextQuestion → final), answer scoring per question type, rejoin flows,
 * updatePluginData/endRoom, host-app connections and heartbeat reaping.
 *
 * Room state lives in Redis db 1 (hardcoded in production code); quiz
 * question data lives in the app cache (src/cache, version-prefixed keys,
 * db REDIS_DB=9 under test) — both seeded with throwaway UUIDs + short TTL.
 */

const QUESTIONS = [
  {
    type: 'trivia',
    question: 'Capital of France?',
    options: ['Paris', 'London', 'Berlin', 'Madrid'],
    correctAnswer: 'Paris',
    trackName: 'Track One',
    trackArtist: 'Artist One',
    trackYear: 1999,
    trackId: 111,
    imageFilename: null,
  },
  {
    type: 'year',
    question: 'In which year was Track Two released?',
    options: [],
    correctAnswer: '1990',
    trackName: 'Track Two',
    trackArtist: 'Artist Two',
    trackYear: 1990,
    trackId: 222,
  },
  {
    type: 'release_order',
    question: 'Where does this track belong?',
    options: ['Song A', 'Song B', 'Song C'],
    optionYears: [1970, 1980, 1990],
    correctAnswer: '1',
    trackName: 'Track Three',
    trackArtist: 'Artist Three',
    trackYear: 1980,
    trackId: 333,
  },
];

describe('quiz websocket flows', () => {
  let server: TestWsServer;
  let redis: Redis;
  const cache = CacheInstance.getInstance();
  const clients: WsTestClient[] = [];

  beforeAll(async () => {
    server = await startTestWsServer();
    redis = new Redis(process.env['REDIS_URL']!, { db: 1 });
    // cache.init() loads the package.json version used as key prefix;
    // await it so seeding and the server read the same keys.
    await cache.init();
  });

  afterAll(async () => {
    await server.close();
    await redis.quit();
  });

  beforeEach(() => {
    for (const c of clients.splice(0)) c.close();
  });

  async function connect(): Promise<WsTestClient> {
    const client = new WsTestClient(server.port);
    clients.push(client);
    await client.opened();
    return client;
  }

  /** Seed room state (Redis db 1) + quiz questions (app cache). */
  async function seedQuizRoom(
    overrides: Record<string, unknown> = {},
    questions: any[] = QUESTIONS
  ): Promise<string> {
    const uuid = randomUUID();
    const roomState = {
      id: 0,
      uuid,
      type: 'quiz',
      userId: 0,
      state: 'created',
      lastActivity: Date.now(),
      pluginData: {
        quizId: 0,
        quizCacheKey: `quiz:room:${uuid}`,
        quizName: 'Test Quiz',
        currentQuestionIndex: -1,
        phase: 'lobby',
        players: {},
        answers: {},
        timerSeconds: 20,
        listeningSeconds: 10,
        questionStartedAt: null,
        totalQuestions: questions.length,
        trackMapping: {},
        ...overrides,
      },
    };
    await redis.set(`room:${uuid}`, JSON.stringify(roomState), 'EX', 300);
    await cache.set(`quiz:room:${uuid}`, JSON.stringify({ questions }), 300);
    return uuid;
  }

  async function getRoom(roomId: string): Promise<any> {
    return JSON.parse((await redis.get(`room:${roomId}`))!);
  }

  async function joinHost(roomId: string): Promise<WsTestClient> {
    const host = await connect();
    await host.waitFor('connected');
    host.send({ type: 'joinRoom', data: { roomId, isHost: true } });
    await host.waitFor('roomJoined');
    return host;
  }

  async function joinPlayer(
    roomId: string,
    playerName: string
  ): Promise<{ client: WsTestClient; connectionId: string }> {
    const client = await connect();
    const connected = await client.waitFor('connected');
    client.send({ type: 'quizJoinPlayer', data: { roomId, playerName } });
    await client.waitFor('quizJoinedConfirm');
    return { client, connectionId: connected.data.connectionId };
  }

  function clear(...cs: WsTestClient[]) {
    for (const c of cs) c.messages.length = 0;
  }

  /** Assert no message of `type` arrives within `ms`. */
  async function expectNoMessage(
    client: WsTestClient,
    type: string,
    ms = 300
  ): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    expect(client.messages.filter((m) => m.type === type)).toEqual([]);
  }

  it('runs a full quiz lifecycle through all host actions and question types', async () => {
    const roomId = await seedQuizRoom();
    const host = await joinHost(roomId);
    const alice = await joinPlayer(roomId, 'Alice');
    const bob = await joinPlayer(roomId, 'Bob');

    // --- startQuiz → announce question 0
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'startQuiz' } });
    const announce = await host.waitFor('quizAnnounce');
    expect(announce.data).toMatchObject({
      questionIndex: 0,
      total: 3,
      type: 'trivia',
      trackName: 'Track One',
      trackArtist: 'Artist One',
      trackDbId: 111,
    });
    // Players get the same announce broadcast
    await alice.client.waitFor('quizAnnounce');
    let room = await getRoom(roomId);
    expect(room.pluginData.phase).toBe('announce');
    expect(room.pluginData.currentQuestionIndex).toBe(0);

    // Answers are ignored outside the question phase
    alice.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 0, answer: 'Paris' },
    });
    await expectNoMessage(alice.client, 'quizAnswerResult');

    // --- showQuestion
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'showQuestion' } });
    const q = await alice.client.waitFor('quizQuestion');
    expect(q.data).toMatchObject({
      questionIndex: 0,
      total: 3,
      type: 'trivia',
      question: 'Capital of France?',
      options: ['Paris', 'London', 'Berlin', 'Madrid'],
      timerSeconds: 20,
      imageFilename: null,
    });
    room = await getRoom(roomId);
    expect(room.pluginData.phase).toBe('question');
    expect(room.pluginData.questionStartedAt).toBeGreaterThan(0);

    // Stale question index is ignored
    alice.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 5, answer: 'Paris' },
    });
    await expectNoMessage(alice.client, 'quizAnswerResult', 200);

    // --- Alice answers correctly (MC scoring: kahoot speed formula)
    alice.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 0, answer: 'Paris' },
    });
    const aliceResult = await alice.client.waitFor('quizAnswerResult');
    expect(aliceResult.data.correct).toBe(true);
    expect(aliceResult.data.score).toBeGreaterThan(0);
    expect(aliceResult.data.score).toBeLessThanOrEqual(1000);
    expect(aliceResult.data.totalScore).toBe(aliceResult.data.score);
    const count1 = await host.waitFor('quizAnswerCount');
    expect(count1.data).toMatchObject({
      answeredCount: 1,
      totalPlayers: 2,
      answeredPlayerNames: ['Alice'],
    });
    // Not everyone answered yet
    await expectNoMessage(host, 'quizAllAnswered', 200);

    // --- Bob answers wrong: zero points
    clear(host);
    bob.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 0, answer: 'London' },
    });
    const bobResult = await bob.client.waitFor('quizAnswerResult');
    expect(bobResult.data).toMatchObject({ correct: false, score: 0, totalScore: 0 });
    const count2 = await host.waitFor('quizAnswerCount');
    expect(count2.data.answeredCount).toBe(2);
    expect(count2.data.answeredPlayerNames).toEqual(
      expect.arrayContaining(['Alice', 'Bob'])
    );
    // All players answered → host is told to auto-reveal
    await host.waitFor('quizAllAnswered');

    // Duplicate answer for the same question is rejected silently
    clear(alice.client);
    alice.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 0, answer: 'Berlin' },
    });
    await expectNoMessage(alice.client, 'quizAnswerResult', 200);
    room = await getRoom(roomId);
    expect(room.pluginData.answers[alice.connectionId].length).toBe(1);
    expect(room.pluginData.answers[alice.connectionId][0].answer).toBe('Paris');

    // --- showReveal: stop track + counts
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'showReveal' } });
    const stop = await host.waitFor('quizStopTrack');
    expect(stop.data.trackDbId).toBe(111);
    const reveal = await host.waitFor('quizReveal');
    expect(reveal.data).toMatchObject({
      correctAnswer: 'Paris',
      trackName: 'Track One',
      trackArtist: 'Artist One',
      trackYear: 1999,
      type: 'trivia',
      answerCounts: { Paris: 1, London: 1, Berlin: 0, Madrid: 0 },
    });
    // trivia has no closest guesses
    expect(reveal.data.closestGuesses).toBeUndefined();
    expect((await getRoom(roomId)).pluginData.phase).toBe('reveal');

    // --- showRanking: Alice leads with a 1-streak
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'showRanking' } });
    const ranking = await host.waitFor('quizRanking');
    expect(ranking.data.previousRankings).toEqual([]);
    expect(ranking.data.rankings.map((r: any) => r.name)).toEqual(['Alice', 'Bob']);
    expect(ranking.data.rankings[0]).toMatchObject({
      id: alice.connectionId,
      streak: 1,
      score: aliceResult.data.score,
    });
    expect(ranking.data.rankings[1]).toMatchObject({ score: 0, streak: 0 });
    room = await getRoom(roomId);
    expect(room.pluginData.phase).toBe('ranking');
    expect(room.pluginData.previousRankings.length).toBe(2);

    // --- nextQuestion → year question
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'nextQuestion' } });
    const announce2 = await host.waitFor('quizAnnounce');
    expect(announce2.data).toMatchObject({
      questionIndex: 1,
      type: 'year',
      trackDbId: 222,
    });
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'showQuestion' } });
    await alice.client.waitFor('quizQuestion');

    // Year proximity scoring: 3 years off scores 80% of 1000, speed-scaled
    // with a 0.8 floor → deterministic [640, 800], counted as not correct.
    alice.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 1, answer: '1993' },
    });
    const aliceYear = await alice.client.waitFor('quizAnswerResult');
    expect(aliceYear.data.correct).toBe(false);
    expect(aliceYear.data.score).toBeGreaterThanOrEqual(640);
    expect(aliceYear.data.score).toBeLessThanOrEqual(800);

    // Exact year: full proximity score, speed bonus floor 0.8 → [800, 1000].
    bob.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 1, answer: '1990' },
    });
    const bobYear = await bob.client.waitFor('quizAnswerResult');
    expect(bobYear.data.correct).toBe(true);
    expect(bobYear.data.score).toBeGreaterThanOrEqual(800);
    expect(bobYear.data.score).toBeLessThanOrEqual(1000);

    // Reveal for year questions includes closest guesses ordered by diff
    clear(host);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'showReveal' } });
    const reveal2 = await host.waitFor('quizReveal');
    expect(reveal2.data.closestGuesses.map((g: any) => g.name)).toEqual([
      'Bob',
      'Alice',
    ]);
    expect(reveal2.data.closestGuesses[0]).toMatchObject({ guess: 1990, diff: 0 });
    expect(reveal2.data.closestGuesses[1]).toMatchObject({ guess: 1993, diff: 3 });

    // --- nextQuestion → release_order question
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'nextQuestion' } });
    await host.waitFor('quizAnnounce');
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'showQuestion' } });
    const q3 = await alice.client.waitFor('quizQuestion');
    // release_order exposes the correct position as currentTrackIndex
    expect(q3.data.currentTrackIndex).toBe(1);

    alice.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 2, answer: '1' },
    });
    const aliceOrder = await alice.client.waitFor('quizAnswerResult');
    expect(aliceOrder.data.correct).toBe(true);
    expect(aliceOrder.data.score).toBeGreaterThan(0);

    bob.client.send({
      type: 'quizAnswer',
      data: { roomId, questionIndex: 2, answer: '0' },
    });
    const bobOrder = await bob.client.waitFor('quizAnswerResult');
    expect(bobOrder.data).toMatchObject({ correct: false, score: 0 });

    // release_order reveal maps position answers back to option labels
    clear(host);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'showReveal' } });
    const reveal3 = await host.waitFor('quizReveal');
    expect(reveal3.data.answerCounts).toEqual({
      'Song A': 1,
      'Song B': 1,
      'Song C': 0,
    });

    // --- nextQuestion past the last question → final screen + winner track
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'nextQuestion' } });
    const finalAnnounce = await host.waitFor('quizAnnounce');
    expect(finalAnnounce.data).toEqual({ trackDbId: 8701 });
    const final = await host.waitFor('quizFinal');
    expect(final.data.rankings.length).toBe(2);
    expect(final.data.rankings[0].score).toBeGreaterThanOrEqual(
      final.data.rankings[1].score
    );
    room = await getRoom(roomId);
    expect(room.pluginData.phase).toBe('final');

    // --- endQuiz
    clear(host, alice.client, bob.client);
    host.send({ type: 'quizHostAction', data: { roomId, action: 'endQuiz' } });
    await alice.client.waitFor('roomEnded');
    await host.waitFor('roomEnded');
    expect((await getRoom(roomId)).state).toBe('ended');
  }, 30000);

  describe('quizHostAction guards', () => {
    it('ignores host actions from non-host connections', async () => {
      const roomId = await seedQuizRoom();
      const host = await joinHost(roomId);
      const { client: player } = await joinPlayer(roomId, 'Mallory');
      clear(host, player);
      player.send({ type: 'quizHostAction', data: { roomId, action: 'startQuiz' } });
      await expectNoMessage(host, 'quizAnnounce');
      expect((await getRoom(roomId)).pluginData.phase).toBe('lobby');
    });

    it('addTime extends a running question by 10 seconds', async () => {
      const startedAt = Date.now();
      const roomId = await seedQuizRoom({
        phase: 'question',
        currentQuestionIndex: 0,
        questionStartedAt: startedAt,
      });
      const host = await joinHost(roomId);
      host.send({ type: 'quizHostAction', data: { roomId, action: 'addTime' } });
      const msg = await host.waitFor('quizAddTime');
      expect(msg.data).toEqual({ seconds: 10 });
      const room = await getRoom(roomId);
      expect(room.pluginData.timerSeconds).toBe(30);
      expect(room.pluginData.questionStartedAt).toBe(startedAt - 10000);
    });

    it('addTime does nothing outside the question phase', async () => {
      const roomId = await seedQuizRoom();
      const host = await joinHost(roomId);
      clear(host);
      host.send({ type: 'quizHostAction', data: { roomId, action: 'addTime' } });
      await expectNoMessage(host, 'quizAddTime');
      expect((await getRoom(roomId)).pluginData.timerSeconds).toBe(20);
    });

    it('restartTrack rebroadcasts the current track during a question', async () => {
      const roomId = await seedQuizRoom({
        phase: 'question',
        currentQuestionIndex: 0,
        questionStartedAt: Date.now(),
      });
      const host = await joinHost(roomId);
      host.send({ type: 'quizHostAction', data: { roomId, action: 'restartTrack' } });
      const msg = await host.waitFor('quizRestartTrack');
      expect(msg.data).toEqual({ trackDbId: 111 });
    });
  });

  describe('generic room handlers', () => {
    it('updatePluginData merges host changes and broadcasts to the room', async () => {
      const roomId = await seedQuizRoom();
      const host = await joinHost(roomId);
      const { client: player } = await joinPlayer(roomId, 'Pat');
      clear(host, player);

      host.send({
        type: 'updatePluginData',
        data: { roomId, pluginData: { timerSeconds: 45, customFlag: true } },
      });
      const change = await player.waitFor('pluginDataChanged');
      // Merge keeps existing keys and applies the patch
      expect(change.data.pluginData.timerSeconds).toBe(45);
      expect(change.data.pluginData.customFlag).toBe(true);
      expect(change.data.pluginData.quizName).toBe('Test Quiz');

      const room = await getRoom(roomId);
      expect(room.pluginData.timerSeconds).toBe(45);
      expect(room.pluginData.customFlag).toBe(true);
    });

    it('ignores updatePluginData from players', async () => {
      const roomId = await seedQuizRoom();
      const host = await joinHost(roomId);
      const { client: player } = await joinPlayer(roomId, 'Pat');
      clear(host, player);
      player.send({
        type: 'updatePluginData',
        data: { roomId, pluginData: { hacked: true } },
      });
      await expectNoMessage(host, 'pluginDataChanged');
      expect((await getRoom(roomId)).pluginData.hacked).toBeUndefined();
    });

    it('endRoom by the host ends the room and notifies everyone', async () => {
      const roomId = await seedQuizRoom();
      const host = await joinHost(roomId);
      const { client: player } = await joinPlayer(roomId, 'Pat');
      host.send({ type: 'endRoom', data: { roomId } });
      await player.waitFor('roomEnded');
      expect((await getRoom(roomId)).state).toBe('ended');
    });

    it('ignores endRoom from players', async () => {
      const roomId = await seedQuizRoom();
      const host = await joinHost(roomId);
      const { client: player } = await joinPlayer(roomId, 'Pat');
      clear(host);
      player.send({ type: 'endRoom', data: { roomId } });
      await expectNoMessage(host, 'roomEnded');
      expect((await getRoom(roomId)).state).toBe('created');
    });
  });

  describe('player rejoin', () => {
    it('rejects rejoin without roomId/playerName, into missing rooms and for unknown players', async () => {
      const client = await connect();
      await client.waitFor('connected');

      client.send({ type: 'quizRejoinPlayer', data: { roomId: 'x' } });
      let err = await client.waitFor('error');
      expect(err.data).toBe('roomId and playerName required');

      clear(client);
      client.send({
        type: 'quizRejoinPlayer',
        data: { roomId: randomUUID(), playerName: 'Ghost' },
      });
      err = await client.waitFor('error');
      expect(err.data).toBe('Room not found');

      const roomId = await seedQuizRoom();
      clear(client);
      client.send({
        type: 'quizRejoinPlayer',
        data: { roomId, playerName: 'Ghost' },
      });
      err = await client.waitFor('error');
      expect(err.data).toBe('Player not found in this room');
    });

    it('restores a player mid-question with score, remaining time and answer state', async () => {
      const roomId = await seedQuizRoom({
        phase: 'question',
        currentQuestionIndex: 0,
        questionStartedAt: Date.now() - 5000,
        players: {
          'old-conn': {
            name: 'Carol',
            score: 500,
            connected: false,
            avatar: 'dog',
            deviceId: 'dev-1',
          },
        },
        answers: {
          'old-conn': [
            { answer: 'Paris', answeredAt: Date.now() - 4000, score: 500, correct: true },
          ],
        },
      });

      const client = await connect();
      const connected = await client.waitFor('connected');
      client.send({
        type: 'quizRejoinPlayer',
        data: { roomId, playerName: 'Carol', deviceId: 'dev-2' },
      });
      const confirm = await client.waitFor('quizRejoinedConfirm');
      expect(confirm.data).toMatchObject({
        connectionId: connected.data.connectionId,
        playerName: 'Carol',
        phase: 'question',
        currentQuestionIndex: 0,
        totalQuestions: 3,
        totalScore: 500,
        type: 'trivia',
        question: 'Capital of France?',
        timerSeconds: 20,
        alreadyAnswered: true,
        lastAnswerCorrect: true,
        lastAnswerScore: 500,
      });
      expect(confirm.data.remainingSeconds).toBeGreaterThan(10);
      expect(confirm.data.remainingSeconds).toBeLessThanOrEqual(15);

      // Player state is remapped to the new connection id in Redis
      const room = await getRoom(roomId);
      expect(Object.keys(room.pluginData.players)).toEqual([
        connected.data.connectionId,
      ]);
      expect(room.pluginData.players[connected.data.connectionId]).toMatchObject({
        name: 'Carol',
        score: 500,
        connected: true,
        deviceId: 'dev-2',
      });
      expect(room.pluginData.answers[connected.data.connectionId].length).toBe(1);

      // Everyone is told the player is (back) in
      const joined = await client.waitFor('quizPlayerJoined');
      expect(joined.data.playerName).toBe('Carol');
      expect(joined.data.playerCount).toBe(1);
    });

    it('returns the final rankings when rejoining a finished quiz', async () => {
      const roomId = await seedQuizRoom({
        phase: 'final',
        currentQuestionIndex: 2,
        players: {
          a: { name: 'Winner', score: 2000, connected: false, avatar: '' },
          b: { name: 'Loser', score: 100, connected: false, avatar: '' },
        },
        answers: { a: [], b: [] },
      });
      const client = await connect();
      await client.waitFor('connected');
      client.send({
        type: 'quizRejoinPlayer',
        data: { roomId, playerName: 'Loser' },
      });
      const confirm = await client.waitFor('quizRejoinedConfirm');
      expect(confirm.data.phase).toBe('final');
      expect(confirm.data.rankings.map((r: any) => r.name)).toEqual([
        'Winner',
        'Loser',
      ]);
      expect(confirm.data.totalScore).toBe(100);
    });
  });

  describe('host rejoin', () => {
    it('requires a roomId and an existing quiz room', async () => {
      const client = await connect();
      await client.waitFor('connected');
      client.send({ type: 'quizRejoinHost', data: {} });
      let err = await client.waitFor('error');
      expect(err.data).toBe('roomId required');

      clear(client);
      client.send({ type: 'quizRejoinHost', data: { roomId: randomUUID() } });
      err = await client.waitFor('error');
      expect(err.data).toBe('Room not found');
    });

    it('returns a full reveal-phase snapshot with answer counts', async () => {
      const roomId = await seedQuizRoom({
        phase: 'reveal',
        currentQuestionIndex: 0,
        questionStartedAt: Date.now() - 10000,
        players: {
          p1: { name: 'Ann', score: 900, connected: true, avatar: 'cat' },
          p2: { name: 'Ben', score: 0, connected: false, avatar: '' },
        },
        answers: {
          p1: [{ answer: 'Paris', answeredAt: 0, score: 900, correct: true }],
          p2: [{ answer: 'Berlin', answeredAt: 0, score: 0, correct: false }],
        },
      });
      const client = await connect();
      await client.waitFor('connected');
      client.send({ type: 'quizRejoinHost', data: { roomId } });
      const confirm = await client.waitFor('quizHostRejoinedConfirm');
      expect(confirm.data).toMatchObject({
        phase: 'reveal',
        currentQuestionIndex: 0,
        totalQuestions: 3,
        quizName: 'Test Quiz',
        timerSeconds: 20,
        listeningSeconds: 10,
        hostAppConnected: false,
        playerCount: 1, // only connected players are counted
        correctAnswer: 'Paris',
        trackName: 'Track One',
        trackArtist: 'Artist One',
        trackYear: 1999,
        type: 'trivia',
        question: 'Capital of France?',
        answerCounts: { Paris: 1, London: 0, Berlin: 1, Madrid: 0 },
      });
      expect(confirm.data.players.length).toBe(2);
      expect(confirm.data.players.find((p: any) => p.name === 'Ben').connected).toBe(
        false
      );
    });

    it('returns remaining time and answered count mid-question', async () => {
      const roomId = await seedQuizRoom({
        phase: 'question',
        currentQuestionIndex: 0,
        questionStartedAt: Date.now() - 8000,
        players: {
          p1: { name: 'Ann', score: 0, connected: true, avatar: '' },
          p2: { name: 'Ben', score: 0, connected: true, avatar: '' },
        },
        answers: {
          p1: [{ answer: 'Paris', answeredAt: 0, score: 900, correct: true }],
          p2: [],
        },
      });
      const client = await connect();
      await client.waitFor('connected');
      client.send({ type: 'quizRejoinHost', data: { roomId } });
      const confirm = await client.waitFor('quizHostRejoinedConfirm');
      expect(confirm.data.phase).toBe('question');
      expect(confirm.data.answeredCount).toBe(1);
      expect(confirm.data.remainingSeconds).toBeGreaterThan(7);
      expect(confirm.data.remainingSeconds).toBeLessThanOrEqual(12);
      expect(confirm.data.options).toEqual(['Paris', 'London', 'Berlin', 'Madrid']);
    });

    it('returns rankings in the ranking phase', async () => {
      const roomId = await seedQuizRoom({
        phase: 'ranking',
        currentQuestionIndex: 0,
        previousRankings: [{ id: 'p1', name: 'Ann', score: 0, avatar: '' }],
        players: {
          p1: { name: 'Ann', score: 800, connected: true, avatar: '' },
        },
        answers: {
          p1: [{ answer: 'Paris', answeredAt: 0, score: 800, correct: true }],
        },
      });
      const client = await connect();
      await client.waitFor('connected');
      client.send({ type: 'quizRejoinHost', data: { roomId } });
      const confirm = await client.waitFor('quizHostRejoinedConfirm');
      expect(confirm.data.rankings).toEqual([
        { id: 'p1', name: 'Ann', score: 800, streak: 1, avatar: '' },
      ]);
      expect(confirm.data.previousRankings).toEqual([
        { id: 'p1', name: 'Ann', score: 0, avatar: '' },
      ]);
    });
  });

  describe('host app', () => {
    it('connects the host app, flags the room and notifies the host', async () => {
      const roomId = await seedQuizRoom();
      const host = await joinHost(roomId);

      const app = await connect();
      await app.waitFor('connected');
      app.send({ type: 'quizJoinHostApp', data: { roomId } });
      const confirm = await app.waitFor('quizHostAppConfirm');
      expect(confirm.data).toEqual({ roomId, quizName: 'Test Quiz' });
      await host.waitFor('quizHostAppConnected');
      expect((await getRoom(roomId)).pluginData.hostAppConnected).toBe(true);

      // Disconnecting the app clears the flag and notifies the room
      app.close();
      await host.waitFor('quizHostAppDisconnected');
      // The Redis write happens in a fire-and-forget .then — poll briefly.
      let flag = true;
      for (let i = 0; i < 20 && flag; i++) {
        await new Promise((r) => setTimeout(r, 50));
        flag = (await getRoom(roomId)).pluginData.hostAppConnected;
      }
      expect(flag).toBe(false);
    });

    it('rejects host app joins without roomId or into non-quiz rooms', async () => {
      const client = await connect();
      await client.waitFor('connected');
      client.send({ type: 'quizJoinHostApp', data: {} });
      let err = await client.waitFor('error');
      expect(err.data).toBe('roomId required');

      const uuid = randomUUID();
      await redis.set(
        `room:${uuid}`,
        JSON.stringify({ uuid, type: 'bingo', state: 'created', pluginData: {} }),
        'EX',
        300
      );
      clear(client);
      client.send({ type: 'quizJoinHostApp', data: { roomId: uuid } });
      err = await client.waitFor('error');
      expect(err.data).toBe('Not a quiz room');
    });
  });

  describe('heartbeat', () => {
    it('terminates dead connections and keeps responsive ones alive', async () => {
      const roomId = await seedQuizRoom();
      const host = await joinHost(roomId);
      const { client: player, connectionId } = await joinPlayer(roomId, 'Sleepy');
      clear(host);

      const internals = server.wsServer as any;
      const playerConn = internals.connections.get(connectionId);
      expect(playerConn).toBeTruthy();

      // Simulate a missed pong, then fire the real heartbeat tick.
      playerConn.isAlive = false;
      const closed = new Promise<void>((resolve) =>
        player.ws.once('close', () => resolve())
      );
      (internals.heartbeatInterval as any)._onTimeout();

      await closed;
      expect(internals.connections.has(connectionId)).toBe(false);

      // The quiz room is told the player dropped
      const gone = await host.waitFor('quizPlayerDisconnected');
      expect(gone.data.playerName).toBe('Sleepy');
      expect((await getRoom(roomId)).pluginData.players[connectionId].connected).toBe(
        false
      );

      // The host was pinged (isAlive flipped false) and its pong restores it.
      const hostConn = [...internals.connections.values()].find(
        (c: any) => c.roomId === roomId && c.isHost
      ) as any;
      expect(hostConn).toBeTruthy();
      for (let i = 0; i < 20 && !hostConn.isAlive; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(hostConn.isAlive).toBe(true);
      expect(host.ws.readyState).toBe(host.ws.OPEN);
    });
  });
});
