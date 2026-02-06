import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import { color, white } from 'console-log-colors';
import { ChatGPT } from '../chatgpt';
import Quiz, { TrackRow, MAX_QUESTIONS } from '../quiz';
import CacheInstance from '../cache';
import { Prisma } from '@prisma/client';

interface PlaylistInfoRow {
  playlistName: string;
  playlistId: string;
  playlistDbId: number;
  paymentHasPlaylistId: number;
}

// Redis client for game rooms (separate from cache)
let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    redis = new Redis(redisUrl, { db: 1 });
  }
  return redis;
}

const ROOM_TTL_SECONDS = 4 * 60 * 60;
const QUIZ_CACHE_TTL = 4 * 60 * 60;

export default async function quizRoutes(
  fastify: FastifyInstance,
  getAuthHandler?: any
) {
  const prisma = PrismaInstance.getInstance();
  const logger = new Logger();
  const chatgpt = new ChatGPT();
  const quizHelper = Quiz.getInstance();
  const cache = CacheInstance.getInstance();

  /**
   * Verify payment ownership and get playlist info
   */
  async function verifyAndGetPlaylist(
    paymentId: string,
    userHash: string,
    playlistId: string
  ): Promise<{ success: boolean; playlistInfo?: PlaylistInfoRow; error?: string }> {
    const result = await prisma.$queryRaw<PlaylistInfoRow[]>`
      SELECT
        pl.name as playlistName,
        pl.playlistId as playlistId,
        pl.id as playlistDbId,
        php.id as paymentHasPlaylistId
      FROM payments p
      JOIN users u ON p.userId = u.id
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      WHERE p.paymentId = ${paymentId}
      AND u.hash = ${userHash}
      AND pl.playlistId = ${playlistId}
      AND p.status = 'paid'
      AND php.bingoEnabled = 1
      LIMIT 1
    `;

    if (result.length === 0) {
      return { success: false, error: 'Unauthorized or playlist not found' };
    }

    return { success: true, playlistInfo: result[0] };
  }

  if (!getAuthHandler) return;

  /**
   * GET /api/quiz/ai-usage/:userHash
   * Get AI quiz generation usage for the current week
   */
  fastify.get(
    '/api/quiz/ai-usage/:userHash',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { userHash } = request.params;
        const usage = await quizHelper.getAiQuizUsage(userHash);
        return reply.send({ success: true, ...usage });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error getting AI usage: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to get AI usage' });
      }
    }
  );

  /**
   * POST /api/quiz/generate
   * Generate a quiz from selected tracks using LLM (async with progress polling)
   */
  fastify.post(
    '/api/quiz/generate',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { paymentId, userHash, playlistId, selectedTracks, timerSeconds, listeningSeconds, name, locale, questionTypes, useAi } = request.body;

        if (!paymentId || !userHash || !playlistId || !selectedTracks || selectedTracks.length < 5) {
          return reply.status(400).send({
            success: false,
            error: 'Missing required parameters or fewer than 5 tracks selected',
          });
        }

        if (selectedTracks.length > MAX_QUESTIONS) {
          return reply.status(400).send({
            success: false,
            error: `Maximum ${MAX_QUESTIONS} questions allowed`,
          });
        }

        // Check AI usage limit
        if (useAi !== false) {
          const usage = await quizHelper.getAiQuizUsage(userHash);
          if (usage.remaining <= 0) {
            return reply.status(429).send({
              success: false,
              error: 'quiz.aiLimitReached',
            });
          }
        }

        // Verify ownership
        const verification = await verifyAndGetPlaylist(paymentId, userHash, playlistId);
        if (!verification.success || !verification.playlistInfo) {
          return reply.status(401).send({ success: false, error: verification.error });
        }

        const { paymentHasPlaylistId, playlistDbId } = verification.playlistInfo;

        // Load tracks
        const tracks = await prisma.$queryRaw<TrackRow[]>`
          SELECT t.id, t.trackId, t.name, t.artist, t.year, pht.\`order\` as trackOrder
          FROM playlist_has_tracks pht
          JOIN tracks t ON t.id = pht.trackId
          WHERE pht.playlistId = ${playlistDbId}
          ORDER BY pht.\`order\` ASC
        `;

        // Filter by selected tracks
        const filteredTracks = quizHelper.filterSelectedTracks(tracks, selectedTracks);

        if (filteredTracks.length < 5) {
          return reply.status(400).send({
            success: false,
            error: 'At least 5 valid tracks are required',
          });
        }

        // Assign question types
        const tracksWithTypes = quizHelper.assignQuestionTypes(filteredTracks, questionTypes);

        // Generate a unique ID for this generation
        const generationId = uuidv4();
        const progressKey = `quiz:gen:${generationId}`;

        const setProgress = (data: any) => {
          cache.set(progressKey, JSON.stringify(data), 300);
        };

        setProgress({ status: 'generating', step: 'starting', current: 0, total: tracksWithTypes.length });

        // Return immediately with generationId
        reply.send({ success: true, generationId });

        // Background generation (fire-and-forget)
        (async () => {
          try {
            const NON_AI_TYPES = ['release_order', 'decade'];
            const nonAiTracks = tracksWithTypes.filter((t) => NON_AI_TYPES.includes(t.type));
            const aiTracks = tracksWithTypes.filter((t) => !NON_AI_TYPES.includes(t.type));

            let questions;
            if (useAi === false) {
              questions = quizHelper.generateStandardQuestions(tracksWithTypes, tracks);
              setProgress({ status: 'generating', step: 'nonAi', current: questions.length, total: tracksWithTypes.length });
            } else {
              logger.log(
                color.blue.bold(
                  `[Quiz] Generating questions for ${white.bold(String(aiTracks.length))} AI tracks + ${white.bold(String(nonAiTracks.length))} standard tracks`
                )
              );

              const nonAiQuestions = nonAiTracks.length > 0
                ? quizHelper.generateStandardQuestions(nonAiTracks, tracks)
                : [];
              setProgress({ status: 'generating', step: 'nonAi', current: nonAiQuestions.length, total: tracksWithTypes.length });

              const onProgress = (progress: { step: string; detail: string; questionsGenerated: number }) => {
                setProgress({
                  status: 'generating',
                  step: progress.step,
                  message: progress.detail,
                  current: nonAiQuestions.length + progress.questionsGenerated,
                  total: tracksWithTypes.length,
                });
              };

              const aiQuestions = aiTracks.length > 0
                ? await chatgpt.generateQuizQuestions(aiTracks as any, locale || 'en', onProgress)
                : [];

              questions = [...aiQuestions, ...nonAiQuestions];
            }

            // Shuffle questions
            questions = quizHelper.shuffle(questions);

            setProgress({ status: 'generating', step: 'saving', current: tracksWithTypes.length, total: tracksWithTypes.length });

            // Create quiz and questions in database
            const quiz = await prisma.quiz.create({
              data: {
                paymentHasPlaylistId,
                name: name || `Quiz - ${new Date().toLocaleDateString()}`,
                timerSeconds: timerSeconds || 20,
                listeningSeconds: listeningSeconds || 8,
                locale: locale || 'en',
                useAi: useAi !== false,
                questions: {
                  create: questions.map((q, index) => ({
                    trackId: q.trackId,
                    order: index,
                    type: q.type,
                    question: q.question,
                    options: q.options ?? Prisma.JsonNull,
                    correctAnswer: q.correctAnswer,
                  })),
                },
              },
              include: {
                questions: {
                  orderBy: { order: 'asc' },
                },
              },
            });

            logger.log(
              color.green.bold(
                `[Quiz] Created quiz ${white.bold(String(quiz.id))} with ${white.bold(String((quiz as any).questions?.length ?? 0))} questions`
              )
            );

            setProgress({ status: 'complete', quizId: quiz.id });
          } catch (error: any) {
            cache.set(`quiz:gen:${generationId}`, JSON.stringify({ status: 'error', error: 'quiz.generateError' }), 300);
            logger.log(color.red.bold(`[Quiz] Background generation error: ${error.message}`));
          }
        })();
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error generating quiz: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to generate quiz' });
      }
    }
  );

  /**
   * GET /api/quiz/generate/progress/:generationId
   * Poll for quiz generation progress
   */
  fastify.get(
    '/api/quiz/generate/progress/:generationId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { generationId } = request.params;
        const progress = await cache.get(`quiz:gen:${generationId}`, false);
        if (!progress) {
          return reply.status(404).send({ success: false, error: 'Generation not found' });
        }
        return reply.send({ success: true, ...JSON.parse(progress) });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error getting generation progress: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to get progress' });
      }
    }
  );

  /**
   * GET /api/quiz/:quizId
   * Get quiz with all questions for editing
   */
  fastify.get(
    '/api/quiz/:quizId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId } = request.params;
        const quiz = await prisma.quiz.findUnique({
          where: { id: parseInt(quizId) },
          include: {
            questions: {
              orderBy: { order: 'asc' },
            },
            paymentHasPlaylist: {
              include: {
                playlist: true,
              },
            },
          },
        });

        if (!quiz) {
          return reply.status(404).send({ success: false, error: 'Quiz not found' });
        }

        // Enrich questions with track info
        const trackIds = [...new Set(quiz.questions.map((q: any) => q.trackId))];
        const tracks = trackIds.length > 0
          ? await prisma.$queryRaw<{ id: number; name: string; artist: string; year: number | null }[]>`
              SELECT id, name, artist, year FROM tracks WHERE id IN (${Prisma.join(trackIds)})
            `
          : [];
        const trackMap = new Map(tracks.map((t) => [t.id, t]));

        const enrichedQuestions = quiz.questions.map((q: any) => {
          const track = trackMap.get(q.trackId);
          return {
            ...q,
            trackName: track?.name || 'Unknown',
            trackArtist: track?.artist || 'Unknown',
            trackYear: track?.year || null,
          };
        });

        return reply.send({
          success: true,
          quiz: {
            ...quiz,
            questions: enrichedQuestions,
          },
        });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error getting quiz: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to get quiz' });
      }
    }
  );

  /**
   * GET /api/quiz/list/:paymentHasPlaylistId
   * List quizzes for a playlist
   */
  fastify.get(
    '/api/quiz/list/:paymentHasPlaylistId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { paymentHasPlaylistId } = request.params;
        const quizzes = await prisma.quiz.findMany({
          where: { paymentHasPlaylistId: parseInt(paymentHasPlaylistId) },
          include: {
            _count: { select: { questions: true } },
          },
          orderBy: { createdAt: 'desc' },
        });

        return reply.send({ success: true, quizzes });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error listing quizzes: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to list quizzes' });
      }
    }
  );

  /**
   * PUT /api/quiz/:quizId/question/:questionId
   * Update a question
   */
  fastify.put(
    '/api/quiz/:quizId/question/:questionId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId, questionId } = request.params;
        const { question, options, correctAnswer, type } = request.body;

        const updated = await prisma.quizQuestion.update({
          where: {
            id: parseInt(questionId),
            quizId: parseInt(quizId),
          },
          data: {
            ...(question !== undefined && { question }),
            ...(options !== undefined && { options }),
            ...(correctAnswer !== undefined && { correctAnswer }),
            ...(type !== undefined && { type }),
          },
        });

        return reply.send({ success: true, question: updated });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error updating question: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to update question' });
      }
    }
  );

  /**
   * DELETE /api/quiz/:quizId/question/:questionId
   * Delete a question
   */
  fastify.delete(
    '/api/quiz/:quizId/question/:questionId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId, questionId } = request.params;

        await prisma.quizQuestion.delete({
          where: {
            id: parseInt(questionId),
            quizId: parseInt(quizId),
          },
        });

        return reply.send({ success: true });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error deleting question: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to delete question' });
      }
    }
  );

  /**
   * POST /api/quiz/:quizId/question/:questionId/regenerate
   * Regenerate one question via LLM
   */
  fastify.post(
    '/api/quiz/:quizId/question/:questionId/regenerate',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId, questionId } = request.params;

        const existing = await prisma.quizQuestion.findUnique({
          where: { id: parseInt(questionId), quizId: parseInt(quizId) },
          include: { quiz: { select: { locale: true } } },
        });

        if (!existing) {
          return reply.status(404).send({ success: false, error: 'Question not found' });
        }

        // Get track info
        const track = await prisma.$queryRaw<{ name: string; artist: string; year: number }[]>`
          SELECT name, artist, COALESCE(year, 2000) as year FROM tracks WHERE id = ${existing.trackId} LIMIT 1
        `;

        if (track.length === 0) {
          return reply.status(404).send({ success: false, error: 'Track not found' });
        }

        const questionType = existing.type as string;

        // Non-AI types: regenerate via quiz.ts
        if (questionType === 'release_order' || questionType === 'decade') {
          // Load all tracks for the quiz's playlist (needed for release_order)
          const playlistId = await prisma.$queryRaw<[{ playlistId: number }]>`
            SELECT php.playlistId FROM payment_has_playlist php
            JOIN quizzes q ON q.paymentHasPlaylistId = php.id
            WHERE q.id = ${parseInt(quizId)}
            LIMIT 1
          `;
          const allTracks = playlistId.length > 0
            ? await prisma.$queryRaw<TrackRow[]>`
                SELECT t.id, t.trackId, t.name, t.artist, t.year, pht.\`order\` as trackOrder
                FROM playlist_has_tracks pht
                JOIN tracks t ON t.id = pht.trackId
                WHERE pht.playlistId = ${playlistId[0].playlistId}
                ORDER BY pht.\`order\` ASC
              `
            : [];

          const trackWithType = {
            trackId: existing.trackId,
            name: track[0].name,
            artist: track[0].artist,
            year: track[0].year,
            type: questionType as any,
          };
          const [regenerated] = quizHelper.generateStandardQuestions([trackWithType], allTracks);

          const updated = await prisma.quizQuestion.update({
            where: { id: parseInt(questionId) },
            data: {
              question: regenerated.question,
              options: regenerated.options ?? Prisma.JsonNull,
              correctAnswer: regenerated.correctAnswer,
            },
          });
          return reply.send({ success: true, question: updated });
        }

        const regenerated = await chatgpt.regenerateQuizQuestion(
          track[0],
          questionType as 'year' | 'trivia' | 'artist' | 'missing_word' | 'title',
          existing.quiz.locale || 'en'
        );

        const updated = await prisma.quizQuestion.update({
          where: { id: parseInt(questionId) },
          data: {
            question: regenerated.question,
            options: regenerated.options ?? Prisma.JsonNull,
            correctAnswer: regenerated.correctAnswer,
          },
        });

        return reply.send({ success: true, question: updated });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error regenerating question: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to regenerate question' });
      }
    }
  );

  /**
   * POST /api/quiz/:quizId/question/:questionId/ai-options
   * Generate wrong options via AI given the question + correct answer
   */
  fastify.post(
    '/api/quiz/:quizId/question/:questionId/ai-options',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId, questionId } = request.params;
        const { question, correctAnswer } = request.body;

        if (!question || !correctAnswer) {
          return reply.status(400).send({ success: false, error: 'question and correctAnswer are required' });
        }

        const existing = await prisma.quizQuestion.findUnique({
          where: { id: parseInt(questionId), quizId: parseInt(quizId) },
          include: { quiz: { select: { locale: true } } },
        });

        if (!existing) {
          return reply.status(404).send({ success: false, error: 'Question not found' });
        }

        const track = await prisma.$queryRaw<{ name: string; artist: string }[]>`
          SELECT name, artist FROM tracks WHERE id = ${existing.trackId} LIMIT 1
        `;

        if (track.length === 0) {
          return reply.status(404).send({ success: false, error: 'Track not found' });
        }

        const wrongOptions = await chatgpt.generateWrongOptions(
          question,
          correctAnswer,
          track[0],
          existing.quiz.locale || 'en'
        );

        return reply.send({ success: true, wrongOptions });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error generating AI options: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to generate options' });
      }
    }
  );

  /**
   * POST /api/quiz/:quizId/question
   * Add a new blank question to the quiz
   */
  fastify.post(
    '/api/quiz/:quizId/question',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId } = request.params;
        const { trackId, type } = request.body || {};

        // Get quiz with its questions to determine order and a default trackId
        const quiz = await prisma.quiz.findUnique({
          where: { id: parseInt(quizId) },
          include: { questions: { orderBy: { order: 'asc' } } },
        });

        if (!quiz) {
          return reply.status(404).send({ success: false, error: 'Quiz not found' });
        }

        const resolvedTrackId = trackId || (quiz.questions.length > 0 ? quiz.questions[0].trackId : null);
        if (!resolvedTrackId) {
          return reply.status(400).send({ success: false, error: 'No track available' });
        }

        const maxOrder = quiz.questions.length > 0
          ? Math.max(...quiz.questions.map((q: any) => q.order)) + 1
          : 0;

        const question = await prisma.quizQuestion.create({
          data: {
            quizId: parseInt(quizId),
            trackId: resolvedTrackId,
            order: maxOrder,
            type: type || 'trivia',
            question: '',
            options: Prisma.JsonNull,
            correctAnswer: '',
          },
        });

        // Fetch track info for the response
        const track = await prisma.$queryRaw<{ name: string; artist: string; year: number }[]>`
          SELECT name, artist, COALESCE(year, 2000) as year FROM tracks WHERE id = ${resolvedTrackId} LIMIT 1
        `;

        const result = {
          ...question,
          trackName: track[0]?.name || '',
          trackArtist: track[0]?.artist || '',
          trackYear: track[0]?.year || null,
        };

        return reply.send({ success: true, question: result });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error adding question: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to add question' });
      }
    }
  );

  /**
   * PUT /api/quiz/:quizId/reorder
   * Reorder questions
   */
  fastify.put(
    '/api/quiz/:quizId/reorder',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId } = request.params;
        const { questionIds } = request.body as { questionIds: number[] };

        if (!questionIds || !Array.isArray(questionIds)) {
          return reply.status(400).send({ success: false, error: 'questionIds array required' });
        }

        // Update order for each question
        await Promise.all(
          questionIds.map((id, index) =>
            prisma.quizQuestion.update({
              where: { id, quizId: parseInt(quizId) },
              data: { order: index },
            })
          )
        );

        return reply.send({ success: true });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error reordering questions: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to reorder questions' });
      }
    }
  );

  /**
   * PUT /api/quiz/:quizId
   * Update quiz settings
   */
  fastify.put(
    '/api/quiz/:quizId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId } = request.params;
        const { name, timerSeconds, listeningSeconds } = request.body;

        const updated = await prisma.quiz.update({
          where: { id: parseInt(quizId) },
          data: {
            ...(name !== undefined && { name }),
            ...(timerSeconds !== undefined && { timerSeconds }),
            ...(listeningSeconds !== undefined && { listeningSeconds }),
          },
        });

        return reply.send({ success: true, quiz: updated });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error updating quiz: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to update quiz' });
      }
    }
  );

  /**
   * DELETE /api/quiz/:quizId
   * Delete entire quiz
   */
  fastify.delete(
    '/api/quiz/:quizId',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId } = request.params;

        await prisma.quiz.delete({
          where: { id: parseInt(quizId) },
        });

        return reply.send({ success: true });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error deleting quiz: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to delete quiz' });
      }
    }
  );

  /**
   * POST /api/quiz/:quizId/room
   * Create game room and load quiz into Redis cache
   */
  fastify.post(
    '/api/quiz/:quizId/room',
    getAuthHandler(['users']),
    async (request: any, reply: any) => {
      try {
        const { quizId } = request.params;
        const userIdString = request.user?.userId;

        if (!userIdString) {
          return reply.status(401).send({ success: false, error: 'Unauthorized' });
        }

        const user = await prisma.user.findUnique({
          where: { userId: userIdString },
        });

        if (!user) {
          return reply.status(401).send({ success: false, error: 'User not found' });
        }

        // Load quiz with questions
        const quiz = await prisma.quiz.findUnique({
          where: { id: parseInt(quizId) },
          include: {
            questions: { orderBy: { order: 'asc' } },
            paymentHasPlaylist: {
              include: { playlist: true },
            },
          },
        });

        if (!quiz) {
          return reply.status(404).send({ success: false, error: 'Quiz not found' });
        }

        if (quiz.questions.length === 0) {
          return reply.status(400).send({ success: false, error: 'Quiz has no questions' });
        }

        // Load track metadata for each question
        const trackIds = [...new Set(quiz.questions.map((q: any) => q.trackId))];
        const tracks = trackIds.length > 0
          ? await prisma.$queryRaw<{ id: number; trackId: string; name: string; artist: string; year: number | null }[]>`
              SELECT id, trackId, name, artist, year FROM tracks WHERE id IN (${Prisma.join(trackIds)})
            `
          : [];
        const trackMap = new Map(tracks.map((t) => [t.id, t]));

        // Build quiz data for cache
        const quizCacheData = {
          quizId: quiz.id,
          name: quiz.name,
          timerSeconds: quiz.timerSeconds,
          listeningSeconds: quiz.listeningSeconds,
          questions: quiz.questions.map((q: any) => {
            const track = trackMap.get(q.trackId);
            return {
              id: q.id,
              trackId: q.trackId,
              trackDbId: track?.trackId, // Spotify/external ID for QR matching
              type: q.type,
              question: q.question,
              options: q.options,
              correctAnswer: q.correctAnswer,
              trackName: track?.name || 'Unknown',
              trackArtist: track?.artist || 'Unknown',
              trackYear: track?.year || null,
            };
          }),
        };

        // Store quiz data in Redis cache
        const roomUuid = uuidv4();
        const quizCacheKey = `quiz:room:${roomUuid}`;
        await cache.set(quizCacheKey, JSON.stringify(quizCacheData), QUIZ_CACHE_TTL);

        // Build track mapping for TS handler (trackDbId -> question index)
        // This maps the database ID of each track to its question indices
        const trackMapping: Record<string, number[]> = {};
        quizCacheData.questions.forEach((q: any, index: number) => {
          const key = String(q.trackId);
          if (!trackMapping[key]) trackMapping[key] = [];
          trackMapping[key].push(index);
        });

        // Create game room in database
        const dbRoom = await prisma.gameRoom.create({
          data: {
            uuid: roomUuid,
            type: 'quiz',
            userId: user.id,
            state: 'created',
          },
        });

        // Create room state in Redis
        const roomState = {
          id: dbRoom.id,
          uuid: roomUuid,
          type: 'quiz',
          userId: user.id,
          state: 'created',
          lastActivity: Date.now(),
          pluginData: {
            quizId: quiz.id,
            quizCacheKey,
            quizName: quiz.name || 'Music Quiz',
            currentQuestionIndex: -1,
            phase: 'lobby',
            players: {},
            answers: {},
            timerSeconds: quiz.timerSeconds,
            listeningSeconds: quiz.listeningSeconds,
            questionStartedAt: null,
            totalQuestions: quiz.questions.length,
            trackMapping,
          },
        };

        await getRedis().set(`room:${roomUuid}`, JSON.stringify(roomState), 'EX', ROOM_TTL_SECONDS);
        await getRedis().sadd('rooms:active', roomUuid);

        logger.log(
          color.green.bold(
            `[Quiz] Created room ${white.bold(roomUuid)} for quiz ${white.bold(String(quiz.id))}`
          )
        );

        return reply.send({
          success: true,
          roomId: roomUuid,
          playerQrUrl: `quiz/${roomUuid}`,
          hostQrData: `QRSSM:RS:${roomUuid}`,
          quizName: quiz.name,
          questionCount: quiz.questions.length,
        });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error creating room: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to create room' });
      }
    }
  );

  /**
   * GET /api/quiz/player/:roomId
   * Public: get room info for player joining (no auth required)
   */
  fastify.get(
    '/api/quiz/player/:roomId',
    async (request: any, reply: any) => {
      try {
        const { roomId } = request.params;

        const roomData = await getRedis().get(`room:${roomId}`);
        if (!roomData) {
          return reply.status(404).send({ success: false, error: 'Room not found or expired' });
        }

        const room = JSON.parse(roomData);
        if (room.type !== 'quiz') {
          return reply.status(400).send({ success: false, error: 'Not a quiz room' });
        }

        if (room.state === 'ended') {
          return reply.status(400).send({ success: false, error: 'Quiz has ended' });
        }

        // Return limited info (no questions, no answers)
        const playerCount = Object.keys(room.pluginData.players || {}).length;

        return reply.send({
          success: true,
          quizName: room.pluginData.quizName || 'Music Quiz',
          room: {
            roomId: room.uuid,
            phase: room.pluginData.phase,
            playerCount,
            totalQuestions: room.pluginData.totalQuestions,
            timerSeconds: room.pluginData.timerSeconds,
          },
        });
      } catch (error: any) {
        logger.log(color.red.bold(`[Quiz] Error getting player room info: ${error.message}`));
        return reply.status(500).send({ success: false, error: 'Failed to get room info' });
      }
    }
  );
}
