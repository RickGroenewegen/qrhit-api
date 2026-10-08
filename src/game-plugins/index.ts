/**
 * Game Plugins Index
 *
 * Register all game plugins here.
 */

import { GamePluginRegistry } from './types';
import BingoPlugin from './bingo';
import QuizPlugin from './quiz';
import TimelinePlugin from './timeline';

// Register all plugins
export function registerGamePlugins(): void {
  GamePluginRegistry.register(BingoPlugin);
  GamePluginRegistry.register(QuizPlugin);
  GamePluginRegistry.register(TimelinePlugin);
}

// Export types and registry
export { GamePluginRegistry, type BaseRoomState, type MessageContext } from './types';
