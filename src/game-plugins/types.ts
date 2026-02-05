/**
 * Game Plugin System Types
 *
 * Plugins register handlers for specific QRSSM message types.
 * The game router dispatches messages to the appropriate plugin.
 */

// Room state - generic base that plugins can extend
export interface BaseRoomState {
  id: number;
  uuid: string;
  type: string;
  userId: number;
  state: 'created' | 'active' | 'ended';
  lastActivity: number;
  // Plugin-specific data stored here (game-type-specific fields go here)
  pluginData: Record<string, any>;
}

// Response from message handlers
export interface MessageResponse {
  success: boolean;
  action?: string;
  storeRoomId?: string;
  data?: any;
  error?: string;
  // Optional: broadcast this event to WebSocket room
  broadcast?: {
    type: string;
    data: any;
  };
}

// Context passed to message handlers
export interface MessageContext {
  roomId?: string;
  room?: BaseRoomState;
  userId?: number;
  // Function to update room state
  updateRoom: (room: BaseRoomState) => Promise<void>;
  // Function to broadcast to room via WebSocket
  broadcastToRoom: (roomId: string, type: string, data: any) => Promise<void>;
}

// Message handler function signature
export type MessageHandler = (
  data: string,
  context: MessageContext
) => Promise<MessageResponse>;

// Plugin interface
export interface GamePlugin {
  // Plugin identifier (e.g., 'bingo')
  id: string;

  // Room type this plugin handles
  roomType: string;

  // Message types this plugin handles (e.g., ['BC'] for Bingo Check)
  messageTypes: string[];

  // Initialize plugin (called once at startup)
  initialize?: () => Promise<void>;

  // Handle a message
  handleMessage: (
    messageType: string,
    data: string,
    context: MessageContext
  ) => Promise<MessageResponse>;

  // Get default plugin data for a new room
  getDefaultPluginData: () => Record<string, any>;

  // Validate room-specific actions (optional)
  validateRoomAction?: (
    action: string,
    room: BaseRoomState,
    data: any
  ) => boolean;
}

// Plugin registry
export class GamePluginRegistry {
  private static plugins: Map<string, GamePlugin> = new Map();
  private static messageTypeToPlugin: Map<string, GamePlugin> = new Map();

  static register(plugin: GamePlugin): void {
    this.plugins.set(plugin.id, plugin);

    // Map message types to this plugin
    for (const messageType of plugin.messageTypes) {
      this.messageTypeToPlugin.set(messageType, plugin);
    }
  }

  static getPlugin(id: string): GamePlugin | undefined {
    return this.plugins.get(id);
  }

  static getPluginForMessageType(messageType: string): GamePlugin | undefined {
    return this.messageTypeToPlugin.get(messageType);
  }

  static getPluginForRoomType(roomType: string): GamePlugin | undefined {
    for (const plugin of this.plugins.values()) {
      if (plugin.roomType === roomType) {
        return plugin;
      }
    }
    return undefined;
  }

  static getAllPlugins(): GamePlugin[] {
    return Array.from(this.plugins.values());
  }
}
