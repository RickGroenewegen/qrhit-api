/**
 * Timeline Game Plugin
 *
 * Minimal plugin for the Music Timeline game.
 * The game runs entirely client-side - this plugin only enables
 * room creation for the 'timeline' room type.
 */

import { GamePlugin, MessageResponse, MessageContext } from './types';
import Logger from '../logger';
import { color } from 'console-log-colors';

const logger = new Logger();

export const TimelinePlugin: GamePlugin = {
  id: 'timeline',
  roomType: 'timeline',
  messageTypes: [],

  async initialize(): Promise<void> {
    logger.logDev(color.green.bold('[Timeline Plugin] Initialized'));
  },

  getDefaultPluginData(): Record<string, any> {
    return {
      paymentHasPlaylistId: null,
    };
  },

  async handleMessage(
    messageType: string,
    _data: string,
    _context: MessageContext
  ): Promise<MessageResponse> {
    return { success: false, error: `Unknown message type for timeline: ${messageType}` };
  },
};

export default TimelinePlugin;
