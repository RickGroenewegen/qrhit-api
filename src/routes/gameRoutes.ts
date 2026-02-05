import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import { color, white } from 'console-log-colors';
import {
  registerGamePlugins,
  GamePluginRegistry,
  BaseRoomState,
  MessageContext,
} from '../game-plugins';

// Redis client for game rooms (separate from cache)
let redis: Redis | null = null;
let pubClient: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    redis = new Redis(redisUrl, { db: 1 }); // Use DB 1 for game rooms
  }
  return redis;
}

function getPubClient(): Redis {
  if (!pubClient) {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    pubClient = new Redis(redisUrl, { db: 1 });
  }
  return pubClient;
}

// Room TTL: 4 hours
const ROOM_TTL_SECONDS = 4 * 60 * 60;

// System message response
interface SystemMessageResponse {
  success: boolean;
  action?: string;
  storeRoomId?: string;
  data?: any;
  error?: string;
}

const gameRoutes = async (fastify: FastifyInstance, getAuthHandler?: any) => {
  const prisma = PrismaInstance.getInstance();
  const logger = new Logger();

  // Register all game plugins on startup
  registerGamePlugins();
  logger.log(
    color.blue.bold(
      `[Game Routes] Registered ${GamePluginRegistry.getAllPlugins().length} game plugins`
    )
  );

  // Helper: Get room from Redis
  async function getRoom(uuid: string): Promise<BaseRoomState | null> {
    const data = await getRedis().get(`room:${uuid}`);
    if (!data) return null;
    return JSON.parse(data);
  }

  // Helper: Save room to Redis
  async function saveRoom(room: BaseRoomState): Promise<void> {
    room.lastActivity = Date.now();
    await getRedis().set(`room:${room.uuid}`, JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
    await getRedis().sadd('rooms:active', room.uuid);
  }

  // Helper: Broadcast to room via Redis pub/sub
  async function broadcastToRoom(roomId: string, type: string, data: any): Promise<void> {
    await getPubClient().publish(
      'game-room-events',
      JSON.stringify({ type, roomId, ...data })
    );
  }

  // Built-in message handler: RS (Room Start / Join Room)
  async function handleRoomStart(
    data: string,
    _context: MessageContext
  ): Promise<SystemMessageResponse> {
    const roomUuid = data;
    const room = await getRoom(roomUuid);

    if (!room) {
      return { success: false, error: 'Room not found or expired' };
    }

    if (room.state === 'ended') {
      return { success: false, error: 'Room has ended' };
    }

    // Mark room as active if not already
    if (room.state === 'created') {
      room.state = 'active';
      await saveRoom(room);
    }

    logger.logDev(color.green.bold(`[Game Room] Player joined room ${white.bold(roomUuid)}`));

    // Broadcast game started event to host
    await broadcastToRoom(roomUuid, 'gameStarted', {
      roomState: room.state,
    });

    return {
      success: true,
      action: 'joinedRoom',
      storeRoomId: roomUuid,
      data: {
        roomId: roomUuid,
        type: room.type,
        pluginData: room.pluginData,
      },
    };
  }

  // Helper: Load track mapping from bingo file (used during room creation and as fallback)
  async function loadTrackMapping(hostFilename: string): Promise<Record<string, number> | null> {
    try {
      // Get bingo file from database (lookup by filename directly)
      const bingoFile = await prisma.bingoFile.findFirst({
        where: {
          filename: hostFilename,
        },
        include: {
          paymentHasPlaylist: true,
        },
      });

      if (!bingoFile) {
        logger.logDev(color.yellow.bold(`[Game Room] Bingo file not found: ${hostFilename}`));
        return null;
      }

      // Get playlist tracks - need both database ID and Spotify ID
      const playlistDbId = bingoFile.paymentHasPlaylist.playlistId;
      const tracks = await prisma.$queryRaw<{ id: number; trackId: string }[]>`
        SELECT t.id, t.trackId
        FROM playlist_has_tracks pht
        JOIN tracks t ON t.id = pht.trackId
        WHERE pht.playlistId = ${playlistDbId}
        ORDER BY pht.\`order\` ASC
      `;

      // Filter by selected tracks if applicable (selectedTrackIds contains Spotify IDs)
      const selectedTrackIds = bingoFile.selectedTrackIds as string[] | null;
      let orderedTracks = tracks;
      if (selectedTrackIds && selectedTrackIds.length > 0) {
        const selectedSet = new Set(selectedTrackIds);
        orderedTracks = orderedTracks.filter(t => selectedSet.has(t.trackId));
      }

      // Create mapping: database ID -> bingoNumber (1-based index)
      // QR codes use database IDs, not Spotify IDs
      const mapping: Record<string, number> = {};
      orderedTracks.forEach((track, index) => {
        mapping[track.id.toString()] = index + 1;
      });

      return mapping;
    } catch (error: any) {
      logger.log(color.red.bold(`[Game Room] Error loading track mapping: ${error.message}`));
      return null;
    }
  }

  // Helper: Get track mapping for a room (uses cached mapping, no SQL)
  function getTrackMapping(room: BaseRoomState): Record<string, number> | null {
    return room.pluginData.trackMapping || null;
  }

  // Built-in message handler: TS (Track Scanned)
  async function handleTrackScanned(
    data: string,
    context: MessageContext
  ): Promise<SystemMessageResponse> {
    const { room, roomId } = context;

    if (!room || !roomId) {
      return { success: false, error: 'No active room' };
    }

    if (room.state === 'ended') {
      return { success: false, error: 'Room has ended' };
    }

    // Data is now trackId, look up bingo number from cached mapping
    const trackId = data;
    let trackMapping = getTrackMapping(room);

    // Fallback: load mapping if not cached (for rooms created before this feature)
    if (!trackMapping && room.pluginData.hostFilename) {
      logger.logDev(color.yellow.bold(`[TS] Loading track mapping for room ${roomId} (fallback)`));
      trackMapping = await loadTrackMapping(room.pluginData.hostFilename);
      if (trackMapping) {
        room.pluginData.trackMapping = trackMapping;
        await saveRoom(room);
      }
    }

    logger.logDev(color.blue.bold(`[TS] trackId: ${trackId}, has mapping: ${!!trackMapping}, mapping size: ${trackMapping ? Object.keys(trackMapping).length : 0}`));

    if (!trackMapping) {
      logger.log(color.red.bold(`[TS] No track mapping for room ${roomId}`));
      return { success: false, error: 'Track mapping not available' };
    }

    const bingoNum = trackMapping[trackId];
    logger.logDev(color.blue.bold(`[TS] Looked up trackId ${trackId} -> bingoNum: ${bingoNum}`));

    if (!bingoNum) {
      // Track not found in mapping - could be a non-bingo track
      logger.logDev(color.yellow.bold(`[Game Room] Track ${trackId} not found in bingo mapping`));
      return { success: false, error: 'Track not in bingo playlist' };
    }

    // Update plugin data - track played tracks
    const playedTrackIds = room.pluginData.playedTrackIds || [];
    if (!playedTrackIds.includes(bingoNum)) {
      playedTrackIds.push(bingoNum);
      room.pluginData.playedTrackIds = playedTrackIds;
      await saveRoom(room);

      // Broadcast track scanned event
      await broadcastToRoom(roomId, 'trackScanned', {
        bingoNumber: bingoNum,
        playedCount: playedTrackIds.length,
      });

      logger.logDev(
        color.blue.bold(
          `[Game Room] Track ${white.bold(bingoNum.toString())} scanned in room ${white.bold(roomId)}`
        )
      );
    }

    return {
      success: true,
      data: {
        bingoNumber: bingoNum,
        playedCount: playedTrackIds.length,
      },
    };
  }

  // Built-in message handler: RV (Room Validate)
  async function handleRoomValidate(
    _data: string,
    context: MessageContext
  ): Promise<SystemMessageResponse> {
    const { room } = context;

    if (!room) {
      return { success: false, data: { valid: false, reason: 'not_found' } };
    }

    if (room.state === 'ended') {
      return { success: false, data: { valid: false, reason: 'ended' } };
    }

    return {
      success: true,
      data: { valid: true, type: room.type, state: room.state },
    };
  }

  /**
   * POST /api/game/message
   * Generic QRSSM message handler
   * Body: { message: string, roomId?: string }
   * The message is everything after "QRSSM:" from the QR code
   */
  fastify.post('/api/game/message', async (request: any, reply: any) => {
    try {
      const { message, roomId } = request.body;

      if (!message || typeof message !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'Message is required',
        });
      }

      // Parse message type (first part before colon)
      // Format: TYPE:data or TYPE:more:data
      const colonIndex = message.indexOf(':');
      let messageType: string;
      let messageData: string;

      if (colonIndex === -1) {
        messageType = message;
        messageData = '';
      } else {
        messageType = message.substring(0, colonIndex);
        messageData = message.substring(colonIndex + 1);
      }

      logger.logDev(
        color.blue.bold(
          `[QRSSM] Received message type: ${white.bold(messageType)}, data: ${white.bold(messageData)}, roomId: ${roomId || 'none'}`
        )
      );

      // Get room context if roomId provided
      let room: BaseRoomState | null = null;
      if (roomId) {
        room = await getRoom(roomId);
      }

      // Create message context
      const context: MessageContext = {
        roomId,
        room: room || undefined,
        updateRoom: saveRoom,
        broadcastToRoom,
      };

      // Handle built-in message types first
      if (messageType === 'RS') {
        const result = await handleRoomStart(messageData, context);
        return reply.send(result);
      }

      if (messageType === 'TS') {
        const result = await handleTrackScanned(messageData, context);
        return reply.send(result);
      }

      if (messageType === 'RV') {
        const result = await handleRoomValidate(messageData, context);
        return reply.send(result);
      }

      // Find plugin handler for this message type
      const plugin = GamePluginRegistry.getPluginForMessageType(messageType);
      if (!plugin) {
        logger.logDev(color.yellow.bold(`[QRSSM] Unknown message type: ${messageType}`));
        return reply.status(400).send({
          success: false,
          error: `Unknown message type: ${messageType}`,
        });
      }

      // Execute plugin handler
      const result = await plugin.handleMessage(messageType, messageData, context);

      // Handle broadcast if specified
      if (result.broadcast && roomId) {
        await broadcastToRoom(roomId, result.broadcast.type, result.broadcast.data);
      }

      return reply.send({
        success: result.success,
        action: result.action,
        storeRoomId: result.storeRoomId,
        data: result.data,
        error: result.error,
      });
    } catch (error: any) {
      logger.log(color.red.bold(`[QRSSM] Error processing message: ${error.message}`));
      return reply.status(500).send({
        success: false,
        error: 'Failed to process message',
      });
    }
  });

  /**
   * POST /api/game/room
   * Create a new game room (requires auth)
   */
  if (getAuthHandler) {
    fastify.post(
      '/api/game/room',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const { type, hostFilename, ...extraData } = request.body;
          const userIdString = request.user?.userId;

          if (!userIdString) {
            return reply.status(400).send({
              success: false,
              error: 'Missing required parameters',
            });
          }

          // Look up user
          const user = await prisma.user.findUnique({
            where: { userId: userIdString },
          });

          if (!user) {
            return reply.status(401).send({
              success: false,
              error: 'User not found',
            });
          }

          // Get plugin for room type
          const roomType = type || 'bingo';
          const plugin = GamePluginRegistry.getPluginForRoomType(roomType);

          if (!plugin) {
            return reply.status(400).send({
              success: false,
              error: `Unknown room type: ${roomType}`,
            });
          }

          // Create room in database
          const uuid = uuidv4();

          const dbRoom = await prisma.gameRoom.create({
            data: {
              uuid,
              type: roomType,
              userId: user.id,
              state: 'created',
            },
          });

          // Create room state in Redis with plugin-specific data
          // Plugin-specific fields (like hostFilename for bingo) go in pluginData
          const pluginData: Record<string, any> = {
            ...plugin.getDefaultPluginData(),
            ...(hostFilename && { hostFilename }),
            ...extraData,
          };

          // Pre-load track mapping for bingo rooms (so no SQL during gameplay)
          if (roomType === 'bingo' && hostFilename) {
            const trackMapping = await loadTrackMapping(hostFilename);
            if (trackMapping) {
              pluginData.trackMapping = trackMapping;
              logger.logDev(color.blue.bold(`[Game Room] Pre-loaded track mapping with ${Object.keys(trackMapping).length} tracks`));
            }
          }

          const roomState: BaseRoomState = {
            id: dbRoom.id,
            uuid,
            type: roomType,
            userId: user.id,
            state: 'created',
            lastActivity: Date.now(),
            pluginData,
          };

          await saveRoom(roomState);

          logger.logDev(
            color.green.bold(
              `[Game Room] Created ${white.bold(roomType)} room ${white.bold(uuid)}`
            )
          );

          return reply.send({
            success: true,
            roomId: uuid,
            qrData: `QRSSM:RS:${uuid}`,
          });
        } catch (error: any) {
          logger.log(color.red.bold(`[Game Room] Error creating room: ${error.message}`));
          return reply.status(500).send({
            success: false,
            error: 'Failed to create room',
          });
        }
      }
    );

    /**
     * GET /api/game/room/:roomId
     * Get room state
     */
    fastify.get(
      '/api/game/room/:roomId',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const { roomId } = request.params;
          const userIdString = request.user?.userId;

          const user = await prisma.user.findUnique({
            where: { userId: userIdString },
          });

          if (!user) {
            return reply.status(401).send({ success: false, error: 'User not found' });
          }

          const room = await getRoom(roomId);
          if (!room) {
            return reply.status(404).send({ success: false, error: 'Room not found' });
          }

          // Only the host can get full room state
          if (room.userId !== user.id) {
            return reply.status(403).send({ success: false, error: 'Not authorized' });
          }

          return reply.send({
            success: true,
            room: {
              id: room.uuid,
              type: room.type,
              state: room.state,
              pluginData: room.pluginData,
              lastActivity: room.lastActivity,
            },
          });
        } catch (error: any) {
          logger.log(color.red.bold(`[Game Room] Error getting room: ${error.message}`));
          return reply.status(500).send({ success: false, error: 'Failed to get room' });
        }
      }
    );

    /**
     * DELETE /api/game/room/:roomId
     * End a room
     */
    fastify.delete(
      '/api/game/room/:roomId',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const { roomId } = request.params;
          const userIdString = request.user?.userId;

          const user = await prisma.user.findUnique({
            where: { userId: userIdString },
          });

          if (!user) {
            return reply.status(401).send({ success: false, error: 'User not found' });
          }

          const room = await getRoom(roomId);
          if (!room) {
            return reply.status(404).send({ success: false, error: 'Room not found' });
          }

          if (room.userId !== user.id) {
            return reply.status(403).send({ success: false, error: 'Not authorized' });
          }

          // Update room state
          room.state = 'ended';
          await saveRoom(room);

          // Update database
          await prisma.gameRoom.update({
            where: { uuid: roomId },
            data: { state: 'ended', endedAt: new Date() },
          });

          // Broadcast room ended event
          await broadcastToRoom(roomId, 'roomEnded', {});

          logger.logDev(color.blue.bold(`[Game Room] Ended room ${white.bold(roomId)}`));

          return reply.send({ success: true });
        } catch (error: any) {
          logger.log(color.red.bold(`[Game Room] Error ending room: ${error.message}`));
          return reply.status(500).send({ success: false, error: 'Failed to end room' });
        }
      }
    );

    /**
     * POST /api/game/room/:roomId/plugin
     * Update plugin-specific room data (generic endpoint)
     */
    fastify.post(
      '/api/game/room/:roomId/plugin',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const { roomId } = request.params;
          const { action, data } = request.body;
          const userIdString = request.user?.userId;

          const user = await prisma.user.findUnique({
            where: { userId: userIdString },
          });

          if (!user) {
            return reply.status(401).send({ success: false, error: 'User not found' });
          }

          const room = await getRoom(roomId);
          if (!room) {
            return reply.status(404).send({ success: false, error: 'Room not found' });
          }

          if (room.userId !== user.id) {
            return reply.status(403).send({ success: false, error: 'Not authorized' });
          }

          // Get plugin for this room type
          const plugin = GamePluginRegistry.getPluginForRoomType(room.type);
          if (!plugin) {
            return reply.status(400).send({ success: false, error: 'Unknown room type' });
          }

          // Validate action if plugin supports it
          if (plugin.validateRoomAction && !plugin.validateRoomAction(action, room, data)) {
            return reply.status(400).send({ success: false, error: 'Invalid action or data' });
          }

          // Update plugin data based on action
          // This is a generic update - plugins can define specific actions
          if (data) {
            room.pluginData = { ...room.pluginData, ...data };
          }
          await saveRoom(room);

          // Broadcast plugin data change
          await broadcastToRoom(roomId, 'pluginDataChanged', {
            action,
            pluginData: room.pluginData,
          });

          return reply.send({ success: true, pluginData: room.pluginData });
        } catch (error: any) {
          logger.log(color.red.bold(`[Game Room] Error updating plugin data: ${error.message}`));
          return reply.status(500).send({ success: false, error: 'Failed to update plugin data' });
        }
      }
    );
  }

  // Note: Track scanning and room validation are handled via generic /api/game/message endpoint
  // TS:{trackId} - Track Scanned (trackId is looked up to get bingoNumber)
  // RV - Room Validate

  // Cleanup inactive rooms from Redis (runs every 15 minutes)
  const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  const ROOM_INACTIVE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

  async function cleanupInactiveRooms(): Promise<void> {
    try {
      const activeRoomIds = await getRedis().smembers('rooms:active');
      let cleanedCount = 0;

      for (const roomId of activeRoomIds) {
        const roomData = await getRedis().get(`room:${roomId}`);
        if (!roomData) {
          // Room key doesn't exist, remove from active set
          await getRedis().srem('rooms:active', roomId);
          cleanedCount++;
          continue;
        }

        const room = JSON.parse(roomData) as BaseRoomState;
        const inactiveMs = Date.now() - room.lastActivity;

        if (inactiveMs > ROOM_INACTIVE_THRESHOLD_MS) {
          // Remove from Redis
          await getRedis().del(`room:${roomId}`);
          await getRedis().srem('rooms:active', roomId);

          // Update database to mark as ended
          await prisma.gameRoom.update({
            where: { uuid: roomId },
            data: { state: 'ended', endedAt: new Date() },
          }).catch(() => {
            // Ignore if room not found in database
          });

          // Broadcast room expired event
          await broadcastToRoom(roomId, 'roomExpired', {});

          cleanedCount++;
          logger.logDev(
            color.blue.bold(
              `[Game Room Cleanup] Removed inactive room ${white.bold(roomId)} (inactive for ${Math.round(inactiveMs / 60000)} minutes)`
            )
          );
        }
      }

      if (cleanedCount > 0) {
        logger.logDev(color.blue.bold(`[Game Room Cleanup] Cleaned up ${cleanedCount} inactive rooms`));
      }
    } catch (error: any) {
      logger.log(color.red.bold(`[Game Room Cleanup] Error: ${error.message}`));
    }
  }

  // Start cleanup interval
  setInterval(cleanupInactiveRooms, CLEANUP_INTERVAL_MS);
  logger.logDev(color.green.bold('[Game Room Cleanup] Started cleanup task (every 15 minutes)'));
};

export default gameRoutes;
