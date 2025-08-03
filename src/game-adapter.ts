import Game from './game';
import PartyGame from './games/party';

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
  settings: {
    numberOfRounds: number;
    roundCountdown?: number;
    roundTypes?: string[];
    playlistIds?: number[];
    userHash?: string;
  };
  players: Player[];
  currentRound: number;
  totalRounds?: number;
  roundCountdown?: number;
  state: 'waiting' | 'playing' | 'finished';
  createdAt: number;
}

/**
 * Adapter class that provides the methods needed by WebSocket server
 * while using the existing Game class functionality
 */
export class GameAdapter {
  private game: Game;
  private partyGame: PartyGame;

  constructor() {
    this.game = new Game();
    this.partyGame = new PartyGame();
  }

  // Add player to game
  async addPlayer(gameId: string, playerId: string, playerName: string, isHost: boolean): Promise<Player[]> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) {
      throw new Error('Game not found');
    }

    // Check if player already exists
    const existingPlayerIndex = gameData.players.findIndex(p => p.name === playerName);
    if (existingPlayerIndex !== -1) {
      // Update existing player
      gameData.players[existingPlayerIndex].id = playerId;
      gameData.players[existingPlayerIndex].isHost = isHost;
    } else {
      // Add new player
      gameData.players.push({
        id: playerId,
        name: playerName,
        avatar: undefined,
        score: 0,
        isHost: isHost,
        hasSubmitted: false
      });
    }

    await this.game.updateGame(gameId, gameData);
    return gameData.players;
  }

  // Get game data with additional fields
  async getGameData(gameId: string): Promise<GameData | null> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return null;

    // Add computed fields
    return {
      ...gameData,
      totalRounds: gameData.settings.numberOfRounds,
      roundCountdown: gameData.settings.roundCountdown || 30
    };
  }

  // Get players list
  async getPlayers(gameId: string): Promise<Player[]> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return [];
    return gameData.players;
  }

  // Update player ID (for reconnection)
  async updatePlayerId(gameId: string, oldPlayerId: string, newPlayerId: string): Promise<void> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return;

    const player = gameData.players.find(p => p.id === oldPlayerId);
    if (player) {
      player.id = newPlayerId;
      await this.game.updateGame(gameId, gameData);
    }
  }

  // Start game
  async startGame(gameId: string): Promise<void> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return;

    gameData.state = 'playing';
    gameData.currentRound = 1;
    await this.game.updateGame(gameId, gameData);

    // Prewarm cache
    await this.game.prewarmGameCache(gameId);
  }

  // Update player score
  async updatePlayerScore(gameId: string, playerId: string, points: number): Promise<void> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return;

    const player = gameData.players.find(p => p.id === playerId);
    if (player) {
      player.score += points;
      await this.game.updateGame(gameId, gameData);
    }
  }

  // Get leaderboard (sorted players)
  async getLeaderboard(gameId: string): Promise<Player[]> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return [];

    return [...gameData.players].sort((a, b) => b.score - a.score);
  }

  // Update game round
  async updateGameRound(gameId: string, round: number): Promise<void> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return;

    gameData.currentRound = round;
    await this.game.updateGame(gameId, gameData);
  }

  // Get top players
  async getTopPlayers(gameId: string, limit: number): Promise<Player[]> {
    const leaderboard = await this.getLeaderboard(gameId);
    return leaderboard.slice(0, limit);
  }

  // Reset game
  async resetGame(gameId: string): Promise<void> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return;

    // Reset all player scores
    gameData.players.forEach(player => {
      player.score = 0;
      player.hasSubmitted = false;
    });

    gameData.currentRound = 0;
    gameData.state = 'waiting';
    
    await this.game.updateGame(gameId, gameData);
  }

  // End game
  async endGame(gameId: string): Promise<void> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return;

    gameData.state = 'finished';
    await this.game.updateGame(gameId, gameData);
  }

  // Remove player
  async removePlayer(gameId: string, playerId: string): Promise<Player[]> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return [];

    gameData.players = gameData.players.filter(p => p.id !== playerId);
    await this.game.updateGame(gameId, gameData);
    
    return gameData.players;
  }

  // Expose methods from PartyGame
  async getRandomQuestion(gameId: string): Promise<any> {
    // Get random track
    const track = await this.game.getRandomTrack(gameId);
    if (!track) {
      throw new Error('No tracks available');
    }

    // Generate question
    const question = await this.partyGame.generateQuestion(track, gameId);

    return {
      question,
      track
    };
  }

  async calculateResults(gameId: string, question: any, track: any, answers: Record<string, string>): Promise<any> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) return { answers: [], scores: {}, correctAnswer: '' };

    const playerAnswers: any[] = [];
    const scores: Record<string, number> = {};

    // Process each answer
    const answerResults = [];
    for (const [playerId, answer] of Object.entries(answers)) {
      const player = gameData.players.find(p => p.id === playerId);
      if (!player) continue;

      const result = this.partyGame.checkAnswer(question, answer);
      answerResults.push({
        playerId,
        answer,
        distance: result.distance || 0
      });

      playerAnswers.push({
        playerName: player.name,
        avatar: player.avatar,
        answer: answer,
        isCorrect: result.isCorrect,
        points: result.points,
        yearDifference: result.distance
      });
    }

    // Special handling for year questions
    if (question.type === 'year' && answerResults.length > 0) {
      const yearPoints = this.partyGame.calculateYearPoints(answerResults);
      for (const [playerId, points] of yearPoints) {
        scores[playerId] = points;
        const playerAnswer = playerAnswers.find(pa => {
          const player = gameData.players.find(p => p.id === playerId);
          return player && pa.playerName === player.name;
        });
        if (playerAnswer) {
          playerAnswer.points = points;
          playerAnswer.isCorrect = points > 0;
        }
      }
    } else {
      // For other question types, use the points from checkAnswer
      for (const [playerId, answer] of Object.entries(answers)) {
        const player = gameData.players.find(p => p.id === playerId);
        if (!player) continue;

        const result = this.partyGame.checkAnswer(question, answer);
        scores[playerId] = result.points;
      }
    }

    // Format correct answer
    let correctAnswer = question.correctAnswer.toString();
    if (question.type === 'earlier-later') {
      correctAnswer = question.correctAnswer ? 'Earlier' : 'Later';
    }

    return {
      answers: playerAnswers,
      scores,
      correctAnswer
    };
  }

  // Expose original Game methods
  getGame(gameId: string) {
    return this.game.getGame(gameId);
  }

  updateGame(gameId: string, gameData: any) {
    return this.game.updateGame(gameId, gameData);
  }

  prewarmGameCache(gameId: string) {
    return this.game.prewarmGameCache(gameId);
  }
}