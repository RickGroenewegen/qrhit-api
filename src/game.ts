import { Prisma } from '@prisma/client';
import PrismaInstance from './prisma';
import Redis from 'ioredis';
import Utils from './utils';
import Cache from './cache';

interface GameSettings {
  numberOfRounds: number;
  roundCountdown?: number;
  playlistIds?: number[];
  userHash?: string;
}

interface Player {
  id: string;
  name: string;
  avatar?: string;
  score: number;
  isHost: boolean;
  hasSubmitted?: boolean;
}

interface GameData {
  id: string;
  type: string;
  playMode: 'home' | 'remote';
  settings: GameSettings;
  players: Player[];
  currentRound: number;
  state: 'waiting' | 'playing' | 'finished';
  createdAt: number;
}

class Game {
  private redis: Redis;
  private gameExpiration = 60 * 60 * 4; // 4 hours
  private utils: Utils;
  private prisma = PrismaInstance.getInstance();
  private cache: Cache;

  constructor() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    this.redis = new Redis(redisUrl);
    this.utils = new Utils();
    this.cache = Cache.getInstance();
  }

  // Generate a short, memorable game ID
  private generateGameId(): string {
    // Generate a 6-character ID using custom alphabet
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing characters
    let gameId = '';
    for (let i = 0; i < 6; i++) {
      gameId += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return gameId;
  }

  async createGame(data: {
    hostName: string;
    hostAvatar?: string;
    gameType: string;
    playMode: 'home' | 'remote';
    settings: GameSettings;
  }): Promise<string> {
    const gameId = this.generateGameId();
    const hostId = this.utils.generateRandomString(21); // Similar length to nanoid

    const gameData: GameData = {
      id: gameId,
      type: data.gameType,
      playMode: data.playMode,
      settings: data.settings,
      players: [
        {
          id: hostId,
          name: data.hostName,
          avatar: data.hostAvatar,
          score: 0,
          isHost: true,
        },
      ],
      currentRound: 0,
      state: 'waiting',
      createdAt: Date.now(),
    };

    // Store game data in Redis
    await this.redis.setex(
      `game:${gameId}`,
      this.gameExpiration,
      JSON.stringify(gameData)
    );

    // Pre-warm the cache for this game (non-blocking)
    this.prewarmGameCache(gameId).catch(err => {
      // Error pre-warming game cache
    });

    return gameId;
  }

  async joinGame(
    gameId: string,
    playerName: string,
    playerAvatar?: string
  ): Promise<any> {
    const gameData = await this.getGameData(gameId);

    if (!gameData) {
      return null;
    }

    if (gameData.state !== 'waiting') {
      throw new Error('Game has already started');
    }

    // Check if player already exists
    const existingPlayer = gameData.players.find((p) => p.name === playerName);
    if (existingPlayer) {
      throw new Error('Player with this name already exists');
    }

    // Add new player
    const playerId = this.utils.generateRandomString(21); // Similar length to nanoid
    const newPlayer = {
      id: playerId,
      name: playerName,
      avatar: playerAvatar,
      score: 0,
      isHost: false,
    };

    gameData.players.push(newPlayer);

    // Update game data
    await this.redis.setex(
      `game:${gameId}`,
      this.gameExpiration,
      JSON.stringify(gameData)
    );

    return {
      gameId,
      playMode: gameData.playMode,
      playerId,
    };
  }

  async getGame(gameId: string): Promise<GameData | null> {
    return this.getGameData(gameId);
  }

  private async getGameData(gameId: string): Promise<GameData | null> {
    const data = await this.redis.get(`game:${gameId}`);
    if (!data) {
      return null;
    }
    return JSON.parse(data);
  }

  async updateGame(gameId: string, gameData: GameData): Promise<void> {
    await this.redis.setex(
      `game:${gameId}`,
      this.gameExpiration,
      JSON.stringify(gameData)
    );
  }

  async getRandomTrack(gameId?: string): Promise<any> {
    let playlistIds = [20]; // Default to basic playlist

    // If gameId is provided, get the playlist IDs from the game
    if (gameId) {
      const gameData = await this.getGameData(gameId);
      if (
        gameData &&
        gameData.settings.playlistIds &&
        gameData.settings.playlistIds.length > 0
      ) {
        playlistIds = gameData.settings.playlistIds;

        // If userHash is provided, validate playlist ownership
        if (gameData.settings.userHash) {
          playlistIds = await this.validatePlaylistOwnership(
            gameData.settings.userHash,
            playlistIds
          );
        }
      }
    }

    
    // Try to get tracks from cache first
    let tracks = await this.getCachedTracks(playlistIds);
    
    if (!tracks) {
      // Cache miss - load tracks and cache them
      await this.cachePlaylistTracks(playlistIds);
      tracks = await this.getCachedTracks(playlistIds);
    }

    if (!tracks || tracks.length === 0) {
      return null;
    }

    // Pick a random track from the cached array
    const randomIndex = Math.floor(Math.random() * tracks.length);
    const track = tracks[randomIndex];

    // Determine year and decade
    const year = track.year || track.spotifyYear || null;
    let decade = null;
    if (year) {
      decade = Math.floor(year / 10) * 10;
    }

    const result = {
      id: track.id,
      name: track.name,
      artist: track.artist,
      uri: track.spotifyLink,
      releaseDate: year ? `${year}-01-01` : null,
      year: year,
      decade: decade,
      previewUrl: track.preview,
    };
    
    return result;
  }

  // Clean up expired games (can be called periodically)
  async cleanupExpiredGames(): Promise<void> {
    const keys = await this.redis.keys('game:*');

    for (const key of keys) {
      const ttl = await this.redis.ttl(key);
      if (ttl === -1) {
        // Key exists but has no expiration, delete it
        await this.redis.del(key);
      }
    }
  }

  // Get the current question type index for a game
  async getQuestionTypeIndex(gameId: string): Promise<number> {
    const key = `game:${gameId}:questionTypeIndex`;
    const index = await this.redis.get(key);
    return index ? parseInt(index, 10) : 0;
  }

  // Set the question type index for a game
  async setQuestionTypeIndex(gameId: string, index: number): Promise<void> {
    const key = `game:${gameId}:questionTypeIndex`;
    await this.redis.setex(key, this.gameExpiration, index.toString());
  }

  // Get only basic playlists (for users not logged in)
  async getBasicPlaylists() {
    const cacheKey = 'playlists:basic';
    const cacheDuration = 60 * 60 * 24; // 24 hours
    
    // Try to get from cache first
    const cachedResult = await this.cache.get(cacheKey);
    if (cachedResult) {
      return JSON.parse(cachedResult);
    }
    
    const prisma = PrismaInstance.getInstance();

    
    // Define basic playlist IDs that are available to everyone
    const basicPlaylistIds = [20]; // Metal basic playlist
    
    // Get basic playlists
    const basicPlaylists = await prisma.playlist.findMany({
      where: {
        id: {
          in: basicPlaylistIds,
        },
      },
      select: {
        id: true,
        playlistId: true,
        name: true,
        numberOfTracks: true,
        image: true,
        genreId: true,
      },
    });


    // Format basic playlists
    const formattedBasicPlaylists = basicPlaylists.map(playlist => ({
      ...playlist,
      genre: playlist.genreId,
      private: false, // Basic playlists are not private
    }));


    const result = {
      success: true,
      playlists: formattedBasicPlaylists,
    };

    // Cache the result
    await this.cache.set(cacheKey, JSON.stringify(result), cacheDuration);
    
    return result;
  }

  // Get playlists for a user by their hash (includes basic playlists)
  // Clear playlist cache for a specific user
  async clearUserPlaylistCache(userHash: string) {
    const cacheKey = `playlists:user:${userHash}`;
    await this.cache.del(cacheKey);
  }
  
  // Clear all playlist caches (basic and user-specific)
  async clearAllPlaylistCache() {
    // Clear basic playlists cache
    await this.cache.del('playlists:basic');
    
    // Clear all user playlist caches using pattern
    await this.cache.delPattern('playlists:user:*');
  }

  async getUserPlaylists(userHash: string) {
    const cacheKey = `playlists:user:${userHash}`;
    const cacheDuration = 60 * 60 * 24; // 24 hours
    
    // Try to get from cache first
    const cachedResult = await this.cache.get(cacheKey);
    if (cachedResult) {
      return JSON.parse(cachedResult);
    }
    
    const prisma = PrismaInstance.getInstance();


    // Define basic playlist IDs that are available to everyone
    const basicPlaylistIds = [20]; // Metal basic playlist
    
    // Get basic playlists first
    const basicPlaylists = await prisma.playlist.findMany({
      where: {
        id: {
          in: basicPlaylistIds,
        },
      },
      select: {
        id: true,
        playlistId: true,
        name: true,
        numberOfTracks: true,
        image: true,
        genreId: true,
      },
    });


    // Format basic playlists
    const formattedBasicPlaylists = basicPlaylists.map(playlist => ({
      ...playlist,
      genre: playlist.genreId,
      private: false, // Basic playlists are not private
    }));

    // Find the user by hash
    const user = await prisma.user.findUnique({
      where: { hash: userHash },
    });


    if (!user) {
      // If user not found, still return basic playlists
      const result = {
        success: true,
        playlists: formattedBasicPlaylists,
        userHash,
      };
      
      // Cache the result (shorter duration for non-existing users)
      await this.cache.set(cacheKey, JSON.stringify(result), 60 * 60); // 1 hour
      
      return result;
    }

    // Get all paid payments for this user
    const payments = await prisma.payment.findMany({
      where: {
        userId: user.id,
        status: 'paid',
      },
      include: {
        PaymentHasPlaylist: {
          include: {
            playlist: true,
          },
        },
      },
    });


    // Extract unique playlists from all payments
    const playlistMap = new Map();

    payments.forEach((payment) => {
      payment.PaymentHasPlaylist.forEach((php) => {
        // Skip if this is already in our basic playlists
        if (!playlistMap.has(php.playlist.id) && !basicPlaylistIds.includes(php.playlist.id)) {
          playlistMap.set(php.playlist.id, {
            id: php.playlist.id,
            playlistId: php.playlist.playlistId,
            name: php.playlist.name,
            numberOfTracks: php.playlist.numberOfTracks,
            image: php.playlist.image,
            genre: php.playlist.genreId,
            private: true, // User-specific playlists are private
          });
        }
      });
    });

    const userPlaylists = Array.from(playlistMap.values());

    // Combine basic and user playlists
    const allPlaylists = [...formattedBasicPlaylists, ...userPlaylists];

    const result = {
      success: true,
      playlists: allPlaylists,
      userHash,
    };
    
    // Cache the result
    await this.cache.set(cacheKey, JSON.stringify(result), cacheDuration);
    
    return result;
  }


  async validatePlaylistOwnership(
    userHash: string,
    requestedPlaylistIds: number[]
  ): Promise<number[]> {
    // Always include the basic playlist (20)
    const validPlaylistIds = [20];

    // Check cache first for owned playlists
    const cacheKey = `user:${userHash}:owned_playlists`;
    const cachedPlaylists = await this.cache.get(cacheKey);
    
    let ownedPlaylistIds: Set<number>;
    
    if (cachedPlaylists) {
      // Use cached data
      const cached = JSON.parse(cachedPlaylists);
      ownedPlaylistIds = new Set<number>(cached);
    } else {
      // Fetch from database
      const prisma = PrismaInstance.getInstance();
      
      // Find the user by hash
      const user = await prisma.user.findUnique({
        where: { hash: userHash },
      });

      if (!user) {
        return validPlaylistIds;
      }

      // Get all paid payments for this user
      const payments = await prisma.payment.findMany({
        where: {
          userId: user.id,
          status: 'paid',
        },
        include: {
          PaymentHasPlaylist: {
            select: {
              playlistId: true,
            },
          },
        },
      });

      // Extract owned playlist IDs
      ownedPlaylistIds = new Set<number>();
      payments.forEach((payment) => {
        payment.PaymentHasPlaylist.forEach((php) => {
          ownedPlaylistIds.add(php.playlistId);
        });
      });

      // Cache the owned playlists for 1 hour
      await this.cache.set(
        cacheKey, 
        JSON.stringify(Array.from(ownedPlaylistIds)),
        3600
      );
    }

    // Only include playlists that are both requested and owned
    requestedPlaylistIds.forEach((playlistId) => {
      if (ownedPlaylistIds.has(playlistId)) {
        validPlaylistIds.push(playlistId);
      }
    });

    return validPlaylistIds;
  }

  // Cache all tracks for specific playlists
  async cachePlaylistTracks(playlistIds: number[]): Promise<void> {
    // Always sort IDs to ensure consistent cache keys
    const sortedIds = [...playlistIds].sort((a, b) => a - b);
    const cacheKey = `playlists:${sortedIds.join('_')}:tracks`;
    
    // Check if already cached
    const cached = await this.cache.get(cacheKey, false);
    if (cached) {
      return;
    }

    
    // First, let's check if these playlists exist and have tracks
    const playlistsWithTrackCount = await this.prisma.playlist.findMany({
      where: {
        id: {
          in: playlistIds
        }
      },
      include: {
        _count: {
          select: {
            tracks: true
          }
        }
      }
    });
    
    
    // Fetch all tracks for these playlists
    const tracks = await this.prisma.track.findMany({
      where: {
        spotifyLink: {
          not: null,
        },
        playlists: {
          some: {
            playlistId: {
              in: playlistIds,
            },
          },
        },
      },
      select: {
        id: true,
        name: true,
        artist: true,
        spotifyLink: true,
        year: true,
        spotifyYear: true,
        preview: true,
      },
    });

    // Cache tracks for 4 hours (same as game expiration)
    try {
      await this.cache.set(
        cacheKey,
        JSON.stringify(tracks),
        this.gameExpiration
      );
      
      // Verify the cache was set
    } catch (error) {
      // Error caching tracks
    }
  }

  // Get cached tracks for playlists
  async getCachedTracks(playlistIds: number[]): Promise<any[] | null> {
    // Always sort IDs to ensure consistent cache keys
    const sortedIds = [...playlistIds].sort((a, b) => a - b);
    const cacheKey = `playlists:${sortedIds.join('_')}:tracks`;
    const cached = await this.cache.get(cacheKey, false);
    
    if (cached) {
      const tracks = JSON.parse(cached);
      return tracks;
    }
    
    return null;
  }

  // Invalidate user's playlist ownership cache (call this when user makes a new purchase)
  async invalidateUserPlaylistCache(userHash: string): Promise<void> {
    const cacheKey = `user:${userHash}:owned_playlists`;
    await this.cache.del(cacheKey);
  }

  // Pre-warm cache for a game (optional optimization)
  async prewarmGameCache(gameId: string): Promise<void> {
    const gameData = await this.getGameData(gameId);
    if (
      gameData &&
      gameData.settings.playlistIds &&
      gameData.settings.playlistIds.length > 0
    ) {
      let playlistIds = gameData.settings.playlistIds;
      
      // Validate ownership if userHash is provided
      if (gameData.settings.userHash) {
        playlistIds = await this.validatePlaylistOwnership(
          gameData.settings.userHash,
          playlistIds
        );
      }
      
      // Cache the tracks for these playlists
      await this.cachePlaylistTracks(playlistIds);
    }
  }

  // Check if game cache is ready
  async isGameCacheReady(gameId: string): Promise<boolean> {
    const gameData = await this.getGameData(gameId);
    if (!gameData) return false;

    let playlistIds = gameData.settings.playlistIds || [20];
    
    // Validate ownership if userHash is provided
    if (gameData.settings.userHash && gameData.settings.playlistIds) {
      playlistIds = await this.validatePlaylistOwnership(
        gameData.settings.userHash,
        playlistIds
      );
    }

    const tracks = await this.getCachedTracks(playlistIds);
    return tracks !== null && tracks.length > 0;
  }
}

export default Game;
