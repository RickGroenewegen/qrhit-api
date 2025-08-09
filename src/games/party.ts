import Game from '../game';
import { fuzzy } from 'fast-fuzzy';

export interface Question {
  type: 'artist' | 'word-count' | 'song' | 'year' | 'decade' | 'earlier-later';
  text: string;
  correctAnswer: string | number | boolean;
  referenceYear?: number; // For earlier-later questions
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

  // Get the next question type without generating the full question
  async getNextQuestionType(gameId: string): Promise<string> {
    // Get game settings to retrieve selected round types
    const gameData = await this.game.getGame(gameId);
    const selectedTypes = gameData?.settings?.roundTypes || ['artist', 'word-count', 'song', 'year', 'decade', 'earlier-later'];
    
    
    // Define the server's preferred order
    const serverOrder: ('artist' | 'word-count' | 'song' | 'year' | 'decade' | 'earlier-later')[] = ['artist', 'word-count', 'song', 'year', 'decade', 'earlier-later'];
    
    // Filter server order to only include selected types
    const questionTypes = serverOrder.filter(type => selectedTypes.includes(type));
    
    // Fallback if no valid types
    const finalTypes = questionTypes.length > 0 ? questionTypes : serverOrder;
    
    
    // Get current question type index from Redis
    const currentIndex = await this.game.getQuestionTypeIndex(gameId);
    const type = finalTypes[currentIndex % finalTypes.length];
    
    
    return type;
  }

  // Generate a cycled question type
  async generateQuestion(track: any, gameId: string): Promise<Question> {
    // Get game settings to retrieve selected round types
    const gameData = await this.game.getGame(gameId);
    const selectedTypes = gameData?.settings?.roundTypes || ['artist', 'word-count', 'song', 'year', 'decade', 'earlier-later'];
    
    
    // Define the server's preferred order
    const serverOrder: ('artist' | 'word-count' | 'song' | 'year' | 'decade' | 'earlier-later')[] = ['artist', 'word-count', 'song', 'year', 'decade', 'earlier-later'];
    
    // Filter server order to only include selected types
    const questionTypes = serverOrder.filter(type => selectedTypes.includes(type));
    
    // Fallback if no valid types
    const finalTypes = questionTypes.length > 0 ? questionTypes : serverOrder;
    
    
    // Get current question type index from Redis
    const currentIndex = await this.game.getQuestionTypeIndex(gameId);
    const type = finalTypes[currentIndex % finalTypes.length];
    
    // Update index for next question (cycle through selected types)
    await this.game.setQuestionTypeIndex(gameId, (currentIndex + 1) % finalTypes.length);
    
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
      
      case 'earlier-later':
        // Generate a reference year that's 1-3 years before or after the actual year
        const actualYear = track.year || 1990;
        const offset = Math.floor(Math.random() * 3) + 1; // 1, 2, or 3
        const direction = Math.random() < 0.5 ? -1 : 1; // Before or after
        const referenceYear = actualYear + (offset * direction);
        
        // The answer is true if the song is earlier than the reference year
        const isEarlier = actualYear < referenceYear;
        
        question = {
          type: 'earlier-later',
          text: 'wasReleasedEarlierOrLater',
          correctAnswer: isEarlier, // true = earlier, false = later
          referenceYear: referenceYear
        };
        break;
      
      case 'word-count':
        // Count words in the song title
        // Split by whitespace and filter out empty strings
        const words = track.name.split(/\s+/).filter((word: string) => word.trim().length > 0);
        const wordCount = words.length;
        
        
        question = {
          type: 'word-count',
          text: 'howManyWordsInTitle',
          correctAnswer: wordCount
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
        // Reject empty answers immediately
        if (!normalizedAnswer || normalizedAnswer.length === 0) {
          return {
            isCorrect: false,
            points: 0
          };
        }
        
        // Use fuzzy matching for text answers
        const correctAnswer = question.correctAnswer.toString().toLowerCase();
        const similarity = fuzzy(normalizedAnswer, correctAnswer);
        
        // For partial matches, check if the answer is too short compared to the correct answer
        const answerWordCount = normalizedAnswer.split(/\s+/).filter(w => w.length > 0).length;
        const correctWordCount = correctAnswer.split(/\s+/).filter(w => w.length > 0).length;
        
        // If the answer has significantly fewer words than the correct answer, require higher similarity
        let requiredSimilarity = 0.85; // Base threshold increased from 0.8
        if (correctWordCount > 1 && answerWordCount < correctWordCount) {
          // For multi-word correct answers, penalize partial answers
          requiredSimilarity = Math.min(0.95, 0.85 + (0.1 * (correctWordCount - answerWordCount)));
        }
        
        // Also check minimum length ratio to prevent very short answers from matching
        const lengthRatio = normalizedAnswer.length / correctAnswer.length;
        
        // Consider correct if similarity is above threshold AND length ratio is reasonable
        const isTextCorrect = similarity > requiredSimilarity && lengthRatio > 0.6;
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
      
      case 'earlier-later':
        // For earlier-later questions, the answer should be 'earlier' or 'later'
        const normalizedEarlierLater = normalizedAnswer.toLowerCase();
        const correctEarlierLater = question.correctAnswer === true;
        
        // Check if the answer matches
        let isEarlierLaterCorrect = false;
        if ((normalizedEarlierLater === 'earlier' || normalizedEarlierLater === 'before') && correctEarlierLater) {
          isEarlierLaterCorrect = true;
        } else if ((normalizedEarlierLater === 'later' || normalizedEarlierLater === 'after') && !correctEarlierLater) {
          isEarlierLaterCorrect = true;
        }
        
        return {
          isCorrect: isEarlierLaterCorrect,
          points: isEarlierLaterCorrect ? 1 : 0
        };
      
      case 'word-count':
        const correctCount = Number(question.correctAnswer);
        const answerCount = Number(answer);
        
        if (isNaN(answerCount)) {
          return { isCorrect: false, points: 0 };
        }
        
        const isCountCorrect = correctCount === answerCount;
        return {
          isCorrect: isCountCorrect,
          points: isCountCorrect ? 1 : 0
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

    // Format correct answer based on question type
    let formattedCorrectAnswer = question.correctAnswer.toString();
    if (question.type === 'earlier-later') {
      formattedCorrectAnswer = question.correctAnswer === true ? 'earlier' : 'later';
    }
    
    return {
      question,
      answers: results,
      correctAnswer: formattedCorrectAnswer
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