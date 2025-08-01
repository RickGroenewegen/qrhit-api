import { Prisma } from '@prisma/client';
import PrismaInstance from './prisma';
import Redis from 'ioredis';
import Utils from './utils';
import Cache from './cache';

interface GameSettings {
  numberOfRounds: number;
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
      console.error('Error pre-warming game cache:', err);
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
      console.error(`Game.joinGame: Game ${gameId} not found in Redis`);
      return null;
    }

    if (gameData.state !== 'waiting') {
      console.error(
        `Game.joinGame: Game ${gameId} has already started (state: ${gameData.state})`
      );
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
    console.log('getRandomTrack called with gameId:', gameId);
    let playlistIds = [20]; // Default to basic playlist

    // If gameId is provided, get the playlist IDs from the game
    if (gameId) {
      const gameData = await this.getGameData(gameId);
      console.log('Game data retrieved:', gameData ? 'found' : 'not found');
      if (
        gameData &&
        gameData.settings.playlistIds &&
        gameData.settings.playlistIds.length > 0
      ) {
        playlistIds = gameData.settings.playlistIds;
        console.log('Using playlist IDs from game:', playlistIds);

        // If userHash is provided, validate playlist ownership
        if (gameData.settings.userHash) {
          console.log('Validating playlist ownership for userHash:', gameData.settings.userHash);
          playlistIds = await this.validatePlaylistOwnership(
            gameData.settings.userHash,
            playlistIds
          );
          console.log('Validated playlist IDs:', playlistIds);
        }
      }
    }

    console.log('Final playlist IDs to use:', playlistIds);
    
    // Try to get tracks from cache first
    let tracks = await this.getCachedTracks(playlistIds);
    console.log('Cached tracks found:', tracks ? tracks.length : 0);
    
    if (!tracks) {
      console.log('Cache miss - loading tracks from database for playlists:', playlistIds);
      // Cache miss - load tracks and cache them
      await this.cachePlaylistTracks(playlistIds);
      tracks = await this.getCachedTracks(playlistIds);
      console.log('After caching, tracks found:', tracks ? tracks.length : 0);
    }

    if (!tracks || tracks.length === 0) {
      console.log('No tracks available for playlists:', playlistIds);
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
    
    console.log('Returning random track:', {
      name: result.name,
      artist: result.artist,
      uri: result.uri,
      year: result.year
    });
    
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
    const prisma = PrismaInstance.getInstance();

    console.log('getBasicPlaylists called');
    
    // Define basic playlist IDs that are available to everyone
    const basicPlaylistIds = [20]; // Metal basic playlist
    console.log('Looking for basic playlist IDs:', basicPlaylistIds);
    
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

    console.log('Raw basic playlists from DB:', basicPlaylists);

    // Format basic playlists
    const formattedBasicPlaylists = basicPlaylists.map(playlist => ({
      ...playlist,
      genre: playlist.genreId,
      private: false, // Basic playlists are not private
    }));

    console.log('Formatted basic playlists:', formattedBasicPlaylists);

    const result = {
      success: true,
      playlists: formattedBasicPlaylists,
    };

    console.log('Final result from getBasicPlaylists:', result);
    return result;
  }

  // Get playlists for a user by their hash (includes basic playlists)
  async getUserPlaylists(userHash: string) {
    const prisma = PrismaInstance.getInstance();

    console.log(`getUserPlaylists called with userHash: ${userHash}`);

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

    console.log(`Found ${basicPlaylists.length} basic playlists`);

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

    console.log(`User found: ${user ? 'Yes, ID: ' + user.id : 'No'}`);

    if (!user) {
      // If user not found, still return basic playlists
      return {
        success: true,
        playlists: formattedBasicPlaylists,
        userHash,
      };
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

    console.log(`Found ${payments.length} paid payments for user`);

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
    console.log(`Found ${userPlaylists.length} unique user playlists`);

    // Combine basic and user playlists
    const allPlaylists = [...formattedBasicPlaylists, ...userPlaylists];
    console.log(`Returning total of ${allPlaylists.length} playlists`);

    return {
      success: true,
      playlists: allPlaylists,
      userHash,
    };
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
    console.log('cachePlaylistTracks called with playlistIds:', playlistIds);
    console.log('Sorted IDs:', sortedIds);
    console.log('Cache key:', cacheKey);
    
    // Check if already cached
    const cached = await this.cache.get(cacheKey, false);
    if (cached) {
      console.log('Tracks already cached, returning');
      return;
    }

    console.log('Fetching tracks from database for playlists:', playlistIds);
    
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
    
    console.log('Playlists found:', playlistsWithTrackCount.map(p => ({
      id: p.id,
      name: p.name,
      trackCount: p._count.tracks
    })));
    
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
    
    console.log('Database query returned', tracks.length, 'tracks');
    if (tracks.length > 0) {
      console.log('Sample track:', {
        id: tracks[0].id,
        name: tracks[0].name,
        artist: tracks[0].artist,
        spotifyLink: tracks[0].spotifyLink,
        year: tracks[0].year
      });
    }

    // Cache tracks for 4 hours (same as game expiration)
    console.log('Caching', tracks.length, 'tracks with key:', cacheKey);
    try {
      await this.cache.set(
        cacheKey,
        JSON.stringify(tracks),
        this.gameExpiration
      );
      console.log('Cache set completed');
      
      // Verify the cache was set
      const verifyCache = await this.cache.get(cacheKey, false);
      console.log('Cache verification - data exists:', !!verifyCache);
      if (verifyCache) {
        const parsed = JSON.parse(verifyCache);
        console.log('Cache verification - track count:', parsed.length);
      }
    } catch (error) {
      console.error('Error caching tracks:', error);
    }
  }

  // Get cached tracks for playlists
  async getCachedTracks(playlistIds: number[]): Promise<any[] | null> {
    // Always sort IDs to ensure consistent cache keys
    const sortedIds = [...playlistIds].sort((a, b) => a - b);
    const cacheKey = `playlists:${sortedIds.join('_')}:tracks`;
    console.log('getCachedTracks - looking for cache key:', cacheKey);
    const cached = await this.cache.get(cacheKey, false);
    
    if (cached) {
      const tracks = JSON.parse(cached);
      console.log('getCachedTracks - found cached tracks:', tracks.length);
      return tracks;
    }
    
    console.log('getCachedTracks - no cache found');
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
