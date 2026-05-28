import { FastifyInstance } from 'fastify';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import { color } from 'console-log-colors';

/**
 * Admin-only routes for inspecting AI playlist creations.
 * All endpoints require the `admin` group on the caller's JWT.
 */
export default async function aiAdminRoutes(
  fastify: FastifyInstance,
  _verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const prisma = PrismaInstance.getInstance();
  const logger = new Logger();

  /**
   * GET /admin/ai-creations
   * Paginated listing of AI generation runs.
   * Query params:
   *   page (1-based, default 1)
   *   pageSize (default 20, max 100)
   *   q (optional, matches prompt or jobId)
   *   status (optional: running | success | error)
   */
  fastify.get(
    '/admin/ai-creations',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const query = request.query || {};
        const rawPage = parseInt(query.page, 10);
        const rawSize = parseInt(query.pageSize, 10);
        const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
        const pageSize =
          Number.isFinite(rawSize) && rawSize > 0
            ? Math.min(rawSize, 100)
            : 20;
        const q = typeof query.q === 'string' ? query.q.trim() : '';
        const status = typeof query.status === 'string' ? query.status : '';

        const where: any = {};
        if (status && ['running', 'success', 'error'].includes(status)) {
          where.status = status;
        }
        if (q) {
          where.OR = [
            { prompt: { contains: q } },
            { jobId: { contains: q } },
            { spotifyPlaylistId: { contains: q } },
          ];
        }

        const last24hCutoff = new Date(Date.now() - 24 * 3600 * 1000);
        const [total, rows, aggregates, last24h] = await Promise.all([
          prisma.aISearch.count({ where }),
          prisma.aISearch.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: {
              id: true,
              jobId: true,
              shortId: true,
              prompt: true,
              title: true,
              locale: true,
              requestedCount: true,
              deliveredCount: true,
              startYear: true,
              endYear: true,
              spotifyPlaylistId: true,
              spotifyPlaylistUrl: true,
              status: true,
              errorMessage: true,
              model: true,
              inputTokens: true,
              outputTokens: true,
              totalCostUsd: true,
              durationMs: true,
              createdAt: true,
            },
          }),
          prisma.aISearch.aggregate({
            where,
            _sum: {
              inputTokens: true,
              outputTokens: true,
              totalCostUsd: true,
            },
            _count: { _all: true },
          }),
          // Last-24h totals — unfiltered, independent of `where`/search/status
          // so the operator can see fresh activity at a glance.
          prisma.aISearch.aggregate({
            where: { createdAt: { gte: last24hCutoff } },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              totalCostUsd: true,
            },
            _count: { _all: true },
          }),
        ]);

        return reply.send({
          success: true,
          data: {
            rows,
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            totals: {
              count: aggregates._count?._all || 0,
              inputTokens: aggregates._sum?.inputTokens || 0,
              outputTokens: aggregates._sum?.outputTokens || 0,
              totalCostUsd: aggregates._sum?.totalCostUsd || 0,
            },
            last24h: {
              count: last24h._count?._all || 0,
              inputTokens: last24h._sum?.inputTokens || 0,
              outputTokens: last24h._sum?.outputTokens || 0,
              totalCostUsd: last24h._sum?.totalCostUsd || 0,
            },
          },
        });
      } catch (error: any) {
        logger.log(
          color.red.bold(
            `[ai-creations] failed to list: ${error?.message || error}`
          )
        );
        return reply
          .status(500)
          .send({ success: false, error: 'Failed to load AI creations' });
      }
    }
  );
}
