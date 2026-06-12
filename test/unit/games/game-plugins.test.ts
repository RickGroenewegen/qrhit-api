import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the game plugin system: registry dispatch and the
 * bingo win-checking logic in src/game-plugins/bingo.ts. The Bingo
 * singleton drags in prisma/cache/pdf, which are mocked; the QR parsing
 * used by the win checker is the real implementation.
 */

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => ({}) },
}));

vi.mock('../../../src/cache', () => ({
  default: { getInstance: () => ({}) },
}));

vi.mock('../../../src/pdf', () => ({
  default: class {},
}));

import {
  registerGamePlugins,
  GamePluginRegistry,
  BingoPlugin,
  QuizPlugin,
  TimelinePlugin,
} from '../../../src/game-plugins';
import { BaseRoomState, MessageContext } from '../../../src/game-plugins/types';

registerGamePlugins();

function makeRoom(overrides: Partial<BaseRoomState> = {}): BaseRoomState {
  return {
    id: 1,
    uuid: 'room-uuid',
    type: 'bingo',
    userId: 9,
    state: 'active',
    lastActivity: Date.now(),
    pluginData: { gameMode: 'HORIZONTAL', playedTrackIds: [] },
    ...overrides,
  };
}

function makeContext(room: BaseRoomState | undefined, roomId = 'room-1'): MessageContext {
  return {
    roomId: room ? roomId : undefined,
    room,
    userId: 9,
    updateRoom: vi.fn(async () => undefined),
    broadcastToRoom: vi.fn(async () => undefined),
  };
}

/**
 * Card payload where position p holds bingo number p+1 for p<12 and p for
 * p>12 (position 12 is the free space). 24 numbers total: 1..11,13..24.
 */
const CARD_NUMBERS = Array.from({ length: 25 }, (_, p) => p)
  .filter((p) => p !== 12)
  .map((p) => (p < 12 ? p + 1 : p));
const CARD = `R1S1:${CARD_NUMBERS.join(',')}`;

const numberAt = (pos: number) => (pos < 12 ? pos + 1 : pos);

async function check(
  played: (number | string)[],
  gameMode?: string,
  card: string = CARD
) {
  const room = makeRoom({
    pluginData: { gameMode, playedTrackIds: played },
  });
  return BingoPlugin.handleMessage('BC', card, makeContext(room));
}

describe('GamePluginRegistry', () => {
  it('registers all three plugins', () => {
    expect(GamePluginRegistry.getAllPlugins().map((p) => p.id).sort()).toEqual([
      'bingo',
      'quiz',
      'timeline',
    ]);
  });

  it('resolves plugins by id, room type and message type', () => {
    expect(GamePluginRegistry.getPlugin('bingo')).toBe(BingoPlugin);
    expect(GamePluginRegistry.getPlugin('nope')).toBeUndefined();
    expect(GamePluginRegistry.getPluginForRoomType('quiz')).toBe(QuizPlugin);
    expect(GamePluginRegistry.getPluginForRoomType('poker')).toBeUndefined();
    expect(GamePluginRegistry.getPluginForMessageType('BC')).toBe(BingoPlugin);
    expect(GamePluginRegistry.getPluginForMessageType('ZZ')).toBeUndefined();
  });

  it('initializes plugins without error', async () => {
    await expect(BingoPlugin.initialize!()).resolves.toBeUndefined();
    await expect(QuizPlugin.initialize!()).resolves.toBeUndefined();
    await expect(TimelinePlugin.initialize!()).resolves.toBeUndefined();
  });
});

describe('BingoPlugin.handleMessage guards', () => {
  it('requires a room context', async () => {
    const result = await BingoPlugin.handleMessage('BC', CARD, makeContext(undefined));
    expect(result).toEqual({
      success: false,
      error: 'No room context - scan room QR first',
    });
  });

  it('rejects non-bingo rooms', async () => {
    const room = makeRoom({ type: 'quiz' });
    const result = await BingoPlugin.handleMessage('BC', CARD, makeContext(room));
    expect(result).toEqual({ success: false, error: 'Not a bingo room' });
  });

  it('rejects malformed card payloads', async () => {
    const result = await BingoPlugin.handleMessage(
      'BC',
      'R1S1:1,2,3',
      makeContext(makeRoom())
    );
    expect(result).toEqual({
      success: false,
      error: 'Invalid bingo card QR format',
    });
  });

  it('rejects unknown message types', async () => {
    const result = await BingoPlugin.handleMessage('XX', CARD, makeContext(makeRoom()));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown message type for bingo: XX');
  });
});

