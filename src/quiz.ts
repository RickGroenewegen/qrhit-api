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
  imageFilename?: string;
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
   * Check if a track is eligible for the given question type.
   */
  private isEligible(track: TrackRow, type: QuestionType): boolean {
    if (type === 'missing_word' && track.name.trim().split(/\s+/).length < 3) return false;
    if ((type === 'release_order' || type === 'decade') && !track.year) return false;
    return true;
  }

  /**
   * Assign question types to tracks, respecting the desired distribution
   * from the questionTypes array while ensuring each type is only assigned
   * to eligible tracks.
   */
  public assignQuestionTypes(
    tracks: TrackRow[],
    questionTypes?: string[]
  ): TrackWithType[] {
    const types: QuestionType[] =
      questionTypes && questionTypes.length > 0
        ? (questionTypes as QuestionType[])
        : ['year', 'trivia', 'artist', 'title', 'missing_word', 'release_order', 'decade'];

    // Count desired proportion per type from the questionTypes array
    const typeCounts = new Map<QuestionType, number>();
    for (const t of types) {
      typeCounts.set(t as QuestionType, (typeCounts.get(t as QuestionType) || 0) + 1);
    }

    // Calculate target count per type based on proportions
    const totalWeight = types.length;
    const targets = new Map<QuestionType, number>();
    let assigned = 0;
    const uniqueTypes = Array.from(typeCounts.keys());

    for (let i = 0; i < uniqueTypes.length; i++) {
      const type = uniqueTypes[i];
      if (i === uniqueTypes.length - 1) {
        // Last type gets the remainder to ensure exact total
        targets.set(type, tracks.length - assigned);
      } else {
        const count = Math.round((typeCounts.get(type)! / totalWeight) * tracks.length);
        targets.set(type, count);
        assigned += count;
      }
    }

    // Sort types by eligibility constraint (most constrained first)
    const constrainedOrder = [...uniqueTypes].sort((a, b) => {
      const aEligible = tracks.filter((t) => this.isEligible(t, a)).length;
      const bEligible = tracks.filter((t) => this.isEligible(t, b)).length;
      return aEligible - bEligible;
    });

    // Assign types: process most constrained types first
    const assignments = new Map<TrackRow, QuestionType>();
    const assignedTracks = new Set<TrackRow>();

    for (const type of constrainedOrder) {
      const target = targets.get(type)!;
      const eligible = this.shuffle(
        tracks.filter((t) => !assignedTracks.has(t) && this.isEligible(t, type))
      );

      const toAssign = Math.min(target, eligible.length);
      for (let i = 0; i < toAssign; i++) {
        assignments.set(eligible[i], type);
        assignedTracks.add(eligible[i]);
      }
    }

    // Any unassigned tracks (due to eligibility issues) get a fallback type
    for (const track of tracks) {
      if (!assignedTracks.has(track)) {
        const fallback = uniqueTypes.find((t) => this.isEligible(track, t)) || 'trivia';
        assignments.set(track, fallback);
        assignedTracks.add(track);
      }
    }

    // Build result in original track order, then shuffle to avoid
    // predictable patterns while respecting the distribution
    const result: TrackWithType[] = tracks.map((track) => ({
      trackId: track.id,
      name: track.name,
      artist: track.artist,
      year: track.year || 2000,
      type: assignments.get(track)!,
    }));

    // Shuffle to break any ordering patterns, then fix consecutive duplicates
    const shuffled = this.shuffle(result);
    this.fixConsecutiveDuplicates(shuffled);

    return shuffled;
  }

  /**
   * Swap elements to avoid consecutive duplicate question types.
   */
  private fixConsecutiveDuplicates(items: TrackWithType[]): void {
    for (let i = 1; i < items.length; i++) {
      if (items[i].type === items[i - 1].type) {
        // Find a later item to swap with
        for (let j = i + 1; j < items.length; j++) {
          if (items[j].type !== items[i].type && items[j].type !== items[i - 1].type) {
            [items[i], items[j]] = [items[j], items[i]];
            break;
          }
        }
      }
    }
  }

  /**
   * Generate standard (non-AI) questions with pre-filled answers where possible.
   * - year: standard question with correct year
   * - artist: standard question with correct artist
   * - missing_word: blanks a random word from the title
   * - trivia: empty question/answer for user to fill in
   */
  public generateStandardQuestions(tracks: TrackWithType[], allTracks?: TrackRow[], locale: string = 'en'): GeneratedQuestion[] {
    this.logger.logDev(
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
