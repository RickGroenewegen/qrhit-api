import Game from '../game';
import { fuzzy } from 'fast-fuzzy';

export interface Question {
  type: 'artist' | 'song' | 'year' | 'decade';
  text: string;
  correctAnswer: string | number;
}

export interface PlayerAnswer {
  playerId: string;
  playerName: string;
  playerAvatar?: string;
  answer: string;
  isCorrect: boolean;
  points: number;
  distance?: number; // For year questions
}

export interface RoundResult {
  question: Question;
  answers: PlayerAnswer[];
  correctAnswer: string;
}

class PartyGame {
  private game: Game;

  constructor() {
    this.game = new Game();
  }

  // Generate a cycled question type
  async generateQuestion(track: any, gameId: string): Promise<Question> {
    const questionTypes: ('artist' | 'song' | 'year' | 'decade')[] = ['artist', 'song', 'year', 'decade'];
    
    // Get current question type index from Redis
    const currentIndex = await this.game.getQuestionTypeIndex(gameId);
    const type = questionTypes[currentIndex];
    
    // Update index for next question (cycle through 0, 1, 2, 3)
    await this.game.setQuestionTypeIndex(gameId, (currentIndex + 1) % questionTypes.length);
    
    let question: Question;
    
    switch (type) {
      case 'artist':
        question = {
          type: 'artist',
          text: 'whatIsTheArtist',
          correctAnswer: track.artist
        };
        break;
      
      case 'song':
        question = {
          type: 'song',
          text: 'whatIsTheSong',
          correctAnswer: track.name
        };
        break;
      
      case 'year':
        question = {
          type: 'year',
          text: 'whatIsTheYear',
          correctAnswer: track.year || 1990
        };
        break;
      
      case 'decade':
        question = {
          type: 'decade',
          text: 'whatIsTheDecade',
          correctAnswer: track.decade || 1990
        };
        break;
    }
    
    return question;
  }

  // Check if answer is correct based on question type
  checkAnswer(question: Question, answer: string): { isCorrect: boolean; points: number; distance?: number } {
    const normalizedAnswer = answer.trim().toLowerCase();
    
    switch (question.type) {
      case 'artist':
      case 'song':
        // Use fuzzy matching for text answers
        const correctAnswer = question.correctAnswer.toString().toLowerCase();
        const similarity = fuzzy(normalizedAnswer, correctAnswer);
        
        // Consider correct if similarity is above 0.8 (80%)
        const isTextCorrect = similarity > 0.8;
        return {
          isCorrect: isTextCorrect,
          points: isTextCorrect ? 1 : 0
        };
      
      case 'year':
        const correctYear = Number(question.correctAnswer);
        const answerYear = Number(answer);
        
        if (isNaN(answerYear)) {
          return { isCorrect: false, points: 0, distance: 9999 };
        }
        
        const distance = Math.abs(correctYear - answerYear);
        
        // Points will be calculated later based on who is closest
        // For now, just return the distance
        return { 
          isCorrect: distance === 0, 
          points: 0, // Will be calculated in calculateYearPoints
          distance 
        };
      
      case 'decade':
        const correctDecade = Number(question.correctAnswer);
        const answerDecade = Number(answer);
        
        if (isNaN(answerDecade)) {
          return { isCorrect: false, points: 0 };
        }
        
        const isDecadeCorrect = correctDecade === answerDecade;
        return {
          isCorrect: isDecadeCorrect,
          points: isDecadeCorrect ? 1 : 0
        };
      
      default:
        return { isCorrect: false, points: 0 };
    }
  }

  // Calculate points for year questions with multiple players
  calculateYearPoints(answers: Array<{ playerId: string; answer: string; distance: number }>): Map<string, number> {
    const pointsMap = new Map<string, number>();
    
    // Sort by distance (closest first)
    const sortedAnswers = answers
      .filter(a => a.distance !== undefined)
      .sort((a, b) => a.distance - b.distance);
    
    if (sortedAnswers.length === 0) {
      return pointsMap;
    }
    
    // Find the closest distance
    const closestDistance = sortedAnswers[0].distance;
    
    // Award 1 point to all players with the closest distance (handles ties)
    for (const answer of sortedAnswers) {
      if (answer.distance === closestDistance) {
        pointsMap.set(answer.playerId, 1);
      } else {
        // No points for answers that aren't the closest
        pointsMap.set(answer.playerId, 0);
      }
    }
    
    return pointsMap;
  }

  // Process round results
  async processRoundResults(
    gameId: string,
    question: Question,
    playerAnswers: Map<string, string>
  ): Promise<RoundResult> {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) {
      throw new Error('Game not found');
    }

    const results: PlayerAnswer[] = [];
    const yearAnswers: Array<{ playerId: string; answer: string; distance: number }> = [];

    // Check each player's answer
    for (const [playerId, answer] of playerAnswers) {
      const player = gameData.players.find(p => p.id === playerId);
      if (!player) continue;

      const result = this.checkAnswer(question, answer);
      
      if (question.type === 'year' && result.distance !== undefined) {
        yearAnswers.push({ playerId, answer, distance: result.distance });
      }

      results.push({
        playerId,
        playerName: player.name,
        playerAvatar: player.avatar,
        answer,
        isCorrect: result.isCorrect,
        points: result.points,
        distance: result.distance
      });
    }

    // For year questions, recalculate points based on ranking
    if (question.type === 'year' && yearAnswers.length > 0) {
      const yearPoints = this.calculateYearPoints(yearAnswers);
      
      for (const result of results) {
        const points = yearPoints.get(result.playerId);
        if (points !== undefined) {
          result.points = points;
        }
      }
    }

    // Update player scores
    for (const result of results) {
      const player = gameData.players.find(p => p.id === result.playerId);
      if (player) {
        player.score += result.points;
      }
    }

    // Update game data
    await this.game.updateGame(gameId, gameData);

    return {
      question,
      answers: results,
      correctAnswer: question.correctAnswer.toString()
    };
  }

  // Get leaderboard
  async getLeaderboard(gameId: string) {
    const gameData = await this.game.getGame(gameId);
    if (!gameData) {
      throw new Error('Game not found');
    }

    // Sort players by score (descending)
    const leaderboard = [...gameData.players].sort((a, b) => b.score - a.score);
    
    return leaderboard;
  }

  // Get final results (top 3 players)
  async getFinalResults(gameId: string) {
    const leaderboard = await this.getLeaderboard(gameId);
    return leaderboard.slice(0, 3);
  }

}

export default PartyGame;