import { FastifyInstance } from 'fastify';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import PrismaInstance from '../prisma';
import ProductPhotoQueue from '../productPhotoQueue';
import { photoFilePath, photoUrls, setPhotoSongs } from '../productPhoto/photos';
import { photoCandidates, PHOTO_SONGS } from '../productPhoto/songs';

/**
 * Product photos (src/productPhoto/).
 *
 * - GET  /product-photo/:key/:file                    PUBLIC: a photo's file; the key is in the URL, so it never changes
 * - GET  /admin/product-photo/:playlistId             the photo, its songs and the songs it could show
 * - PUT  /admin/product-photo/:playlistId/songs       { trackIds } (5, the scene's order) → the admin's choice, then a new photo
 * - POST /admin/product-photo/:playlistId/regenerate  { repick? } → a new photo; repick lets the model choose the songs again
 * - POST /admin/product-photos/run                    every featured playlist into the queue (a photo still right costs nothing)
 * - GET  /admin/product-photos/status                 the queue and how many featured playlists have a photo
 *
 * :playlistId is the music service's id, as on the other Featured page routes.
 */

const TYPES: Record<string, string> = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };

export default async function productPhotoRoutes(fastify: FastifyInstance, getAuthHandler: any) {
  const adminOnly = getAuthHandler(['admin']);
  const prisma = PrismaInstance.getInstance();

  const playlistRow = (playlistId: string) =>
    prisma.playlist.findUnique({ where: { playlistId }, select: { id: true, slug: true, featured: true } });

  // the admin's modal waits while the row says pending; the product page
  // keeps the current photo meanwhile (productPhotoFor ignores the status)
  const queue = async (playlistId: number, options: { force?: boolean; repick?: boolean }) => {
    await ProductPhotoQueue.getInstance().add(playlistId, options);
    await prisma.productPhoto.upsert({
      where: { playlistId },
      create: { playlistId, status: 'pending' },
      update: { status: 'pending', error: null },
    });
  };

  const fail = (reply: any, error: any, context: string) => {
    console.error(`${context}:`, error);
    return reply.status(500).send({ success: false, error: `${context} failed` });
  };

  fastify.get('/product-photo/:key/:file', async (request: any, reply: any) => {
    const file = photoFilePath(request.params.key, request.params.file);
    const stat = file ? await fs.stat(file).catch(() => null) : null;
    if (!file || !stat) return reply.status(404).send({ success: false, error: 'Not found' });
    return reply
      .header('content-type', TYPES[file.split('.').pop() as string])
      .header('content-length', stat.size)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(file));
  });

  fastify.get('/admin/product-photo/:playlistId', adminOnly, async (request: any, reply: any) => {
    try {
      const playlist = await playlistRow(request.params.playlistId);
      if (!playlist) return reply.status(404).send({ success: false, error: 'Playlist not found' });
      const [row, candidates] = await Promise.all([
        prisma.productPhoto.findUnique({ where: { playlistId: playlist.id } }),
        photoCandidates(playlist.id),
      ]);
      const byId = new Map(candidates.map((track) => [track.id, track]));
      const songs = Array.isArray(row?.trackIds) ? (row.trackIds as number[]).map((id) => byId.get(id) ?? null) : [];
      return {
        success: true,
        photo: row && {
          status: row.status,
          error: row.error,
          pickSource: row.pickSource,
          generatedAt: row.generatedAt,
          urls: row.photoKey && playlist.slug ? photoUrls(row.photoKey, playlist.slug) : null,
        },
        songs: songs.map((track) => track && { id: track.id, artist: track.artist, name: track.name, year: track.year }),
        candidates: candidates.map((track) => ({ id: track.id, artist: track.artist, name: track.name, year: track.year })),
      };
    } catch (error) {
      return fail(reply, error, 'Reading the product photo');
    }
  });

  fastify.put('/admin/product-photo/:playlistId/songs', adminOnly, async (request: any, reply: any) => {
    try {
      const playlist = await playlistRow(request.params.playlistId);
      if (!playlist) return reply.status(404).send({ success: false, error: 'Playlist not found' });
      const trackIds = request.body?.trackIds;
      if (!Array.isArray(trackIds) || !(await setPhotoSongs(playlist.id, trackIds.map(Number)))) {
        return reply.status(400).send({
          success: false,
          error: `Pick ${PHOTO_SONGS} different songs of this playlist that have a year, a link and a short title`,
        });
      }
      await queue(playlist.id, { force: true });
      return { success: true };
    } catch (error) {
      return fail(reply, error, 'Saving the product photo songs');
    }
  });

  fastify.post('/admin/product-photo/:playlistId/regenerate', adminOnly, async (request: any, reply: any) => {
    try {
      const playlist = await playlistRow(request.params.playlistId);
      if (!playlist) return reply.status(404).send({ success: false, error: 'Playlist not found' });
      if (!playlist.featured) return reply.status(400).send({ success: false, error: 'Only a featured playlist has a product photo' });
      await queue(playlist.id, { force: true, repick: request.body?.repick === true });
      return { success: true };
    } catch (error) {
      return fail(reply, error, 'Queueing the product photo');
    }
  });

  fastify.post('/admin/product-photos/run', adminOnly, async (_request: any, reply: any) => {
    try {
      return { success: true, queued: await ProductPhotoQueue.getInstance().addAllFeatured() };
    } catch (error) {
      return fail(reply, error, 'Starting the product photo run');
    }
  });

  fastify.get('/admin/product-photos/status', adminOnly, async (_request: any, reply: any) => {
    try {
      const [queue, featured, rows, problems] = await Promise.all([
        ProductPhotoQueue.getInstance().counts(),
        prisma.playlist.count({ where: { featured: true, slug: { not: '' } } }),
        prisma.productPhoto.groupBy({
          by: ['status'],
          where: { playlist: { featured: true } },
          _count: { _all: true },
        }),
        prisma.productPhoto.findMany({
          where: { status: { in: ['failed', 'skipped'] }, playlist: { featured: true } },
          select: { status: true, error: true, updatedAt: true, playlist: { select: { slug: true, name: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        }),
      ]);
      const byStatus: Record<string, number> = Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
      return {
        success: true,
        queue,
        featured,
        ready: byStatus['ready'] || 0,
        photos: byStatus,
        problems: problems.map((row) => ({
          slug: row.playlist.slug,
          name: row.playlist.name,
          status: row.status,
          error: row.error,
        })),
      };
    } catch (error) {
      return fail(reply, error, 'Reading the product photo status');
    }
  });
}
