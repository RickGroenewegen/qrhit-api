import { Prisma } from '@prisma/client';
import PrismaInstance from './prisma';
import Redis from 'ioredis';
import Utils from './utils';

interface GameSettings {
  numberOfRounds: number;
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

  constructor() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    this.redis = new Redis(redisUrl);
    this.utils = new Utils();
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

  async getRandomTrack(): Promise<any> {
    const prisma = PrismaInstance.getInstance();

    // Get a random track from playlist 159
    // First, get the count of tracks in playlist 159
    const count = await prisma.track.count({
      where: {
        spotifyLink: {
          not: null,
        },
        playlists: {
          some: {
            playlistId: 159,
          },
        },
      },
    });

    if (count === 0) {
      return null;
    }

    // Get a random offset
    const randomOffset = Math.floor(Math.random() * count);

    // Get a random track from playlist 159
    const tracks = await prisma.track.findMany({
      where: {
        spotifyLink: {
          not: null,
        },
        playlists: {
          some: {
            playlistId: 159,
          },
        },
      },
      skip: randomOffset,
      take: 1,
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

    if (tracks.length === 0) {
      return null;
    }

    const track = tracks[0];

    // Determine year and decade
    const year = track.year || track.spotifyYear || null;
    let decade = null;
    if (year) {
      decade = Math.floor(year / 10) * 10;
    }

    return {
      id: track.id,
      name: track.name,
      artist: track.artist,
      uri: track.spotifyLink,
      releaseDate: year ? `${year}-01-01` : null,
      year: year,
      decade: decade,
      previewUrl: track.preview,
    };
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

  // Get purchased playlists for a user by their hash
  async getUserPlaylists(userHash: string) {
    const prisma = PrismaInstance.getInstance();

    // Find the user by hash
    const user = await prisma.user.findUnique({
      where: { hash: userHash },
    });

    if (!user) {
      throw new Error('User not found');
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
        if (!playlistMap.has(php.playlist.id)) {
          playlistMap.set(php.playlist.id, {
            id: php.playlist.id,
            playlistId: php.playlist.playlistId,
            name: php.playlist.name,
            numberOfTracks: php.playlist.numberOfTracks,
            image: php.playlist.image,
            genre: php.playlist.genreId,
          });
        }
      });
    });

    const playlists = Array.from(playlistMap.values());

    return {
      success: true,
      playlists,
      userHash,
    };
  }
}

export default Game;
