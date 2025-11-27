import Redis from 'ioredis';
import { fuzzy } from 'fast-fuzzy';
import PrismaInstance from '../prisma';
import Utils from '../utils';
import { WebSocket } from 'ws';

// Interfaces for WebSocket handling
export interface QuizPlayerConnection {
  id: string;
  ws: WebSocket;
  gameId: string;
  playerName: string;
  playerAvatar?: string;
  isHost: boolean;
  isAlive: boolean;
}

export interface QuizBroadcaster {
  sendMessage(ws: WebSocket, message: { type: string; data?: any }): void;
  publishRedisEvent(gameId: string, type: string, data: any, excludeConnectionId?: string): void;
}

// Interfaces
export interface QuizSettings {
  maxPlayers: number;        // Default 100, max 100
  roundTimer: number;        // 15-90 seconds, default 30
  totalRounds: number;       // Informational, tracks how many planned
  yearTolerance: number;     // Years +/- for partial credit (default 2)
  hostPlays: boolean;        // Whether host participates as player
}

export interface QuizPlayer {
  id: string;                // Connection ID
  name: string;
  avatar?: string;
  score: number;             // Total cumulative score
  artistPoints: number;      // Breakdown for stats
  titlePoints: number;
  yearPoints: number;
  joinedAt: number;
  isHost: boolean;
  hasSubmitted: boolean;     // For current round only
}

export interface QuizAnswer {
  artist: string;
  title: string;
  year: number | null;
  submittedAt: number;
}

export interface QuizTrackInfo {
  trackId: number;
  artist: string;
  title: string;
  year: number | null;
}

export interface QuizGameState {
  id: string;                       // Game ID (6 chars)
  phpId: number;                    // PaymentHasPlaylist ID (game channel)
  playlistIds: number[];            // Selected playlist IDs
  hostConnectionId: string;         // Host's WebSocket connection ID
  state: 'lobby' | 'playing' | 'countdown' | 'round_active' | 'round_results' | 'leaderboard' | 'finished';
  settings: QuizSettings;
  currentRound: number;
  tracksScanned: number;            // How many tracks have been scanned
  createdAt: number;
  startedAt?: number;               // Timestamp when lobby -> playing
}

export interface PlayerAnswerResult {
  playerId: string;
  playerName: string;
  playerAvatar?: string;
  artistAnswer: string;
  artistCorrect: boolean;
  artistPoints: number;
  titleAnswer: string;
  titleCorrect: boolean;
  titlePoints: number;
  yearAnswer: number | null;
  yearCorrect: boolean;
  yearPoints: number;
  totalRoundPoints: number;
}

export interface RoundResults {
  track: QuizTrackInfo;
  answers: PlayerAnswerResult[];
  leaderboard: QuizPlayer[];
}

class QuizCardGame {
  private static instance: QuizCardGame;
  private redis: Redis;
  private pubClient: Redis;
  private prisma = PrismaInstance.getInstance();
  private utils: Utils;
  private gameExpiration = 60 * 60 * 4; // 4 hours

