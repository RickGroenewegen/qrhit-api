/**
 * Quiz Game Plugin
 *
 * Handles quiz-specific game logic.
 * Quiz uses WebSocket messages for gameplay, not QRSSM message types.
 * The TS (Track Scanned) handler in gameRoutes.ts is extended for quiz rooms.
 */

import { GamePlugin, MessageResponse, MessageContext, BaseRoomState } from './types';
import Logger from '../logger';
import { color } from 'console-log-colors';

// Quiz-specific room data
interface QuizPluginData {
  quizId: number;
  quizCacheKey: string;
  currentQuestionIndex: number;
  phase: 'lobby' | 'scanning' | 'listening' | 'question' | 'reveal' | 'ranking' | 'final';
  players: Record<string, { name: string; score: number; connected: boolean }>;
  answers: Record<string, Array<{ answer: string; answeredAt: number; score: number; correct: boolean }>>;
  timerSeconds: number;
  listeningSeconds: number;
  questionStartedAt: number | null;
  totalQuestions: number;
}

// Type guard for quiz room data
export function getQuizData(room: BaseRoomState): QuizPluginData {
  return room.pluginData as QuizPluginData;
}

const logger = new Logger();

export const QuizPlugin: GamePlugin = {
  id: 'quiz',
  roomType: 'quiz',
  messageTypes: [], // Quiz uses WebSocket messages, not QRSSM

  async initialize(): Promise<void> {
    logger.logDev(color.green.bold('[Quiz Plugin] Initialized'));
  },

  getDefaultPluginData(): QuizPluginData {
    return {
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
    };
  },

  async handleMessage(
    messageType: string,
    _data: string,
    _context: MessageContext
  ): Promise<MessageResponse> {
    // Quiz doesn't use QRSSM message types
    return { success: false, error: `Quiz does not handle QRSSM message type: ${messageType}` };
  },

  validateRoomAction(action: string, _room: BaseRoomState, _data: any): boolean {
    const validActions = [
      'startQuiz', 'showQuestion', 'showReveal', 'showRanking',
      'nextScan', 'endQuiz', 'updateSettings',
    ];
    return validActions.includes(action);
  },
};

export default QuizPlugin;
