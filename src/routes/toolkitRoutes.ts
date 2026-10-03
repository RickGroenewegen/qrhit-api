import { FastifyInstance } from 'fastify';
import Spotify from '../spotify';
import SpotifyApi from '../spotify_api';
import { readPlaylistItems } from '../playlistItems';
import ToolkitOrder, { ToolkitOrderError } from '../toolkitOrder';
import Generator from '../generator';
import PrismaInstance from '../prisma';

/**
 * Routes for Rick's qrsong toolkit (~/Sites/skill-qrsong), a CLI the agent
 * runs with the admin bearer token. Admin only: there is no dashboard screen
 * behind them, and none of them is meant for a customer or a vibeadmin.
 *
 * - POST /admin/toolkit/playlist                  make or refill a playlist in our Spotify account from exact track ids
 * - GET  /admin/toolkit/playlist/:playlistId/items  the playlist exactly as Spotify holds it (for verifying)
 * - POST /admin/toolkit/tracks                    Spotify metadata for track ids (for a hand-picked match)
 * - POST /admin/toolkit/order                     a Schneiders/Tromp order without Mollie or mails, on printer hold (src/toolkitOrder.ts)
 * - GET  /admin/toolkit/order/:paymentId          order, design, print files and every card's track + year check
 * - PUT  /admin/toolkit/order/:paymentId/design   change design / template of the order line
 * - POST /admin/toolkit/order/:paymentId/regenerate  rebuild QR codes and PDFs without any mail
 *
 * The order routes were approved by Rick on 2026-10-03 (option A in the
 * Revant session): orders for printers we mail ourselves, never Print&Bind.
 */
export default async function toolkitRoutes(fastify: FastifyInstance, getAuthHandler: any) {
  const adminOnly = getAuthHandler(['admin']);
  const spotify = Spotify.getInstance();
  const spotifyApi = new SpotifyApi();
  const toolkitOrder = ToolkitOrder.getInstance();
  const generator = Generator.getInstance();
  const prisma = PrismaInstance.getInstance();

  const fail = (reply: any, error: any) => {
    if (error instanceof ToolkitOrderError) return reply.status(error.status).send({ success: false, error: error.message });
    return reply.status(500).send({ success: false, error: error?.message || 'Internal error' });
  };

  const TRACK_ID = /^[A-Za-z0-9]{22}$/;
  const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;

  fastify.post('/admin/toolkit/playlist', adminOnly, async (request: any, reply: any) => {
    const name = String(request.body?.name ?? '').trim();
    const trackIds: unknown = request.body?.trackIds;
    if (!name) return reply.status(400).send({ success: false, error: 'name is required' });
    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return reply.status(400).send({ success: false, error: 'trackIds must be a non-empty array' });
    }
    const bad = trackIds.filter((id) => typeof id !== 'string' || !TRACK_ID.test(id));
    if (bad.length) return reply.status(400).send({ success: false, error: `not track ids: ${bad.slice(0, 5).join(', ')}` });
    if (new Set(trackIds).size !== trackIds.length) {
      return reply.status(400).send({ success: false, error: 'trackIds contains duplicates' });
    }
    // createOrUpdatePlaylist replaces the tracks of an existing playlist with
    // this name (among the account's first 50); say so in the answer.
    const ownId = await spotifyApi.getOwnUserId().catch(() => null);
    const result = await spotify.createOrUpdatePlaylist(name, trackIds as string[]);
    if (!result?.success) {
      return reply.status(502).send({ success: false, error: result?.error || 'Spotify refused the playlist' });
    }
    return {
      success: true,
      playlistId: result.data?.playlistId,
      playlistUrl: result.data?.playlistUrl,
      playlistName: result.data?.playlistName ?? name,
      owner: ownId ?? null,
      trackCount: trackIds.length,
    };
  });

  fastify.get('/admin/toolkit/playlist/:playlistId/items', adminOnly, async (request: any, reply: any) => {
    const playlistId = String(request.params.playlistId ?? '');
    if (!PLAYLIST_ID.test(playlistId)) return reply.status(400).send({ success: false, error: 'invalid playlist id' });
    try {
      const pl = await readPlaylistItems(playlistId);
      return { success: true, ...pl };
    } catch (error: any) {
      const status = error?.response?.status;
      return reply
        .status(status === 404 ? 404 : 502)
        .send({ success: false, error: error?.response?.data?.error?.message || error?.message || 'Spotify error' });
    }
  });

  fastify.post('/admin/toolkit/tracks', adminOnly, async (request: any, reply: any) => {
    const trackIds: unknown = request.body?.trackIds;
    if (!Array.isArray(trackIds) || trackIds.length === 0 || trackIds.length > 200) {
      return reply.status(400).send({ success: false, error: 'trackIds: 1 to 200 ids' });
    }
    if (trackIds.some((id) => typeof id !== 'string' || !TRACK_ID.test(id))) {
      return reply.status(400).send({ success: false, error: 'trackIds must be Spotify track ids' });
    }
    const result = await spotifyApi.getTracksByIds(trackIds as string[]);
    if (!result?.success) return reply.status(502).send({ success: false, error: result?.error || 'Spotify error' });
    const raw: any[] = result.data?.tracks ?? result.data ?? [];
    const tracks = raw.filter(Boolean).map((t: any) => ({
      id: t.id,
      name: t.name,
      artists: Array.isArray(t.artists) ? t.artists.map((a: any) => a?.name ?? a).filter(Boolean) : [],
      album: t.album?.name ?? null,
      releaseDate: t.album?.release_date ?? null,
      isrc: t.external_ids?.isrc ?? null,
    }));
    return { success: true, tracks };
  });

  fastify.post('/admin/toolkit/order', adminOnly, async (request: any, reply: any) => {
    try {
      const result = await toolkitOrder.create(request.body ?? {});
      return { success: true, ...result };
    } catch (error: any) {
      return fail(reply, error);
    }
  });

  fastify.get('/admin/toolkit/order/:paymentId', adminOnly, async (request: any, reply: any) => {
    try {
      return { success: true, order: await toolkitOrder.status(String(request.params.paymentId)) };
    } catch (error: any) {
      return fail(reply, error);
    }
  });

  fastify.put('/admin/toolkit/order/:paymentId/design', adminOnly, async (request: any, reply: any) => {
    try {
      await toolkitOrder.updateDesign(String(request.params.paymentId), request.body ?? {});
      return { success: true };
    } catch (error: any) {
      return fail(reply, error);
    }
  });

  // The same generation as GET /regenerate/:id/0 (forced finalize, no mail),
  // but only for an order that is on printer hold and not at a printer yet.
  fastify.post('/admin/toolkit/order/:paymentId/regenerate', adminOnly, async (request: any, reply: any) => {
    const paymentId = String(request.params.paymentId);
    const payment = await prisma.payment.findUnique({
      where: { paymentId },
      select: { printerHold: true, sentToPrinter: true },
    });
    if (!payment) return reply.status(404).send({ success: false, error: 'order not found' });
    if (!payment.printerHold || payment.sentToPrinter) {
      return reply.status(409).send({ success: false, error: 'only an order on printer hold that is not at a printer yet' });
    }
    const jobId = await generator.queueGenerate(paymentId, request.clientIp, '', true, true, false);
    return { success: true, jobId };
  });
}
