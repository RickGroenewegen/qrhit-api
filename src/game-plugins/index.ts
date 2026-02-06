/**
 * Game Plugins Index
 *
 * Register all game plugins here.
 */

import { GamePluginRegistry } from './types';
import BingoPlugin from './bingo';
import QuizPlugin from './quiz';

// Register all plugins
export function registerGamePlugins(): void {
  GamePluginRegistry.register(BingoPlugin);
  GamePluginRegistry.register(QuizPlugin);
}

// Export types and registry
export { GamePluginRegistry, type GamePlugin, type BaseRoomState, type MessageResponse, type MessageContext } from './types';
export { BingoPlugin } from './bingo';
export { QuizPlugin } from './quiz';