describe('BingoPlugin win checking', () => {
  it('detects a horizontal win on the top row', async () => {
    const result = await check([1, 2, 3, 4, 5], 'HORIZONTAL');
    expect(result.success).toBe(true);
    expect(result.action).toBe('bingoResult');
    expect(result.data).toMatchObject({
      isWinner: true,
      winningPositions: [0, 1, 2, 3, 4],
      matchedCount: 6, // 5 matches + free space
      totalPositions: 25,
      round: 1,
      sheet: 1,
    });
    expect(result.broadcast).toEqual({ type: 'bingoCheck', data: result.data });
  });

  it('uses the free space for the middle row (only 4 numbers needed)', async () => {
    const played = [10, 11, 13, 14].map(numberAt);
    const result = await check(played, 'HORIZONTAL');
    expect(result.data.isWinner).toBe(true);
    expect(result.data.winningPositions).toEqual([10, 11, 12, 13, 14]);
  });

  it('does not count a column as a horizontal win', async () => {
    const column = [2, 7, 17, 22].map(numberAt); // col 2, free space at 12
    const result = await check(column, 'HORIZONTAL');
    expect(result.data.isWinner).toBe(false);
    expect(result.data.winningPositions).toBeUndefined();
    expect(result.data.matchedCount).toBe(5);
  });

  it('detects vertical wins in VERTICAL mode', async () => {
    const column = [2, 7, 17, 22].map(numberAt);
    const result = await check(column, 'VERTICAL');
    expect(result.data.isWinner).toBe(true);
    expect(result.data.winningPositions).toEqual([2, 7, 12, 17, 22]);
  });

  it('detects both diagonals in DIAGONAL mode', async () => {
    const diag1 = [0, 6, 18, 24].map(numberAt);
    const first = await check(diag1, 'DIAGONAL');
    expect(first.data.isWinner).toBe(true);
    expect(first.data.winningPositions).toEqual([0, 6, 12, 18, 24]);

    const diag2 = [4, 8, 16, 20].map(numberAt);
    const second = await check(diag2, 'DIAGONAL');
    expect(second.data.isWinner).toBe(true);
    expect(second.data.winningPositions).toEqual([4, 8, 12, 16, 20]);

    const row = [1, 2, 3, 4, 5];
    const miss = await check(row, 'DIAGONAL');
    expect(miss.data.isWinner).toBe(false);
  });

  it('requires every cell for FULL_CARD', async () => {
    const all = CARD_NUMBERS;
    const win = await check(all, 'FULL_CARD');
    expect(win.data.isWinner).toBe(true);
    expect(win.data.winningPositions).toHaveLength(25);
    expect(win.data.matchedCount).toBe(25);

    const almost = CARD_NUMBERS.slice(0, 23);
    const miss = await check(almost, 'FULL_CARD');
    expect(miss.data.isWinner).toBe(false);
  });

  it('only matches numbers that are actually on the card', async () => {
    const result = await check([100, 101, 102, 103, 104], 'HORIZONTAL');
    expect(result.data.isWinner).toBe(false);
    expect(result.data.matchedCount).toBe(1); // free space only
  });

  it('coerces string playedTrackIds before matching (Redis round-trip safety)', async () => {
    const result = await check(['1', '2', '3', '4', '5'], 'HORIZONTAL');
    expect(result.data.isWinner).toBe(true);
  });

  it('falls back to HORIZONTAL when no game mode is set', async () => {
    const result = await check([1, 2, 3, 4, 5], undefined);
    expect(result.data.isWinner).toBe(true);
    expect(result.data.winningPositions).toEqual([0, 1, 2, 3, 4]);
    // Suspected inconsistency: the win check falls back to HORIZONTAL but
    // the echoed gameMode stays undefined instead of the effective mode.
    expect(result.data.gameMode).toBeUndefined();
  });
});

describe('BingoPlugin.validateRoomAction', () => {
  it('validates updateGameMode against the known modes', () => {
    const room = makeRoom();
    expect(
      BingoPlugin.validateRoomAction!('updateGameMode', room, { gameMode: 'DIAGONAL' })
    ).toBe(true);
    expect(
      BingoPlugin.validateRoomAction!('updateGameMode', room, { gameMode: 'SPIRAL' })
    ).toBe(false);
  });

  it('allows other actions by default', () => {
    expect(BingoPlugin.validateRoomAction!('anything', makeRoom(), {})).toBe(true);
  });

  it('starts new rooms in HORIZONTAL mode with no played tracks', () => {
    expect(BingoPlugin.getDefaultPluginData()).toEqual({
      gameMode: 'HORIZONTAL',
      playedTrackIds: [],
    });
  });
});

describe('QuizPlugin', () => {
  it('provides lobby defaults for new rooms', () => {
    expect(QuizPlugin.getDefaultPluginData()).toEqual({
      quizId: 0,
      quizCacheKey: '',
      currentQuestionIndex: -1,
      phase: 'lobby',
      players: {},
      answers: {},
      timerSeconds: 20,
      listeningSeconds: 8,
      questionStartedAt: null,
      totalQuestions: 0,
    });
  });

  it('declines QRSSM messages entirely', async () => {
    const result = await QuizPlugin.handleMessage('TS', 'x', makeContext(makeRoom()));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Quiz does not handle QRSSM message type: TS');
    expect(QuizPlugin.messageTypes).toEqual([]);
  });

  it('whitelists quiz room actions', () => {
    const room = makeRoom({ type: 'quiz' });
    for (const action of [
      'startQuiz',
      'showQuestion',
      'showReveal',
      'showRanking',
      'nextScan',
      'endQuiz',
      'updateSettings',
    ]) {
      expect(QuizPlugin.validateRoomAction!(action, room, {})).toBe(true);
    }
    expect(QuizPlugin.validateRoomAction!('deleteEverything', room, {})).toBe(false);
  });
});

describe('TimelinePlugin', () => {
  it('runs client-side: no message types, minimal defaults', async () => {
    expect(TimelinePlugin.messageTypes).toEqual([]);
    expect(TimelinePlugin.getDefaultPluginData()).toEqual({
      paymentHasPlaylistId: null,
    });
    const result = await TimelinePlugin.handleMessage('BC', 'x', makeContext(makeRoom()));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown message type for timeline');
  });
});
