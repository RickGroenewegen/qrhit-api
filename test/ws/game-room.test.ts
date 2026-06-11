import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import {
  startTestWsServer,
  startBareWsServer,
  WsTestClient,
  TestWsServer,
} from '../helpers/wsServer';

/**
 * Live game-room protocol tests against the real NativeWebSocketServer.
 * Room state lives in Redis db 1 (hardcoded in production code, matching
 * gameRoutes) — rooms here use throwaway UUID keys with a short TTL.
 */
describe('game room websockets', () => {
  let server: TestWsServer;
  let redis: Redis;
  const clients: WsTestClient[] = [];

  beforeAll(async () => {
    server = await startTestWsServer();
    redis = new Redis(process.env['REDIS_URL']!, { db: 1 });
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

  async function seedQuizRoom(
    overrides: Record<string, unknown> = {}
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
        totalQuestions: 3,
        trackMapping: {},
        ...overrides,
      },
    };
    await redis.set(`room:${uuid}`, JSON.stringify(roomState), 'EX', 300);
    return uuid;
  }

  it('acknowledges new connections with a connectionId', async () => {
    const client = await connect();
    const msg = await client.waitFor('connected');
    expect(msg.data.connectionId).toBeTruthy();
  });

  it('answers ping with pong', async () => {
    const client = await connect();
    await client.waitFor('connected');
    client.send({ type: 'ping' });
    await client.waitFor('pong');
  });

  it('rejects malformed JSON with an error frame', async () => {
    const client = await connect();
    await client.waitFor('connected');
    client.send('this is not json');
    const err = await client.waitFor('error');
    expect(err.data).toBe('Invalid message format');
  });

  it('rejects joining an unknown room', async () => {
    const client = await connect();
    await client.waitFor('connected');
    client.send({ type: 'joinRoom', data: { roomId: 'nope', isHost: true } });
    const err = await client.waitFor('error');
    expect(err.data).toBe('Room not found');
  });

  it('lets a host join a room and receive the room state', async () => {
    const roomId = await seedQuizRoom();
    const host = await connect();
    await host.waitFor('connected');
    host.send({ type: 'joinRoom', data: { roomId, isHost: true } });
    const joined = await host.waitFor('roomJoined');
    expect(joined.data.roomId).toBe(roomId);
    expect(joined.data.type).toBe('quiz');
    expect(joined.data.pluginData.phase).toBe('lobby');
  });

  describe('quiz player joins', () => {
    it('requires roomId and playerName', async () => {
      const client = await connect();
      await client.waitFor('connected');
      client.send({ type: 'quizJoinPlayer', data: { roomId: 'x' } });
      const err = await client.waitFor('error');
      expect(err.data).toBe('roomId and playerName required');
    });

    it('confirms the join and broadcasts the lobby to everyone', async () => {
      const roomId = await seedQuizRoom();

      const host = await connect();
      await host.waitFor('connected');
      host.send({ type: 'joinRoom', data: { roomId, isHost: true } });
      await host.waitFor('roomJoined');

      const player = await connect();
      await player.waitFor('connected');
      player.send({
        type: 'quizJoinPlayer',
        data: { roomId, playerName: 'Alice', avatar: 'cat' },
      });

      const confirm = await player.waitFor('quizJoinedConfirm');
      expect(confirm.data.playerName).toBe('Alice');
      expect(confirm.data.connectionId).toBeTruthy();

      const lobby = await host.waitFor('quizPlayerJoined');
      expect(lobby.data.playerCount).toBe(1);
      expect(lobby.data.players[0].name).toBe('Alice');

      // Player is persisted in the Redis room state
      const room = JSON.parse((await redis.get(`room:${roomId}`))!);
      const names = Object.values(room.pluginData.players).map(
        (p: any) => p.name
      );
      expect(names).toEqual(['Alice']);
    });

    it('replaces a player rejoining with the same name instead of duplicating', async () => {
      const roomId = await seedQuizRoom();

      const first = await connect();
      await first.waitFor('connected');
      first.send({
        type: 'quizJoinPlayer',
        data: { roomId, playerName: 'Bob' },
      });
      await first.waitFor('quizJoinedConfirm');

      const second = await connect();
      await second.waitFor('connected');
      second.send({
        type: 'quizJoinPlayer',
        data: { roomId, playerName: 'Bob' },
      });
      const joined = await second.waitFor('quizPlayerJoined');
      expect(joined.data.playerCount).toBe(1);

      const room = JSON.parse((await redis.get(`room:${roomId}`))!);
      expect(Object.keys(room.pluginData.players).length).toBe(1);
    });

    it('rejects joining once the quiz has started', async () => {
      const roomId = await seedQuizRoom({ phase: 'question' });
      const client = await connect();
      await client.waitFor('connected');
      client.send({
        type: 'quizJoinPlayer',
        data: { roomId, playerName: 'Late' },
      });
      const err = await client.waitFor('error');
      expect(err.data).toBe('Quiz already started');
    });

    it('rejects quiz joins to non-quiz rooms', async () => {
      const uuid = randomUUID();
      await redis.set(
        `room:${uuid}`,
        JSON.stringify({
          uuid,
          type: 'bingo',
          state: 'created',
          pluginData: { players: {}, answers: {} },
        }),
        'EX',
        300
      );
      const client = await connect();
      await client.waitFor('connected');
      client.send({
        type: 'quizJoinPlayer',
        data: { roomId: uuid, playerName: 'X' },
      });
      const err = await client.waitFor('error');
      expect(err.data).toBe('Not a quiz room');
    });
  });

  it('fans broadcasts out to clients on other servers via Redis pub/sub', async () => {
    const other = await startBareWsServer();
    try {
      const roomId = await seedQuizRoom();

      // Host listens on server B (bare instance, shared Redis).
      const host = new WsTestClient(other.port);
      clients.push(host);
      await host.opened();
      await host.waitFor('connected');
      host.send({ type: 'joinRoom', data: { roomId, isHost: true } });
      await host.waitFor('roomJoined');

      // Player joins on server A — quizPlayerJoined must reach server B.
      const player = await connect();
      await player.waitFor('connected');
      player.send({
        type: 'quizJoinPlayer',
        data: { roomId, playerName: 'CrossServer' },
      });
      await player.waitFor('quizJoinedConfirm');

      const lobby = await host.waitFor('quizPlayerJoined');
      expect(lobby.data.players[0].name).toBe('CrossServer');
    } finally {
      await other.close();
    }
  });

  it('marks a quiz player disconnected and notifies the room on close', async () => {
    const roomId = await seedQuizRoom();

    const host = await connect();
    await host.waitFor('connected');
    host.send({ type: 'joinRoom', data: { roomId, isHost: true } });
    await host.waitFor('roomJoined');

    const player = await connect();
    await player.waitFor('connected');
    player.send({
      type: 'quizJoinPlayer',
      data: { roomId, playerName: 'Quitter' },
    });
    await player.waitFor('quizJoinedConfirm');
    await host.waitFor('quizPlayerJoined');

    player.close();
    const gone = await host.waitFor('quizPlayerDisconnected');
    expect(gone.data.playerName).toBe('Quitter');

    const room = JSON.parse((await redis.get(`room:${roomId}`))!);
    const quitter: any = Object.values(room.pluginData.players)[0];
    expect(quitter.connected).toBe(false);
  });
});