  private constructor() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    this.redis = new Redis(redisUrl);
    this.pubClient = new Redis(redisUrl);
    this.utils = new Utils();
  }

  // Publish event via Redis for cross-server communication
  private publishEvent(gameId: string, type: string, data: any) {
    const event = { gameId: `quiz:${gameId}`, type, data };
    this.pubClient.publish('game-events', JSON.stringify(event));
  }

  static getInstance(): QuizCardGame {
    if (!QuizCardGame.instance) {
      QuizCardGame.instance = new QuizCardGame();
    }
    return QuizCardGame.instance;
  }

  // Public method to acquire a Redis lock (for use by WebSocket handlers)
  async acquireLock(lockKey: string, expirationSeconds: number = 5): Promise<boolean> {
    const result = await this.redis.set(lockKey, '1', 'EX', expirationSeconds, 'NX');
    return result === 'OK';
  }

  // Generate a short, memorable game ID
  private generateGameId(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let gameId = '';
    for (let i = 0; i < 6; i++) {
      gameId += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return gameId;
  }

  // ==================== GAME CREATION & MANAGEMENT ====================

  async createGame(
    phpId: number,
    playlistIds: number[],
    hostConnectionId: string,
    settings: Partial<QuizSettings> = {}
  ): Promise<string> {
    const gameId = this.generateGameId();
    console.log(`[Quiz] Creating game ${gameId} for phpId=${phpId}, playlistIds=${playlistIds.join(',')}`);
    console.log(`[Quiz] Setting Redis key quiz:php:${phpId} -> ${gameId}`);

    const fullSettings: QuizSettings = {
      maxPlayers: Math.min(settings.maxPlayers || 100, 100),
      roundTimer: Math.max(15, Math.min(settings.roundTimer || 30, 90)),
      totalRounds: settings.totalRounds || 10,
      yearTolerance: Math.max(0, Math.min(settings.yearTolerance || 2, 10)),
      hostPlays: settings.hostPlays ?? false,
    };

    const gameState: QuizGameState = {
      id: gameId,
      phpId,
      playlistIds,
      hostConnectionId,
      state: 'lobby',
      settings: fullSettings,
      currentRound: 0,
      tracksScanned: 0,
      createdAt: Date.now(),
    };

    // Store game state
    await this.redis.setex(
      `quiz:game:${gameId}`,
      this.gameExpiration,
      JSON.stringify(gameState)
    );

    // Create PHP -> Game mapping for quick lookup
    await this.redis.setex(
      `quiz:php:${phpId}`,
      this.gameExpiration,
      gameId
    );

    // Initialize empty players hash
    await this.redis.expire(`quiz:game:${gameId}:players`, this.gameExpiration);

    return gameId;
  }

  async getGame(gameId: string): Promise<QuizGameState | null> {
    const data = await this.redis.get(`quiz:game:${gameId}`);
    if (!data) return null;
    return JSON.parse(data);
  }

  async updateGame(gameId: string, gameState: QuizGameState): Promise<void> {
    await this.redis.setex(
      `quiz:game:${gameId}`,
      this.gameExpiration,
      JSON.stringify(gameState)
    );
  }

  async hasActiveGame(phpId: number): Promise<boolean> {
    const gameId = await this.redis.get(`quiz:php:${phpId}`);
    if (!gameId) return false;

    const game = await this.getGame(gameId);
    return game !== null && game.state !== 'finished';
  }

  async getActiveGameForPhp(phpId: number): Promise<QuizGameState | null> {
    const gameId = await this.redis.get(`quiz:php:${phpId}`);
    if (!gameId) return null;

    const game = await this.getGame(gameId);
    if (!game || game.state === 'finished') {
      // Clean up stale mapping
      await this.redis.del(`quiz:php:${phpId}`);
      return null;
    }

    return game;
  }

  async getGameIdForPhp(phpId: number): Promise<string | null> {
    return await this.redis.get(`quiz:php:${phpId}`);
  }

  // ==================== CARD SCAN HANDLER ====================

  /**
   * Handle a card scan from /qrlink2 route.
   * This method encapsulates all quiz game logic for card scanning.
   * Only triggers a round if:
   * - An active game exists for this PHP
   * - Game is in a state that accepts new rounds (playing, leaderboard, round_results)
   * - Track hasn't already been used
   */
  async handleCardScan(phpId: number, trackId: number): Promise<void> {
    console.log(`[Quiz] handleCardScan called: phpId=${phpId}, trackId=${trackId}`);

    // Check if there's an active game for this PHP
    const game = await this.getActiveGameForPhp(phpId);
    if (!game) {
      console.log(`[Quiz] No active game found for phpId=${phpId}`);
      return;
    }
    console.log(`[Quiz] Found game ${game.id}, state=${game.state}`);

    // Only trigger rounds if game is in a state that accepts card scans
    const validStates = ['playing', 'leaderboard', 'round_results'];
    if (!validStates.includes(game.state)) {
      console.log(`[Quiz] Game ${game.id} state '${game.state}' not valid for card scan`);
      return;
    }

    // Get track info from database
    const trackInfo = await this.getTrackInfoFromDb(trackId);
    if (!trackInfo) {
      console.log(`[Quiz] Track ${trackId} not found in database`);
      return;
    }
    console.log(`[Quiz] Found track: ${trackInfo.artist} - ${trackInfo.title}`)

    // Check if track was already used
    if (await this.isTrackUsed(game.id, trackId)) {
      console.log(`[Quiz] Track ${trackId} already used in game ${game.id}`);
      // Notify about duplicate via Redis pub/sub
      this.publishEvent(game.id, 'quiz:duplicateCard', {
        trackId,
        message: 'This card has already been played in this game',
      });
      return;
    }

    // Trigger the round
    console.log(`[Quiz] Triggering round for game ${game.id}`);
    const roundResult = await this.triggerRound(phpId, trackInfo);
    if (!roundResult) {
      console.log(`[Quiz] triggerRound returned null for game ${game.id}`);
      return;
    }
    console.log(`[Quiz] Round ${roundResult.round} triggered for game ${game.id}`);

    // Broadcast countdown start via Redis pub/sub
    // Note: messageKey is used for frontend translation
    this.publishEvent(game.id, 'quiz:countdown', {
      round: roundResult.round,
      countdownSeconds: 3,
      messageKey: 'quiz.cardScannedGetReady',
    });

    // Schedule round start after countdown (3 seconds)
    setTimeout(async () => {
      try {
        const timing = await this.startRoundTimer(game.id);

        // Broadcast round start
        this.publishEvent(game.id, 'quiz:roundStart', {
          round: roundResult.round,
          serverTime: Date.now(),
          endTime: timing.endTime,
          duration: timing.duration,
          messageKey: 'quiz.enterYourAnswers',
        });

        // Schedule auto-end when timer expires
        setTimeout(async () => {
          const currentGame = await this.getGame(game.id);
          if (currentGame && currentGame.state === 'round_active') {
            // Timer expired, calculate and broadcast results
            const results = await this.calculateRoundResults(game.id);
            this.publishEvent(game.id, 'quiz:roundResults', {
              track: results.track,
              answers: results.answers,
              leaderboard: results.leaderboard.map((p, index) => ({
                rank: index + 1,
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                score: p.score,
                artistPoints: p.artistPoints,
                titlePoints: p.titlePoints,
                yearPoints: p.yearPoints,
                isHost: p.isHost,
              })),
            });
          }
        }, timing.duration * 1000);

      } catch (error) {
        console.error('[Quiz Game] Error starting round timer:', error);
      }
    }, 3000);
  }

  // ==================== PLAYER MANAGEMENT ====================

  async addPlayer(
    gameId: string,
    playerId: string,
    playerName: string,
    avatar?: string,
    isHost: boolean = false
  ): Promise<QuizPlayer> {
    const game = await this.getGame(gameId);
    if (!game) {
      throw new Error('GAME_NOT_FOUND');
    }

    // Validate player name length (max 20 characters)
    if (playerName.length > 20) {
      throw new Error('NAME_TOO_LONG');
    }

    // Get existing players
    const players = await this.getPlayers(gameId);

    // Check if this is a reconnecting player (same name)
    const existingPlayer = players.find(p => p.name.toLowerCase() === playerName.toLowerCase());

    // Allow joins in lobby or playing state (before first round starts)
    const canJoinNewPlayer = game.state === 'lobby' ||
      (game.state === 'playing' && game.currentRound === 0);

    if (!canJoinNewPlayer) {
      // Game in progress - only allow reconnection for existing players
      if (!existingPlayer) {
        throw new Error('GAME_IN_PROGRESS');
      }
      // Update the player's connection ID and return their existing data
      const reconnectedPlayer: QuizPlayer = {
        ...existingPlayer,
        id: playerId, // Update to new connection ID
      };
      await this.redis.hdel(`quiz:game:${gameId}:players`, existingPlayer.id);
      await this.redis.hset(
        `quiz:game:${gameId}:players`,
        playerId,
        JSON.stringify(reconnectedPlayer)
      );
      return reconnectedPlayer;
    }

    // Game in lobby - normal join logic
    // Check player count
    if (players.length >= game.settings.maxPlayers) {
      throw new Error('GAME_FULL');
    }

    // Check for duplicate name (but allow reconnection with same name)
    if (existingPlayer && existingPlayer.id !== playerId) {
      // Update the existing player's connection ID instead of rejecting
      const reconnectedPlayer: QuizPlayer = {
        ...existingPlayer,
        id: playerId,
        avatar: avatar || existingPlayer.avatar,
      };
      await this.redis.hdel(`quiz:game:${gameId}:players`, existingPlayer.id);
      await this.redis.hset(
        `quiz:game:${gameId}:players`,
        playerId,
        JSON.stringify(reconnectedPlayer)
      );
      return reconnectedPlayer;
    }

    const player: QuizPlayer = {
      id: playerId,
      name: playerName,
      avatar,
      score: 0,
      artistPoints: 0,
      titlePoints: 0,
      yearPoints: 0,
      joinedAt: Date.now(),
      isHost,
      hasSubmitted: false,
    };

    await this.redis.hset(
      `quiz:game:${gameId}:players`,
      playerId,
      JSON.stringify(player)
    );
    await this.redis.expire(`quiz:game:${gameId}:players`, this.gameExpiration);

    return player;
  }

  async getPlayers(gameId: string): Promise<QuizPlayer[]> {
    const playersHash = await this.redis.hgetall(`quiz:game:${gameId}:players`);
    const players: QuizPlayer[] = [];

    for (const [, playerData] of Object.entries(playersHash)) {
      players.push(JSON.parse(playerData));
    }

    return players.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  async getPlayer(gameId: string, playerId: string): Promise<QuizPlayer | null> {
    const playerData = await this.redis.hget(`quiz:game:${gameId}:players`, playerId);
    if (!playerData) return null;
    return JSON.parse(playerData);
  }

  async updatePlayer(gameId: string, player: QuizPlayer): Promise<void> {
    await this.redis.hset(
      `quiz:game:${gameId}:players`,
      player.id,
      JSON.stringify(player)
    );
  }

  async removePlayer(gameId: string, playerId: string): Promise<void> {
    await this.redis.hdel(`quiz:game:${gameId}:players`, playerId);
  }

  async clearPlayers(gameId: string): Promise<void> {
    await this.redis.del(`quiz:game:${gameId}:players`);
  }

  // ==================== GAME FLOW ====================

  async startGame(gameId: string, hostConnectionId: string): Promise<void> {
    const game = await this.getGame(gameId);
    if (!game) {
      throw new Error('GAME_NOT_FOUND');
    }

    if (game.hostConnectionId !== hostConnectionId) {
      throw new Error('NOT_HOST');
    }

    if (game.state !== 'lobby') {
      throw new Error('INVALID_STATE');
    }

    game.state = 'playing';
    game.startedAt = Date.now();
    await this.updateGame(gameId, game);
  }

  async triggerRound(phpId: number, trackInfo: QuizTrackInfo): Promise<{ gameId: string; round: number } | null> {
    const game = await this.getActiveGameForPhp(phpId);
    if (!game) return null;

    // Only allow triggering if game is in 'playing', 'leaderboard', or 'round_results' state
    if (!['playing', 'leaderboard', 'round_results'].includes(game.state)) {
      return null;
    }

    // Check for duplicate track
    const isDuplicate = await this.isTrackUsed(game.id, trackInfo.trackId);
    if (isDuplicate) {
      return null; // Will be handled by caller to notify about duplicate
    }

    // Mark track as used
    await this.redis.sadd(`quiz:game:${game.id}:usedTracks`, trackInfo.trackId.toString());
    await this.redis.expire(`quiz:game:${game.id}:usedTracks`, this.gameExpiration);

    // Store track info (SECRET - never sent to clients during round)
    await this.redis.setex(
      `quiz:game:${game.id}:track`,
      this.gameExpiration,
      JSON.stringify(trackInfo)
    );

    // Update game state
    game.currentRound += 1;
    game.tracksScanned += 1;
    game.state = 'countdown';
    await this.updateGame(game.id, game);

    // Clear previous answers and reset player submission status
    await this.clearAnswers(game.id);
    await this.resetPlayerSubmissions(game.id);

    return { gameId: game.id, round: game.currentRound };
  }

  async startRoundTimer(gameId: string): Promise<{ endTime: number; duration: number }> {
    const game = await this.getGame(gameId);
    if (!game) {
      throw new Error('GAME_NOT_FOUND');
    }

    const now = Date.now();
    const duration = game.settings.roundTimer;
    const endTime = now + (duration * 1000);

    // Store round timing
    await this.redis.setex(
      `quiz:game:${gameId}:roundEndTime`,
      this.gameExpiration,
      endTime.toString()
    );

    // Update state to round_active
    game.state = 'round_active';
    await this.updateGame(gameId, game);

    return { endTime, duration };
  }

  async isTrackUsed(gameId: string, trackId: number): Promise<boolean> {
    const isMember = await this.redis.sismember(
      `quiz:game:${gameId}:usedTracks`,
      trackId.toString()
    );
    return isMember === 1;
  }

  // ==================== ANSWERS ====================

  async submitAnswer(gameId: string, playerId: string, answer: QuizAnswer): Promise<boolean> {
    const game = await this.getGame(gameId);
    if (!game || game.state !== 'round_active') {
      return false;
    }

    // Use atomic hsetnx to prevent race condition where two workers
    // both check for existing answer, find none, and both store
    const result = await this.redis.hsetnx(
      `quiz:game:${gameId}:answers`,
      playerId,
      JSON.stringify(answer)
    );

    if (result === 0) {
      return false; // Already submitted (another worker got there first)
    }

    await this.redis.expire(`quiz:game:${gameId}:answers`, this.gameExpiration);

    // Update player's hasSubmitted
    const player = await this.getPlayer(gameId, playerId);
    if (player) {
      player.hasSubmitted = true;
      await this.updatePlayer(gameId, player);
    }

    return true;
  }

  async getAnswers(gameId: string): Promise<Map<string, QuizAnswer>> {
    const answersHash = await this.redis.hgetall(`quiz:game:${gameId}:answers`);
    const answers = new Map<string, QuizAnswer>();

    for (const [playerId, answerData] of Object.entries(answersHash)) {
      answers.set(playerId, JSON.parse(answerData));
    }

    return answers;
  }

  async clearAnswers(gameId: string): Promise<void> {
    await this.redis.del(`quiz:game:${gameId}:answers`);
  }

  async resetPlayerSubmissions(gameId: string): Promise<void> {
    const players = await this.getPlayers(gameId);
    for (const player of players) {
      player.hasSubmitted = false;
      await this.updatePlayer(gameId, player);
    }
  }

  async getSubmittedCount(gameId: string): Promise<{ submitted: number; total: number }> {
    const players = await this.getPlayers(gameId);
    const game = await this.getGame(gameId);

    // If host plays, include host in count
    const activePlayers = game?.settings.hostPlays
      ? players
      : players.filter(p => !p.isHost);

    const submitted = activePlayers.filter(p => p.hasSubmitted).length;
    return { submitted, total: activePlayers.length };
  }

  async allPlayersSubmitted(gameId: string): Promise<boolean> {
    const { submitted, total } = await this.getSubmittedCount(gameId);
    return submitted >= total && total > 0;
  }

  // ==================== SCORING ====================

  async getCurrentTrack(gameId: string): Promise<QuizTrackInfo | null> {
    const data = await this.redis.get(`quiz:game:${gameId}:track`);
    if (!data) return null;
    return JSON.parse(data);
  }

  async getTrackInfoFromDb(trackId: number): Promise<QuizTrackInfo | null> {
    const track = await this.prisma.track.findUnique({
      where: { id: trackId },
      select: {
        id: true,
        name: true,
        artist: true,
        year: true,
        spotifyYear: true,
        discogsYear: true,
        aiYear: true,
        musicBrainzYear: true,
      },
    });

    if (!track) return null;

    // Use best available year (priority order)
    const year = track.year || track.spotifyYear || track.discogsYear ||
      track.aiYear || track.musicBrainzYear || null;

    return {
      trackId: track.id,
      artist: track.artist,
      title: track.name,
      year,
    };
  }

  checkArtistAnswer(playerAnswer: string, correctAnswer: string): { correct: boolean; points: number } {
    if (!playerAnswer || playerAnswer.trim().length === 0) {
      return { correct: false, points: 0 };
    }

    const normalized = playerAnswer.trim().toLowerCase();
    const correct = correctAnswer.trim().toLowerCase();

    const similarity = fuzzy(normalized, correct);
    const lengthRatio = normalized.length / correct.length;

    const isCorrect = similarity > 0.85 && lengthRatio > 0.6;
    return { correct: isCorrect, points: isCorrect ? 1 : 0 };
  }

  checkTitleAnswer(playerAnswer: string, correctAnswer: string): { correct: boolean; points: number } {
    if (!playerAnswer || playerAnswer.trim().length === 0) {
      return { correct: false, points: 0 };
    }

    const normalized = playerAnswer.trim().toLowerCase();
    const correct = correctAnswer.trim().toLowerCase();

    const similarity = fuzzy(normalized, correct);
    const lengthRatio = normalized.length / correct.length;

    // Multi-word penalty
    const answerWords = normalized.split(/\s+/).filter(w => w.length > 0).length;
    const correctWords = correct.split(/\s+/).filter(w => w.length > 0).length;

    let threshold = 0.85;
    if (correctWords > 1 && answerWords < correctWords) {
      threshold = Math.min(0.95, 0.85 + (0.1 * (correctWords - answerWords)));
    }

    const isCorrect = similarity > threshold && lengthRatio > 0.6;
    return { correct: isCorrect, points: isCorrect ? 1 : 0 };
  }

  checkYearAnswer(playerYear: number | null, correctYear: number | null, tolerance: number): { correct: boolean; points: number } {
    if (playerYear === null || correctYear === null) {
      return { correct: false, points: 0 };
    }

    const diff = Math.abs(playerYear - correctYear);

    if (diff === 0) {
      return { correct: true, points: 2 }; // Exact match: 2 points
    } else if (diff <= tolerance) {
      return { correct: true, points: 1 }; // Within tolerance: 1 point
    }

    return { correct: false, points: 0 };
  }

  async calculateRoundResults(gameId: string): Promise<RoundResults> {
    const game = await this.getGame(gameId);
    if (!game) {
      throw new Error('GAME_NOT_FOUND');
    }

    // Use Redis lock to prevent multiple workers from calculating results simultaneously
    const lockKey = `quiz:game:${gameId}:round:${game.currentRound}:results_lock`;
    const lockResult = await this.redis.set(lockKey, '1', 'EX', 30, 'NX');

    if (!lockResult) {
      // Another worker is already calculating - wait and return cached results
      console.log(`[Quiz Game] Results already being calculated for game ${gameId} round ${game.currentRound}, waiting...`);
      // Wait a bit and return the cached results
      await new Promise(resolve => setTimeout(resolve, 500));
      const cachedResults = await this.redis.get(`quiz:game:${gameId}:round:${game.currentRound}:results`);
      if (cachedResults) {
        return JSON.parse(cachedResults);
      }
      // If still no results, throw error
      throw new Error('RESULTS_CALCULATION_IN_PROGRESS');
    }

    // Check if results already calculated for this round (idempotency check)
    const existingResults = await this.redis.get(`quiz:game:${gameId}:round:${game.currentRound}:results`);
    if (existingResults) {
      console.log(`[Quiz Game] Results already exist for game ${gameId} round ${game.currentRound}`);
      return JSON.parse(existingResults);
    }

    const track = await this.getCurrentTrack(gameId);
    if (!track) {
      throw new Error('NO_TRACK_DATA');
    }

    const answers = await this.getAnswers(gameId);
    const players = await this.getPlayers(gameId);
    const results: PlayerAnswerResult[] = [];

    for (const player of players) {
      // Skip host if not playing
      if (player.isHost && !game.settings.hostPlays) {
        continue;
      }

      const answer = answers.get(player.id);
      const artistResult = answer
        ? this.checkArtistAnswer(answer.artist, track.artist)
        : { correct: false, points: 0 };

      const titleResult = answer
        ? this.checkTitleAnswer(answer.title, track.title)
        : { correct: false, points: 0 };

      const yearResult = answer
        ? this.checkYearAnswer(answer.year, track.year, game.settings.yearTolerance)
        : { correct: false, points: 0 };

      const totalRoundPoints = artistResult.points + titleResult.points + yearResult.points;

      // Update player scores
      player.score += totalRoundPoints;
      player.artistPoints += artistResult.points;
      player.titlePoints += titleResult.points;
      player.yearPoints += yearResult.points;
      await this.updatePlayer(gameId, player);

      results.push({
        playerId: player.id,
        playerName: player.name,
        playerAvatar: player.avatar,
        artistAnswer: answer?.artist || '',
        artistCorrect: artistResult.correct,
        artistPoints: artistResult.points,
        titleAnswer: answer?.title || '',
        titleCorrect: titleResult.correct,
        titlePoints: titleResult.points,
        yearAnswer: answer?.year ?? null,
        yearCorrect: yearResult.correct,
        yearPoints: yearResult.points,
        totalRoundPoints,
      });
    }

    // Update game state
    game.state = 'round_results';
    await this.updateGame(gameId, game);

    // Get updated leaderboard
    const leaderboard = await this.getLeaderboard(gameId);

    const roundResults: RoundResults = {
      track,
      answers: results,
      leaderboard,
    };

    // Cache results for this round (for idempotency and multi-worker safety)
    await this.redis.setex(
      `quiz:game:${gameId}:round:${game.currentRound}:results`,
      3600, // 1 hour TTL
      JSON.stringify(roundResults)
    );

    return roundResults;
  }

  // ==================== ANSWER OVERRIDE ====================

  async overrideAnswer(
    gameId: string,
    playerId: string,
    field: 'artist' | 'title' | 'year',
    correct: boolean
  ): Promise<{ pointsDelta: number; newTotalScore: number } | null> {
    // Use Redis lock to prevent race conditions with concurrent overrides
    const lockKey = `quiz:game:${gameId}:player:${playerId}:override_lock`;
    const lockResult = await this.redis.set(lockKey, '1', 'EX', 5, 'NX');

    if (!lockResult) {
      // Another worker is processing an override for this player
      // Wait briefly and retry once
      await new Promise(resolve => setTimeout(resolve, 100));
      const retryLock = await this.redis.set(lockKey, '1', 'EX', 5, 'NX');
      if (!retryLock) {
        console.log(`[Quiz Game] Override lock busy for player ${playerId}, skipping`);
        return null;
      }
    }

    try {
      const player = await this.getPlayer(gameId, playerId);
      if (!player) return null;

      const game = await this.getGame(gameId);
      if (!game) return null;

      let pointsDelta = 0;
      const maxPoints = field === 'year' ? 2 : 1;

      if (field === 'artist') {
        const wasCorrect = player.artistPoints > 0;
        if (!wasCorrect && correct) {
          pointsDelta = 1;
          player.artistPoints = 1;
        } else if (wasCorrect && !correct) {
          pointsDelta = -player.artistPoints;
          player.artistPoints = 0;
        }
      } else if (field === 'title') {
        const wasCorrect = player.titlePoints > 0;
        if (!wasCorrect && correct) {
          pointsDelta = 1;
          player.titlePoints = 1;
        } else if (wasCorrect && !correct) {
          pointsDelta = -player.titlePoints;
          player.titlePoints = 0;
        }
      } else if (field === 'year') {
        const wasCorrect = player.yearPoints > 0;
        if (!wasCorrect && correct) {
          // Award full 2 points when overriding to correct
          pointsDelta = 2;
          player.yearPoints = 2;
        } else if (wasCorrect && !correct) {
          pointsDelta = -player.yearPoints;
          player.yearPoints = 0;
        }
      }

      player.score += pointsDelta;
      await this.updatePlayer(gameId, player);

      return {
        pointsDelta,
        newTotalScore: player.score,
      };
    } finally {
      // Release the lock
      await this.redis.del(lockKey);
    }
  }

  // ==================== LEADERBOARD ====================

  async getLeaderboard(gameId: string): Promise<QuizPlayer[]> {
    const players = await this.getPlayers(gameId);
    return players.sort((a, b) => b.score - a.score);
  }

  async showLeaderboard(gameId: string): Promise<void> {
    const game = await this.getGame(gameId);
    if (game) {
      game.state = 'leaderboard';
      await this.updateGame(gameId, game);
    }
  }

  // ==================== GAME END & RESTART ====================

  async endGame(gameId: string): Promise<QuizPlayer[]> {
    const game = await this.getGame(gameId);
    if (game) {
      game.state = 'finished';
      await this.updateGame(gameId, game);

      // Clean up PHP mapping
      await this.redis.del(`quiz:php:${game.phpId}`);
    }

    return this.getLeaderboard(gameId);
  }

  async restartGame(gameId: string): Promise<void> {
    const game = await this.getGame(gameId);
    if (!game) {
      throw new Error('GAME_NOT_FOUND');
    }

    // Reset game state
    game.state = 'playing';
    game.currentRound = 0;
    game.tracksScanned = 0;
    game.startedAt = Date.now();
    await this.updateGame(gameId, game);

    // Reset all player scores
    const players = await this.getPlayers(gameId);
    for (const player of players) {
      player.score = 0;
      player.artistPoints = 0;
      player.titlePoints = 0;
      player.yearPoints = 0;
      player.hasSubmitted = false;
      await this.updatePlayer(gameId, player);
    }

    // Clear used tracks
    await this.redis.del(`quiz:game:${gameId}:usedTracks`);

    // Clear current track and answers
    await this.redis.del(`quiz:game:${gameId}:track`);
    await this.clearAnswers(gameId);
  }

  // ==================== CLEANUP ====================

  async cleanupGame(gameId: string): Promise<void> {
    const game = await this.getGame(gameId);
    if (game) {
      await this.redis.del(`quiz:php:${game.phpId}`);
    }

    // Delete all game-related keys
    await this.redis.del(`quiz:game:${gameId}`);
    await this.redis.del(`quiz:game:${gameId}:players`);
    await this.redis.del(`quiz:game:${gameId}:track`);
    await this.redis.del(`quiz:game:${gameId}:answers`);
    await this.redis.del(`quiz:game:${gameId}:usedTracks`);
    await this.redis.del(`quiz:game:${gameId}:roundEndTime`);
  }
}

// ==================== WEBSOCKET HANDLER CLASS ====================

/**
 * QuizWebSocketHandler handles all WebSocket message routing and broadcasting for quiz games.
 * This separates quiz-specific WebSocket logic from the general WebSocket server.
 */
export class QuizWebSocketHandler {
  private quizGame: QuizCardGame;
  private connections: Map<string, QuizPlayerConnection> = new Map();
  private quizConnections: Map<string, Set<string>> = new Map(); // gameId -> Set of connectionIds
  private broadcaster: QuizBroadcaster;

  constructor(broadcaster: QuizBroadcaster) {
    this.quizGame = QuizCardGame.getInstance();
    this.broadcaster = broadcaster;
  }

  // Get connection by ID
  getConnection(connectionId: string): QuizPlayerConnection | undefined {
    return this.connections.get(connectionId);
  }

  // Check if a message type is a quiz message
  isQuizMessage(type: string): boolean {
    return type.startsWith('quiz:');
  }

  // Route quiz messages to appropriate handler
  async handleMessage(connectionId: string, ws: WebSocket, type: string, data: any): Promise<void> {
    switch (type) {
      case 'quiz:join':
        await this.handleJoin(connectionId, ws, data);
        break;
      case 'quiz:start':
        await this.handleStart(connectionId, data);
        break;
      case 'quiz:answer':
        await this.handleAnswer(connectionId, data);
        break;
      case 'quiz:showResults':
        await this.handleShowResults(connectionId, data);
        break;
      case 'quiz:showLeaderboard':
        await this.handleShowLeaderboard(connectionId, data);
        break;
      case 'quiz:end':
        await this.handleEnd(connectionId, data);
        break;
      case 'quiz:restart':
        await this.handleRestart(connectionId, data);
        break;
      case 'quiz:overrideAnswer':
        await this.handleOverrideAnswer(connectionId, data);
        break;
      case 'quiz:updateSettings':
        await this.handleUpdateSettings(connectionId, data);
        break;
    }
  }

  // Track pending host disconnections for grace period
  private hostDisconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly HOST_DISCONNECT_GRACE_PERIOD = 10000; // 10 seconds grace period for host refresh

  // Handle player disconnection
  async handleDisconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { gameId, isHost, playerName } = connection;

    // Remove from connections
    this.connections.delete(connectionId);

    // Remove from quiz connections
    const quizConnectionIds = this.quizConnections.get(gameId);
    if (quizConnectionIds) {
      quizConnectionIds.delete(connectionId);
      if (quizConnectionIds.size === 0) {
        this.quizConnections.delete(gameId);
      }
    }

    try {
      if (isHost) {
        // Host disconnected - give grace period for reconnection (e.g., page refresh)
        console.log(`[Quiz WS] Host ${playerName} disconnected from game ${gameId}, starting ${this.HOST_DISCONNECT_GRACE_PERIOD}ms grace period`);

        // Clear any existing timer for this game
        const existingTimer = this.hostDisconnectTimers.get(gameId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        // Set timer to end game if host doesn't reconnect
        const timer = setTimeout(async () => {
          this.hostDisconnectTimers.delete(gameId);

          // Check if game is still active in Redis (not ended by another worker)
          const game = await this.quizGame.getGame(gameId);
          if (!game || game.state === 'finished') {
            console.log(`[Quiz WS] Game ${gameId} already ended or finished, skipping host disconnect handling`);
            return;
          }

          // Check if host has reconnected by looking at local connections
          // Note: In multi-worker setup, host may have reconnected on another worker
          // But that worker would have cancelled its timer via Redis broadcast
          const hasHostReconnected = Array.from(this.connections.values()).some(
            conn => conn.gameId === gameId && conn.isHost
          );

          if (!hasHostReconnected) {
            // Double-check: only end the game if we're the "authoritative" worker
            // Use a Redis lock to prevent multiple workers from ending the game
            const lockKey = `quiz:game:${gameId}:host_disconnect_lock`;
            const lockAcquired = await this.quizGame.acquireLock(lockKey, 5);

            if (lockAcquired) {
              console.log(`[Quiz WS] Host did not reconnect to game ${gameId}, ending game`);
              this.broadcastToGame(gameId, 'quiz:hostLeft', {
                messageKey: 'quiz.hostDisconnectedGameEnded',
              });
              await this.quizGame.endGame(gameId);
            } else {
              console.log(`[Quiz WS] Another worker is handling host disconnect for game ${gameId}`);
            }
          } else {
            console.log(`[Quiz WS] Host reconnected to game ${gameId}, game continues`);
          }
        }, this.HOST_DISCONNECT_GRACE_PERIOD);

        this.hostDisconnectTimers.set(gameId, timer);
      } else {
        // Regular player disconnected - give grace period for reconnection (e.g., page refresh)
        console.log(`[Quiz WS] Player ${playerName} (${connectionId}) disconnected from game ${gameId}, starting grace period`);

        // Use a shorter grace period for regular players
        const PLAYER_DISCONNECT_GRACE_PERIOD = 5000; // 5 seconds
        const playerNameLower = playerName.toLowerCase();
        const disconnectedPlayerId = connectionId; // Capture the specific connection ID that disconnected

        setTimeout(async () => {
          // Check if game still exists
          const game = await this.quizGame.getGame(gameId);
          if (!game || game.state === 'finished') {
            console.log(`[Quiz WS] Game ${gameId} already ended, skipping player disconnect handling`);
            return;
          }

          // Check if the SAME connection ID still exists in Redis
          // If the player reconnected, they'll have a NEW connection ID
          const existingPlayer = await this.quizGame.getPlayer(gameId, disconnectedPlayerId);

          if (!existingPlayer) {
            // Player entry with this connection ID no longer exists
            // Either they were removed, or they reconnected (which creates a new entry with new ID)
            console.log(`[Quiz WS] Player ${playerName} (${disconnectedPlayerId}) no longer exists with same ID - likely reconnected with new ID`);
            return;
          }

          // Check if there's an active connection for this player on THIS worker
          const hasLocalConnection = Array.from(this.connections.values()).some(
            conn => conn.gameId === gameId && conn.playerName.toLowerCase() === playerNameLower
          );

          if (hasLocalConnection) {
            console.log(`[Quiz WS] Player ${playerName} reconnected to game ${gameId} on this worker`);
            return;
          }

          // Use Redis lock to prevent multiple workers from removing the same player
          const lockKey = `quiz:game:${gameId}:player_disconnect:${disconnectedPlayerId}`;
          const lockAcquired = await this.quizGame.acquireLock(lockKey, 10);

          if (!lockAcquired) {
            console.log(`[Quiz WS] Another worker is handling disconnect for player ${playerName} in game ${gameId}`);
            return;
          }

          // Re-check if player with THIS connection ID still exists
          const playerToRemove = await this.quizGame.getPlayer(gameId, disconnectedPlayerId);

          if (playerToRemove) {
            console.log(`[Quiz WS] Player ${playerName} (${disconnectedPlayerId}) did not reconnect, removing from game ${gameId}`);
            await this.quizGame.removePlayer(gameId, disconnectedPlayerId);
            const finalPlayers = await this.quizGame.getPlayers(gameId);

            this.broadcastToGame(gameId, 'quiz:playerLeft', {
              players: this.formatPlayers(finalPlayers),
              count: finalPlayers.length,
            });
          } else {
            console.log(`[Quiz WS] Player ${playerName} reconnected with new ID, not removing`);
          }
        }, PLAYER_DISCONNECT_GRACE_PERIOD);
      }
    } catch (error) {
      console.error('[Quiz WS] Error handling disconnect:', error);
    }
  }

  // Cancel host disconnect timer when host reconnects
  cancelHostDisconnectTimer(gameId: string): void {
    const timer = this.hostDisconnectTimers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.hostDisconnectTimers.delete(gameId);
      console.log(`[Quiz WS] Cancelled host disconnect timer for game ${gameId}`);
    }
  }

  // ==================== MESSAGE HANDLERS ====================

  private async handleJoin(connectionId: string, ws: WebSocket, data: any): Promise<void> {
    const { gameId, playerName, playerAvatar, isHost } = data;

    console.log(`[Quiz WS] handleJoin: gameId=${gameId}, playerName=${playerName}, isHost=${isHost}, connectionId=${connectionId}`);

    try {
      const game = await this.quizGame.getGame(gameId);
      console.log(`[Quiz WS] Game found:`, game ? `state=${game.state}` : 'null');
      if (!game) {
        this.sendMessage(ws, { type: 'quiz:error', data: { error: 'GAME_NOT_FOUND', message: 'Game not found' } });
        return;
      }

      // Check if game has already started and not host
      // Allow reconnection for existing players (addPlayer handles this)
      if (game.state !== 'lobby' && !isHost) {
        // Check if player can reconnect (same name exists)
        const existingPlayers = await this.quizGame.getPlayers(gameId);
        const canReconnect = existingPlayers.some(p => p.name.toLowerCase() === playerName.toLowerCase());
        if (!canReconnect) {
          this.sendMessage(ws, { type: 'quiz:gameInProgress', data: { messageKey: 'quiz.gameAlreadyStarted' } });
          return;
        }
        console.log(`[Quiz WS] Player ${playerName} reconnecting to in-progress game`);
      }

      // Add player to quiz game
      const player = await this.quizGame.addPlayer(gameId, connectionId, playerName, playerAvatar, isHost);

      // Update host connection ID if this is the host
      if (isHost) {
        // Cancel any pending host disconnect timer (host is reconnecting)
        this.cancelHostDisconnectTimer(gameId);

        // Broadcast host reconnected via Redis so other workers cancel their timers
        this.broadcaster.publishRedisEvent(`quiz:${gameId}`, 'quiz:hostReconnected', { gameId });

        game.hostConnectionId = connectionId;
        await this.quizGame.updateGame(gameId, game);
      } else {
        // Broadcast player reconnected via Redis so other workers don't remove them
        this.broadcaster.publishRedisEvent(`quiz:${gameId}`, 'quiz:playerReconnected', {
          gameId,
          playerName: playerName.toLowerCase()
        });
      }

      // Store connection info
      const connection: QuizPlayerConnection = {
        id: connectionId,
        ws,
        gameId,
        playerName,
        playerAvatar,
        isHost,
        isAlive: true,
      };
      this.connections.set(connectionId, connection);
      console.log(`[Quiz WS] Stored connection ${connectionId} for ${playerName} (isHost=${isHost})`);

      // Add to quiz connections
      if (!this.quizConnections.has(gameId)) {
        this.quizConnections.set(gameId, new Set());
        console.log(`[Quiz WS] Created new quizConnections Set for game ${gameId}`);
      }
      this.quizConnections.get(gameId)!.add(connectionId);
      console.log(`[Quiz WS] Added ${connectionId} to quizConnections for game ${gameId}, total connections: ${this.quizConnections.get(gameId)!.size}`);

      // Get all players
      const players = await this.quizGame.getPlayers(gameId);

      // Get additional game data for reconnection
      let timerEndTime: number | null = null;
      let leaderboard: any[] = [];

      // If game is in progress, include timer and leaderboard data
      if (game.state === 'round_active') {
        const endTimeStr = await this.quizGame['redis'].get(`quiz:game:${gameId}:roundEndTime`);
        if (endTimeStr) {
          timerEndTime = parseInt(endTimeStr, 10);
        }
      }

      if (['round_results', 'leaderboard', 'finished'].includes(game.state)) {
        const leaderboardData = await this.quizGame.getLeaderboard(gameId);
        leaderboard = this.formatLeaderboard(leaderboardData);
      }

      // Send game data to the new/reconnecting player
      this.sendMessage(ws, {
        type: 'quiz:gameData',
        data: {
          gameId: game.id,
          phpId: game.phpId,
          state: game.state,
          settings: game.settings,
          currentRound: game.currentRound,
          players: this.formatPlayers(players),
          isHost,
          playerId: connectionId,
          // Reconnection data
          timerEndTime,
          leaderboard,
        },
      });

      // Notify all other players (including host)
      console.log(`[Quiz WS] Broadcasting playerJoined to game ${gameId}, excluding ${connectionId}`);
      console.log(`[Quiz WS] quizConnections for game:`, this.quizConnections.get(gameId));
      this.broadcastToGame(gameId, 'quiz:playerJoined', {
        players: this.formatPlayers(players),
        count: players.length,
        newPlayer: { name: playerName, avatar: playerAvatar },
      }, connectionId);

    } catch (error: any) {
      const errorCode = error.message || 'UNKNOWN_ERROR';
      this.sendMessage(ws, { type: 'quiz:error', data: { error: errorCode, message: error.message } });
    }
  }

  private async handleStart(connectionId: string, data: any): Promise<void> {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isHost) {
      if (connection) {
        this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: 'NOT_HOST', message: 'Only the host can start the game' } });
      }
      return;
    }

    try {
      await this.quizGame.startGame(gameId, connectionId);
      const game = await this.quizGame.getGame(gameId);
      const players = await this.quizGame.getPlayers(gameId);

      this.broadcastToGame(gameId, 'quiz:gameStarted', {
        settings: game?.settings,
        playerCount: players.length,
        messageKey: 'quiz.gameStartedWaitingForCard',
      });

    } catch (error: any) {
      this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: error.message } });
    }
  }

  private async handleAnswer(connectionId: string, data: any): Promise<void> {
    const { gameId, artist, title, year } = data;
    const connection = this.connections.get(connectionId);

    if (!connection) return;

    const answer: QuizAnswer = {
      artist: artist || '',
      title: title || '',
      year: year !== null && year !== undefined ? Number(year) : null,
      submittedAt: Date.now(),
    };

    try {
      const submitted = await this.quizGame.submitAnswer(gameId, connectionId, answer);

      if (!submitted) {
        this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: 'ALREADY_SUBMITTED', message: 'Answer already submitted or round not active' } });
        return;
      }

      // Notify all players that this player submitted
      const { submitted: submittedCount, total } = await this.quizGame.getSubmittedCount(gameId);
      const player = await this.quizGame.getPlayer(gameId, connectionId);

      this.broadcastToGame(gameId, 'quiz:playerSubmitted', {
        playerId: connectionId,
        playerName: player?.name || 'Unknown',
        submittedCount,
        totalPlayers: total,
      });

      // Check if all players have submitted
      if (await this.quizGame.allPlayersSubmitted(gameId)) {
        await this.calculateAndBroadcastResults(gameId);
      }

    } catch (error: any) {
      this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: error.message } });
    }
  }

  private async handleShowResults(connectionId: string, data: any): Promise<void> {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isHost) return;

    try {
      await this.calculateAndBroadcastResults(gameId);
    } catch (error: any) {
      this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: error.message } });
    }
  }

  private async handleShowLeaderboard(connectionId: string, data: any): Promise<void> {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isHost) return;

    try {
      await this.quizGame.showLeaderboard(gameId);
      const leaderboard = await this.quizGame.getLeaderboard(gameId);

      this.broadcastToGame(gameId, 'quiz:leaderboard', {
        leaderboard: this.formatLeaderboard(leaderboard),
      });
    } catch (error: any) {
      this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: error.message } });
    }
  }

  private async handleEnd(connectionId: string, data: any): Promise<void> {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isHost) return;

    try {
      // Check if game is still in lobby or waiting for scan (host clicked back/exit)
      const game = await this.quizGame.getGame(gameId);
      const wasInLobby = game?.state === 'lobby';
      const wasWaitingForScan = game?.state === 'playing'; // Waiting for host to scan a card

      const finalLeaderboard = await this.quizGame.endGame(gameId);

      if (wasInLobby) {
        // Game cancelled from lobby - kick all players
        this.broadcastToGame(gameId, 'quiz:gameCancelled', {
          messageKey: 'quiz.hostCancelledGame',
        });
      } else if (wasWaitingForScan) {
        // Host exited while waiting for scan - send players back to join screen
        this.broadcastToGame(gameId, 'quiz:gameReset', {
          messageKey: 'quiz.hostResetGame',
        });
      } else {
        // Normal game end with results
        const topThree = finalLeaderboard.slice(0, 3);

        this.broadcastToGame(gameId, 'quiz:finalResults', {
          topThree: topThree.map((p, index) => ({
            rank: index + 1,
            id: p.id,
            name: p.name,
            avatar: p.avatar,
            score: p.score,
            artistPoints: p.artistPoints,
            titlePoints: p.titlePoints,
            yearPoints: p.yearPoints,
          })),
          allPlayers: finalLeaderboard.map((p, index) => ({
            rank: index + 1,
            id: p.id,
            name: p.name,
            avatar: p.avatar,
            score: p.score,
            isHost: p.isHost,
          })),
        });
      }

    } catch (error: any) {
      this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: error.message } });
    }
  }

  private async handleRestart(connectionId: string, data: any): Promise<void> {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isHost) return;

    try {
      await this.quizGame.restartGame(gameId);
      const game = await this.quizGame.getGame(gameId);
      const players = await this.quizGame.getPlayers(gameId);

      this.broadcastToGame(gameId, 'quiz:gameRestarted', {
        settings: game?.settings,
        players: this.formatPlayers(players),
        messageKey: 'quiz.gameRestartedWaitingForCard',
      });

    } catch (error: any) {
      this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: error.message } });
    }
  }

  private async handleOverrideAnswer(connectionId: string, data: any): Promise<void> {
    const { gameId, playerId, field, correct } = data;
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isHost) return;

    try {
      const result = await this.quizGame.overrideAnswer(gameId, playerId, field, correct);

      if (!result) {
        this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: 'PLAYER_NOT_FOUND', message: 'Player not found' } });
        return;
      }

      const player = await this.quizGame.getPlayer(gameId, playerId);

      this.broadcastToGame(gameId, 'quiz:answerOverridden', {
        playerId,
        playerName: player?.name || 'Unknown',
        field,
        newCorrect: correct,
        pointsDelta: result.pointsDelta,
        newTotalScore: result.newTotalScore,
      });

    } catch (error: any) {
      this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: error.message } });
    }
  }

  private async handleUpdateSettings(connectionId: string, data: any): Promise<void> {
    const { gameId, settings } = data;
    const connection = this.connections.get(connectionId);

    if (!connection || !connection.isHost) return;

    try {
      const game = await this.quizGame.getGame(gameId);
      if (!game || game.state !== 'lobby') {
        this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: 'INVALID_STATE', message: 'Cannot update settings after game started' } });
        return;
      }

      // Update settings
      if (settings.maxPlayers !== undefined) {
        game.settings.maxPlayers = Math.min(settings.maxPlayers, 100);
      }
      if (settings.roundTimer !== undefined) {
        game.settings.roundTimer = Math.max(15, Math.min(settings.roundTimer, 90));
      }
      if (settings.totalRounds !== undefined) {
        game.settings.totalRounds = settings.totalRounds;
      }
      if (settings.yearTolerance !== undefined) {
        game.settings.yearTolerance = Math.max(0, Math.min(settings.yearTolerance, 10));
      }
      if (settings.hostPlays !== undefined) {
        game.settings.hostPlays = settings.hostPlays;
      }

      await this.quizGame.updateGame(gameId, game);

      this.broadcastToGame(gameId, 'quiz:settingsUpdated', {
        settings: game.settings,
      });

    } catch (error: any) {
      this.sendMessage(connection.ws, { type: 'quiz:error', data: { error: error.message } });
    }
  }

  // ==================== HELPER METHODS ====================

  private async calculateAndBroadcastResults(gameId: string): Promise<void> {
    const results = await this.quizGame.calculateRoundResults(gameId);

    this.broadcastToGame(gameId, 'quiz:roundResults', {
      track: results.track,
      answers: results.answers,
      leaderboard: this.formatLeaderboard(results.leaderboard),
    });
  }

  private formatPlayers(players: QuizPlayer[]): any[] {
    return players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      isHost: p.isHost,
      hasSubmitted: p.hasSubmitted,
    }));
  }

  private formatLeaderboard(players: QuizPlayer[]): any[] {
    return players.map((p, index) => ({
      rank: index + 1,
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      artistPoints: p.artistPoints,
      titlePoints: p.titlePoints,
      yearPoints: p.yearPoints,
      isHost: p.isHost,
    }));
  }

  private sendMessage(ws: WebSocket, message: { type: string; data?: any }): void {
    this.broadcaster.sendMessage(ws, message);
  }

  private broadcastToGame(gameId: string, type: string, data: any, excludeConnectionId?: string): void {
    const message = { type, data };

    // Broadcast to local connections
    const quizConnectionIds = this.quizConnections.get(gameId);
    console.log(`[Quiz WS] broadcastToGame ${type} to ${gameId}, connections:`, quizConnectionIds?.size || 0);
    if (quizConnectionIds) {
      for (const connId of quizConnectionIds) {
        if (connId !== excludeConnectionId) {
          const connection = this.connections.get(connId);
          console.log(`[Quiz WS] Sending ${type} to ${connId}, ws open: ${connection?.ws.readyState === WebSocket.OPEN}, isHost: ${connection?.isHost}`);
          if (connection && connection.ws.readyState === WebSocket.OPEN) {
            this.sendMessage(connection.ws, message);
          }
        } else {
          console.log(`[Quiz WS] Skipping ${connId} (excluded)`);
        }
      }
    }

    // Publish to Redis for other servers
    this.broadcaster.publishRedisEvent(`quiz:${gameId}`, type, data, excludeConnectionId);
  }

  // ==================== PUBLIC METHODS FOR EXTERNAL TRIGGERS ====================

  // Track pending player disconnect timers (player name -> timeout)
  private playerDisconnectTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Handle Redis events for quiz games (called from websocket-native.ts)
   * Only broadcasts to local connections, does NOT re-publish to Redis
   */
  handleRedisEvent(gameId: string, type: string, data: any, excludeConnectionId?: string): void {
    // Handle special events that need local processing (don't broadcast to clients)
    if (type === 'quiz:hostReconnected') {
      // Cancel any pending host disconnect timer on this worker
      this.cancelHostDisconnectTimer(gameId);
      console.log(`[Quiz WS] Received hostReconnected event for game ${gameId}, cancelled local timer`);
      return;
    }

    if (type === 'quiz:playerReconnected') {
      // Mark that this player reconnected (other workers will see this)
      // The player disconnect logic uses Redis locks, so this is just for logging
      console.log(`[Quiz WS] Received playerReconnected event for game ${gameId}, player ${data.playerName}`);
      return;
    }

    console.log(`[Quiz WS] handleRedisEvent: gameId=${gameId}, type=${type}`);
    // Only broadcast to local connections, don't re-publish to Redis
    this.broadcastToLocalConnections(gameId, type, data, excludeConnectionId);
  }

  private broadcastToLocalConnections(gameId: string, type: string, data: any, excludeConnectionId?: string): void {
    const message = { type, data };
    const quizConnectionIds = this.quizConnections.get(gameId);

    if (quizConnectionIds) {
      for (const connId of quizConnectionIds) {
        if (connId !== excludeConnectionId) {
          const connection = this.connections.get(connId);
          if (connection && connection.ws.readyState === WebSocket.OPEN) {
            this.sendMessage(connection.ws, message);
          }
        }
      }
    }
  }

  /**
   * Trigger a quiz round from external source (card scan via handleCardScan in QuizCardGame)
   * This is called when the card scan workflow needs to broadcast to connected clients
   */
  async triggerRound(gameId: string, round: number, timerDuration: number): Promise<void> {
    // Broadcast countdown start
    this.broadcastToGame(gameId, 'quiz:countdown', {
      round,
      countdownSeconds: 3,
      messageKey: 'quiz.cardScannedGetReady',
    });

    // After 3 seconds, start the actual round timer
    setTimeout(async () => {
      const timing = await this.quizGame.startRoundTimer(gameId);

      this.broadcastToGame(gameId, 'quiz:roundStart', {
        round,
        serverTime: Date.now(),
        endTime: timing.endTime,
        duration: timing.duration,
        messageKey: 'quiz.enterYourAnswers',
      });

      // Set up auto-end timer
      setTimeout(async () => {
        const game = await this.quizGame.getGame(gameId);
        if (game && game.state === 'round_active') {
          await this.calculateAndBroadcastResults(gameId);
        }
      }, timing.duration * 1000);

    }, 3000);
  }

  // Check if game has any connections
  hasConnections(gameId: string): boolean {
    const connections = this.quizConnections.get(gameId);
    return connections !== undefined && connections.size > 0;
  }

  // Mark a connection as alive (called on pong response)
  markConnectionAlive(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.isAlive = true;
    }
  }

  // Check all connections for heartbeat and disconnect dead ones
  checkHeartbeat(onDisconnect: (connectionId: string) => void): void {
    this.connections.forEach((connection, connectionId) => {
      if (!connection.isAlive) {
        // Connection failed to respond to ping
        connection.ws.terminate();
        onDisconnect(connectionId);
      } else {
        connection.isAlive = false;
        connection.ws.ping();
      }
    });
  }
}

export default QuizCardGame;
