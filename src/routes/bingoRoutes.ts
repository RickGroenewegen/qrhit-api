import { FastifyInstance } from 'fastify';
import Bingo, { BingoTrack, BingoSheet } from '../bingo';
import PDF from '../pdf';
import Logger from '../logger';
import { color, white } from 'console-log-colors';
import PrismaInstance from '../prisma';
import * as fs from 'fs/promises';
import * as path from 'path';
import crypto from 'crypto';

interface TrackRow {
  id: number;
  trackId: string;
  name: string;
  artist: string;
  year: number | null;
  trackOrder: number;
}

interface PlaylistInfoRow {
  playlistName: string;
  playlistId: string;
  playlistDbId: number;
}

export default async function bingoRoutes(fastify: FastifyInstance) {
  const bingo = Bingo.getInstance();
  const pdf = new PDF();
  const logger = new Logger();
  const prisma = PrismaInstance.getInstance();

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
        pl.id as playlistDbId
      FROM payments p
      JOIN users u ON p.userId = u.id
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      WHERE p.paymentId = ${paymentId}
      AND u.hash = ${userHash}
      AND pl.playlistId = ${playlistId}
      AND p.status = 'paid'
      LIMIT 1
    `;

    if (result.length === 0) {
      return { success: false, error: 'Unauthorized or playlist not found' };
    }

    return { success: true, playlistInfo: result[0] };
  }

  /**
   * Get tracks for a playlist
   */
  async function getPlaylistTracks(playlistDbId: number): Promise<BingoTrack[]> {
    const tracks = await prisma.$queryRaw<TrackRow[]>`
      SELECT
        t.id,
        t.trackId,
        COALESCE(NULLIF(tei.name, ''), t.name) as name,
        COALESCE(NULLIF(tei.artist, ''), t.artist) as artist,
        COALESCE(tei.year, t.year) as year,
        pht.\`order\` as trackOrder
      FROM playlist_has_tracks pht
      JOIN tracks t ON t.id = pht.trackId
      LEFT JOIN trackextrainfo tei ON tei.trackId = t.id AND tei.playlistId = pht.playlistId
      WHERE pht.playlistId = ${playlistDbId}
      ORDER BY pht.\`order\` ASC
    `;

    return tracks.map((track) => ({
      id: track.id,
      trackId: track.trackId,
      name: track.name,
      artist: track.artist,
      year: track.year || 0,
    }));
  }

  /**
   * POST /api/bingo/preview
   * Get tracks and validate bingo configuration
   */
  fastify.post('/api/bingo/preview', async (request: any, reply: any) => {
    try {
      const { paymentId, userHash, playlistId, contestants, rounds } = request.body;

      // Validate required fields
      if (!paymentId || !userHash || !playlistId) {
        return reply.status(400).send({
          success: false,
          error: 'Missing required fields: paymentId, userHash, playlistId',
        });
      }

      // Verify access to the playlist
      const { success, playlistInfo, error } = await verifyAndGetPlaylist(
        paymentId,
        userHash,
        playlistId
      );

      if (!success || !playlistInfo) {
        return reply.status(401).send({
          success: false,
          error: error || 'Unauthorized',
        });
      }

      // Get tracks for the playlist
      const bingoTracks = await getPlaylistTracks(playlistInfo.playlistDbId);
      const trackCount = bingoTracks.length;

      // Default values if not provided
      const contestantCount = contestants || 10;
      const roundCount = rounds || 3;

      // Validate configuration
      const validation = bingo.validateConfig(trackCount, contestantCount, roundCount);

      return reply.send({
        success: true,
        tracks: bingoTracks,
        trackCount,
        playlistName: playlistInfo.playlistName,
        validation,
        contestants: contestantCount,
        rounds: roundCount,
      });
    } catch (error: any) {
      logger.log(color.red.bold(`Error in /api/bingo/preview: ${error.message}`));
      return reply.status(500).send({
        success: false,
        error: 'Failed to get bingo preview',
      });
    }
  });

  /**
   * POST /api/bingo/generate
   * Generate bingo sheets PDF
   */
  fastify.post('/api/bingo/generate', async (request: any, reply: any) => {
    try {
      const { paymentId, userHash, playlistId, contestants, rounds, locale } = request.body;

      // Validate required fields
      if (!paymentId || !userHash || !playlistId || !contestants || !rounds) {
        return reply.status(400).send({
          success: false,
          error: 'Missing required fields',
        });
      }

      // Validate numbers
      if (contestants < 1 || contestants > 100) {
        return reply.status(400).send({
          success: false,
          error: 'Contestants must be between 1 and 100',
        });
      }

      if (rounds < 1 || rounds > 10) {
        return reply.status(400).send({
          success: false,
          error: 'Rounds must be between 1 and 10',
        });
      }

      // Verify access to the playlist
      const { success, playlistInfo, error } = await verifyAndGetPlaylist(
        paymentId,
        userHash,
        playlistId
      );

      if (!success || !playlistInfo) {
        return reply.status(401).send({
          success: false,
          error: error || 'Unauthorized',
        });
      }

      // Get tracks for the playlist
      const bingoTracks = await getPlaylistTracks(playlistInfo.playlistDbId);

      // Validate minimum tracks
      if (bingoTracks.length < 75) {
        return reply.status(400).send({
          success: false,
          error: `Minimum 75 tracks required for Music Bingo. Current: ${bingoTracks.length}`,
        });
      }

      // Generate bingo sheets
      const sheets = bingo.generateSheets(bingoTracks, contestants, rounds);

      // Generate unique filename
      const timestamp = Date.now();
      const hash = crypto.randomBytes(8).toString('hex');
      const filename = `bingo_${paymentId}_${timestamp}_${hash}.pdf`;
      const publicDir = process.env['PUBLIC_DIR'] || '/tmp';
      const pdfDir = path.join(publicDir, 'pdf');
      const filePath = path.join(pdfDir, filename);

      // Ensure directory exists
      await fs.mkdir(pdfDir, { recursive: true });

      // Render HTML using EJS template
      const apiUri = process.env['API_URI'] || 'http://localhost:3004';
      const htmlUrl = `${apiUri}/bingo/render/${paymentId}/${userHash}/${playlistId}?contestants=${contestants}&rounds=${rounds}&locale=${locale || 'en'}&t=${timestamp}`;

      logger.log(color.blue.bold(`Generating bingo PDF from URL: ${white.bold(htmlUrl)}`));

      // Use the PDF class to generate PDF
      const pdfBuffer = await pdf.generatePdfFromUrl(htmlUrl, {
        format: 'A4',
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
        preferCSSPageSize: true,
      });

      // Save PDF to file
      await fs.writeFile(filePath, pdfBuffer);

      logger.log(
        color.green.bold(`Bingo PDF generated: ${white.bold(filename)} (${sheets.length} sheets)`)
      );

      // Return download URL
      const downloadUrl = `${apiUri}/public/pdf/${filename}`;

      return reply.send({
        success: true,
        downloadUrl,
        filename,
        sheetsGenerated: sheets.length,
        contestants,
        rounds,
      });
    } catch (error: any) {
      logger.log(color.red.bold(`Error in /api/bingo/generate: ${error.message}`));
      return reply.status(500).send({
        success: false,
        error: 'Failed to generate bingo PDF',
      });
    }
  });

  /**
   * GET /bingo/render/:paymentId/:userHash/:playlistId
   * Render bingo HTML for PDF generation (internal use)
   */
  fastify.get(
    '/bingo/render/:paymentId/:userHash/:playlistId',
    async (request: any, reply: any) => {
      try {
        const { paymentId, userHash, playlistId } = request.params;
        const { contestants, rounds, locale } = request.query;

        // Verify access to the playlist
        const { success, playlistInfo, error } = await verifyAndGetPlaylist(
          paymentId,
          userHash,
          playlistId
        );

        if (!success || !playlistInfo) {
          return reply.status(401).send('Unauthorized');
        }

        // Get tracks for the playlist
        const bingoTracks = await getPlaylistTracks(playlistInfo.playlistDbId);

        const contestantCount = parseInt(contestants) || 10;
        const roundCount = parseInt(rounds) || 3;

        // Generate bingo sheets
        const sheets = bingo.generateSheets(bingoTracks, contestantCount, roundCount);

        // Localized text
        const freeSpaceText = 'QR Song';
        const freeLabel = 'FREE';

        // Render EJS template
        return reply.view('pdf_bingo', {
          sheets,
          playlistName: playlistInfo.playlistName,
          contestants: contestantCount,
          rounds: roundCount,
          freeSpaceText,
          freeLabel,
        });
      } catch (error: any) {
        logger.log(color.red.bold(`Error in /bingo/render: ${error.message}`));
        return reply.status(500).send('Failed to render bingo template');
      }
    }
  );
}
