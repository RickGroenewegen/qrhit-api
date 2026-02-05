/**
 * Bingo Game Plugin
 *
 * Handles bingo-specific QRSSM messages:
 * - BC: Bingo Check (verify if a card is a winner)
 */

import { GamePlugin, MessageResponse, MessageContext, BaseRoomState } from './types';
import Bingo from '../bingo';
import Logger from '../logger';
import { color, white } from 'console-log-colors';

// Bingo-specific room data
type GameMode = 'HORIZONTAL' | 'VERTICAL' | 'DIAGONAL' | 'FULL_CARD';

interface BingoPluginData {
  gameMode: GameMode;
  playedTrackIds: number[];
}

// Type guard for bingo room data
function getBingoData(room: BaseRoomState): BingoPluginData {
  return room.pluginData as BingoPluginData;
}

const logger = new Logger();
const bingo = Bingo.getInstance();

// Handle BC (Bingo Check) message
async function handleBingoCheck(data: string, context: MessageContext): Promise<MessageResponse> {
  const { roomId, room } = context;

  if (!roomId || !room) {
    return { success: false, error: 'No room context - scan room QR first' };
  }

  if (room.type !== 'bingo') {
    return { success: false, error: 'Not a bingo room' };
  }

  const bingoData = getBingoData(room);

  // Parse the bingo card QR data using existing bingo parser
  // Format: R{round}S{sheet}:{num1,num2,...,num24}
  const parsed = bingo.parseQRData(`BINGO:${data}`);
  if (!parsed) {
    return { success: false, error: 'Invalid bingo card QR format' };
  }

  // Debug: log the data types and values
  const firstFiveCardNums = Array.from(parsed.positions.values()).slice(0, 5);
  logger.logDev(color.blue.bold(`[BC Debug] playedTrackIds: [${bingoData.playedTrackIds.join(', ')}] (type: ${typeof bingoData.playedTrackIds[0]})`));
  logger.logDev(color.blue.bold(`[BC Debug] card first 5 nums: [${firstFiveCardNums.join(', ')}] (type: ${typeof firstFiveCardNums[0]})`));

  // Check which positions have been played
  // Ensure we compare numbers to numbers (playedTrackIds are bingo numbers)
  const playedSet = new Set(bingoData.playedTrackIds.map(n => Number(n)));
  const matchedPositions: number[] = [];

  parsed.positions.forEach((bingoNumber, position) => {
    if (playedSet.has(Number(bingoNumber))) {
      matchedPositions.push(position);
    }
  });

  // Check win conditions based on game mode
  // Center position (12) is free space
  const grid = Array(25).fill(false);
  grid[12] = true; // Free space
  matchedPositions.forEach((pos) => {
    grid[pos] = true;
  });

  let isWinner = false;
  let winningPositions: number[] = [];

  const checkLine = (positions: number[]): boolean => {
    return positions.every((pos) => grid[pos]);
  };

  const gameMode = bingoData.gameMode || 'HORIZONTAL';

  switch (gameMode) {
    case 'HORIZONTAL':
      for (let row = 0; row < 5; row++) {
        const rowPositions = [0, 1, 2, 3, 4].map((col) => row * 5 + col);
        if (checkLine(rowPositions)) {
          isWinner = true;
          winningPositions = rowPositions;
          break;
        }
      }
      break;

    case 'VERTICAL':
      for (let col = 0; col < 5; col++) {
        const colPositions = [0, 1, 2, 3, 4].map((row) => row * 5 + col);
        if (checkLine(colPositions)) {
          isWinner = true;
          winningPositions = colPositions;
          break;
        }
      }
      break;

    case 'DIAGONAL':
      const diag1 = [0, 6, 12, 18, 24];
      const diag2 = [4, 8, 12, 16, 20];
      if (checkLine(diag1)) {
        isWinner = true;
        winningPositions = diag1;
      } else if (checkLine(diag2)) {
        isWinner = true;
        winningPositions = diag2;
      }
      break;

    case 'FULL_CARD':
      if (grid.every((filled) => filled)) {
        isWinner = true;
        winningPositions = Array.from({ length: 25 }, (_, i) => i);
      }
      break;
  }

  const result = {
    isWinner,
    matchedCount: matchedPositions.length + 1, // +1 for free space
    totalPositions: 25,
    gameMode: bingoData.gameMode,
    winningPositions: isWinner ? winningPositions : undefined,
    round: parsed.round,
    sheet: parsed.sheet,
  };

  logger.logDev(
    color.blue.bold(
      `[Bingo Check] Room ${white.bold(roomId)}: ${
        isWinner
          ? color.green.bold('WINNER!')
          : color.yellow.bold(`${matchedPositions.length + 1}/25 matched`)
      }`
    )
  );

  return {
    success: true,
    action: 'bingoResult',
    data: result,
    broadcast: {
      type: 'bingoCheck',
      data: result,
    },
  };
}

export const BingoPlugin: GamePlugin = {
  id: 'bingo',
  roomType: 'bingo',
  messageTypes: ['BC'],

  async initialize(): Promise<void> {
    logger.logDev(color.green.bold('[Bingo Plugin] Initialized'));
  },

  getDefaultPluginData(): BingoPluginData {
    return {
      gameMode: 'HORIZONTAL',
      playedTrackIds: [],
    };
  },

  async handleMessage(
    messageType: string,
    data: string,
    context: MessageContext
  ): Promise<MessageResponse> {
    switch (messageType) {
      case 'BC':
        return handleBingoCheck(data, context);
      default:
        return { success: false, error: `Unknown message type for bingo: ${messageType}` };
    }
  },

  validateRoomAction(action: string, _room: BaseRoomState, data: any): boolean {
    // Validate bingo-specific actions
    if (action === 'updateGameMode') {
      const validModes: GameMode[] = ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FULL_CARD'];
      return validModes.includes(data.gameMode);
    }
    return true;
  },
};

export default BingoPlugin;
