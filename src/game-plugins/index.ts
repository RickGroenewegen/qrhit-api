/**
 * Game Plugins Index
 *
 * Register all game plugins here.
 */

import { GamePluginRegistry } from './types';
import BingoPlugin from './bingo';

// Register all plugins
export function registerGamePlugins(): void {
  GamePluginRegistry.register(BingoPlugin);
}

// Export types and registry
export { GamePluginRegistry, type GamePlugin, type BaseRoomState, type MessageResponse, type MessageContext } from './types';
export { BingoPlugin } from './bingo';
