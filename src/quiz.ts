import Logger from './logger';
import PrismaInstance from './prisma';
import Translation from './translation';
import { color, white } from 'console-log-colors';

export const MAX_AI_QUIZZES_PER_WEEK = 3;
export const MAX_QUESTIONS = 100;

export type QuestionType = 'year' | 'trivia' | 'artist' | 'title' | 'missing_word' | 'release_order' | 'decade';

export interface TrackWithType {
  trackId: number;
  name: string;
  artist: string;
  year: number;
  type: QuestionType;
}

export interface ReleaseOrderOption {
  label: string;
  year: number;
}

export interface GeneratedQuestion {
  trackId: number;
  type: string;
  question: string;
  options: string[] | ReleaseOrderOption[] | null;
  correctAnswer: string;
}

export interface TrackRow {
  id: number;
  trackId: string;
  name: string;
  artist: string;
  year: number | null;
  trackOrder: number;
}

class Quiz {
  private static instance: Quiz;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private translation = new Translation();
  private isDevelopment = process.env['ENVIRONMENT'] === 'development';

  private constructor() {}

  public static getInstance(): Quiz {
    if (!Quiz.instance) {
      Quiz.instance = new Quiz();
    }
    return Quiz.instance;
  }

  /**
   * Fisher-Yates shuffle algorithm
   */
  public shuffle<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Filter tracks by selected track IDs (ISRCs)
   */
  public filterSelectedTracks(
    tracks: TrackRow[],
    selectedTrackIds: string[]
  ): TrackRow[] {
    const selectedSet = new Set(selectedTrackIds);
    return tracks.filter((t) => selectedSet.has(t.trackId));
  }

  /**
   * Assign question types to tracks, cycling through the given types
   * while avoiding consecutive duplicates and ensuring missing_word
   * only applies to titles with 3+ words.
   */
  public assignQuestionTypes(
    tracks: TrackRow[],
    questionTypes?: string[]
  ): TrackWithType[] {
    const types: QuestionType[] =
      questionTypes && questionTypes.length > 0
        ? (questionTypes as QuestionType[])
        : ['year', 'trivia', 'artist', 'title', 'missing_word', 'release_order', 'decade'];

    let typeIndex = 0;
    let lastType: string | null = null;

    return tracks.map((track) => {
      let type = types[typeIndex % types.length];
      typeIndex++;

      // missing_word requires at least 3 words in the title
      if (type === 'missing_word' && track.name.trim().split(/\s+/).length < 3) {
        for (let attempt = 0; attempt < types.length; attempt++) {
          const candidate = types[(typeIndex + attempt) % types.length];
          if (candidate !== 'missing_word' && candidate !== lastType) {
            type = candidate;
            break;
          }
        }
        if (type === 'missing_word') type = 'trivia';
      }

      // release_order and decade require a valid year
      if ((type === 'release_order' || type === 'decade') && !track.year) {
        type = types.find((t) => t !== 'release_order' && t !== 'decade' && t !== lastType) || 'trivia';
      }

      // Avoid consecutive duplicates
      if (type === lastType && types.length > 1) {
        type = types[typeIndex % types.length];
        typeIndex++;
        if (type === 'missing_word' && track.name.trim().split(/\s+/).length < 3) {
          type = types.find((t) => t !== 'missing_word' && t !== lastType) || 'trivia';
        }
      }

      lastType = type;
      return {
        trackId: track.id,
        name: track.name,
        artist: track.artist,
        year: track.year || 2000,
        type,
      };
    });
  }

  /**
   * Generate standard (non-AI) questions with pre-filled answers where possible.
   * - year: standard question with correct year
   * - artist: standard question with correct artist
   * - missing_word: blanks a random word from the title
   * - trivia: empty question/answer for user to fill in
   */
  public generateStandardQuestions(tracks: TrackWithType[], allTracks?: TrackRow[], locale: string = 'en'): GeneratedQuestion[] {
    this.logger.log(
      color.blue.bold(
        `[Quiz] Quick-generating ${white.bold(String(tracks.length))} questions (no AI)`
      )
    );

    const t = (key: string) => this.translation.translate(key, locale);

    return tracks.map((track) => {
      switch (track.type) {
        case 'year':
          return {
            trackId: track.trackId,
            type: 'year',
            question: t('quiz.yearQuestion'),
            options: null,
            correctAnswer: String(track.year),
          };
        case 'artist':
          return {
            trackId: track.trackId,
            type: 'artist',
            question: t('quiz.artistQuestion'),
            options: null,
            correctAnswer: track.artist,
          };
        case 'title':
          return this.generateTitleQuestion(track, allTracks || [], locale);
        case 'missing_word': {
          const words = track.name.trim().split(/\s+/);
          const removeIndex = Math.floor(Math.random() * words.length);
          const missingWord = words[removeIndex];
          const blanked = words.map((w, i) => (i === removeIndex ? '___' : w)).join(' ');
          return {
            trackId: track.trackId,
            type: 'missing_word',
            question: `${blanked}\n${t('quiz.missingWordQuestion')}`,
            options: null,
            correctAnswer: missingWord,
          };
        }
        case 'release_order':
          return this.generateReleaseOrderQuestion(track, allTracks || [], locale);
        case 'decade':
          return this.generateDecadeQuestion(track, locale);
        case 'trivia':
        default:
          return {
            trackId: track.trackId,
            type: 'trivia',
            question: '',
            options: null,
            correctAnswer: '',
          };
      }
    });
  }

  /**
   * Generate a release_order question. Picks 3 other tracks with different years,
   * sorts all 4 chronologically. Options = track labels in order, correctAnswer = index of current track.
   */
  private generateReleaseOrderQuestion(track: TrackWithType, allTracks: TrackRow[], locale: string = 'en'): GeneratedQuestion {
    // Get candidate tracks with years, excluding the current one
    const candidates = allTracks.filter(
      (t) => t.id !== track.trackId && t.year && t.year !== track.year
    );

    // Shuffle and pick up to 3 with unique years
    const shuffled = this.shuffle(candidates);
    const picked: TrackRow[] = [];
    const usedYears = new Set<number>([track.year]);

    for (const c of shuffled) {
      if (picked.length >= 3) break;
      if (!usedYears.has(c.year!)) {
        picked.push(c);
        usedYears.add(c.year!);
      }
    }

    // If we can't find 3 others with different years, fall back to year question
    if (picked.length < 3) {
      return {
        trackId: track.trackId,
        type: 'year',
        question: this.translation.translate('quiz.yearQuestion', locale),
        options: null,
        correctAnswer: String(track.year),
      };
    }

    // Build all 4 entries and sort by year
    const entries = [
      { label: `${track.artist} - ${track.name}`, year: track.year, isCurrent: true },
      ...picked.map((p) => ({ label: `${p.artist} - ${p.name}`, year: p.year!, isCurrent: false })),
    ];
    entries.sort((a, b) => a.year - b.year);

    const correctIndex = entries.findIndex((e) => e.isCurrent);
    const options: ReleaseOrderOption[] = entries.map((e) => ({ label: e.label, year: e.year }));

    return {
      trackId: track.trackId,
      type: 'release_order',
      question: this.translation.translate('quiz.releaseOrderQuestion', locale),
      options,
      correctAnswer: String(correctIndex),
    };
  }
  /**
   * Generate a decade question. Shows 4 decade options, one correct.
   * Wrong options: decade before, decade after, +/- 2 decades (clamped to valid range).
   */
  private generateDecadeQuestion(track: TrackWithType, locale: string = 'en'): GeneratedQuestion {
    const correctDecade = Math.floor(track.year / 10) * 10;
    const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;

    const decadeLabel = (d: number) => `${d}s`;

    // Build candidate wrong decades: -1, +1, -2, +2
    const wrongCandidates: number[] = [];
    if (correctDecade - 10 >= 1900) wrongCandidates.push(correctDecade - 10);
    if (correctDecade + 10 <= currentDecade) wrongCandidates.push(correctDecade + 10);
    if (correctDecade - 20 >= 1900) wrongCandidates.push(correctDecade - 20);
    if (correctDecade + 20 <= currentDecade) wrongCandidates.push(correctDecade + 20);

    // Take 3 wrong options
    const wrongOptions = wrongCandidates.slice(0, 3);

    // If not enough (very edge case), fill with whatever is available
    while (wrongOptions.length < 3) {
      const fallback = correctDecade - (wrongOptions.length + 1) * 10;
      if (fallback >= 1900 && !wrongOptions.includes(fallback)) {
        wrongOptions.push(fallback);
      } else {
        wrongOptions.push(correctDecade + (wrongOptions.length + 2) * 10);
      }
    }

    const allOptions = [decadeLabel(correctDecade), ...wrongOptions.map(decadeLabel)];
    // Shuffle
    for (let i = allOptions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allOptions[i], allOptions[j]] = [allOptions[j], allOptions[i]];
    }

    return {
      trackId: track.trackId,
      type: 'decade',
      question: this.translation.translate('quiz.decadeQuestion', locale),
      options: allOptions,
      correctAnswer: decadeLabel(correctDecade),
    };
  }

  /**
   * Generate a "What is the title?" question. Uses 3 other track titles from allTracks as wrong options.
   */
  private generateTitleQuestion(track: TrackWithType, allTracks: TrackRow[], locale: string = 'en'): GeneratedQuestion {
    const candidates = allTracks.filter((t) => t.id !== track.trackId && t.name !== track.name);
    const shuffled = this.shuffle(candidates);
    const wrongTitles = shuffled.slice(0, 3).map((t) => t.name);

    // If not enough alternatives, fill with placeholders
    while (wrongTitles.length < 3) {
      wrongTitles.push(`Track ${wrongTitles.length + 2}`);
    }

    const allOptions = [track.name, ...wrongTitles];
    // Shuffle options
    for (let i = allOptions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allOptions[i], allOptions[j]] = [allOptions[j], allOptions[i]];
    }

    return {
      trackId: track.trackId,
      type: 'title',
      question: this.translation.translate('quiz.titleQuestion', locale),
      options: allOptions,
      correctAnswer: track.name,
    };
  }

  /**
   * Get the number of AI quizzes a user has generated this week.
   * Returns remaining AI generations and the count used.
   */
  public async getAiQuizUsage(userHash: string): Promise<{ used: number; remaining: number; limit: number }> {
    if (this.isDevelopment) {
      return { used: 0, remaining: MAX_AI_QUIZZES_PER_WEEK, limit: MAX_AI_QUIZZES_PER_WEEK };
    }

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const count = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count
      FROM quizzes q
      JOIN payment_has_playlist php ON php.id = q.paymentHasPlaylistId
      JOIN payments p ON p.id = php.paymentId
      JOIN users u ON u.id = p.userId
      WHERE u.hash = ${userHash}
      AND q.useAi = 1
      AND q.createdAt >= ${weekAgo}
    `;

    const used = Number(count[0].count);
    const remaining = Math.max(0, MAX_AI_QUIZZES_PER_WEEK - used);

    return { used, remaining, limit: MAX_AI_QUIZZES_PER_WEEK };
  }
}

export default Quiz;
