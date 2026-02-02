import { FastifyInstance } from 'fastify';
import Bingo, { BingoTrack } from '../bingo';
import PDF from '../pdf';
import Logger from '../logger';
import { color, white } from 'console-log-colors';
import PrismaInstance from '../prisma';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import Translation from '../translation';
import Utils from '../utils';
import CacheInstance from '../cache';

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
  paymentHasPlaylistId: number;
  qrSubDir: string | null;
}

export default async function bingoRoutes(fastify: FastifyInstance) {
  const bingo = Bingo.getInstance();
  const pdf = new PDF();
  const logger = new Logger();
  const prisma = PrismaInstance.getInstance();
  const translation = new Translation();
  const utils = new Utils();
  const cache = CacheInstance.getInstance();

  /**
   * Verify payment ownership and get playlist info including QR subdir
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
        php.id as paymentHasPlaylistId,
        p.qrSubDir as qrSubDir
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
   * Create a ZIP file containing bingo PDFs
   */
  async function createBingoZip(
    zipPath: string,
    bingoPdfPath: string,
    hostCardsPdfPath: string | null,
    playlistName: string,
    bingoCardsLabel: string,
    hostCardsLabel: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver('zip', {
        zlib: { level: 9 },
      });

      output.on('close', () => {
        resolve();
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);

      // Add bingo sheets PDF
      archive.file(bingoPdfPath, { name: `${playlistName} - ${bingoCardsLabel}.pdf` });

      // Add host cards PDF if exists
      if (hostCardsPdfPath) {
        archive.file(hostCardsPdfPath, { name: `${playlistName} - ${hostCardsLabel}.pdf` });
      }

      archive.finalize();
    });
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

      // Get existing bingo files for this playlist
      const existingBingoFiles = await prisma.bingoFile.findMany({
        where: {
          paymentHasPlaylistId: playlistInfo.paymentHasPlaylistId,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return reply.send({
        success: true,
        tracks: bingoTracks,
        trackCount,
        playlistName: playlistInfo.playlistName,
        validation,
        contestants: contestantCount,
        rounds: roundCount,
        existingBingoFiles: existingBingoFiles.map((f) => ({
          filename: f.filename,
          contestants: f.contestants,
          rounds: f.rounds,
          trackCount: f.trackCount,
          createdAt: f.createdAt,
        })),
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
   * Generate bingo sheets PDF and host cards, package in ZIP
   */
  fastify.post('/api/bingo/generate', async (request: any, reply: any) => {
    try {
      const { paymentId, userHash, playlistId, contestants, rounds, locale, selectedTracks, generateHostCards } = request.body;

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

      // Validate total sheets limit
      const totalSheets = contestants * rounds;
      if (totalSheets > 500) {
        return reply.status(400).send({
          success: false,
          error: `Maximum 500 sheets allowed. Current configuration: ${totalSheets} sheets (${contestants} contestants × ${rounds} rounds)`,
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
      let bingoTracks = await getPlaylistTracks(playlistInfo.playlistDbId);

      // Filter tracks if selectedTracks is provided
      if (selectedTracks && Array.isArray(selectedTracks) && selectedTracks.length > 0) {
        const selectedSet = new Set(selectedTracks);
        bingoTracks = bingoTracks.filter((track) => selectedSet.has(track.trackId));
      }

      // Validate minimum tracks for variety
      const minimumTracks = Math.max(40, 24 + Math.ceil(contestants / 2));
      if (bingoTracks.length < minimumTracks) {
        return reply.status(400).send({
          success: false,
          error: `Minimum ${minimumTracks} tracks required for ${contestants} contestants. Selected: ${bingoTracks.length}`,
        });
      }

      // Generate bingo sheets
      const sheets = bingo.generateSheets(bingoTracks, contestants, rounds);

      // Generate unique filenames
      const hash = crypto.randomBytes(8).toString('hex');
      const publicDir = process.env['PUBLIC_DIR'] || '/tmp';
      const bingoDir = path.join(publicDir, 'bingo');
      const apiUri = process.env['API_URI'] || 'http://localhost:3004';

      // Ensure directory exists
      await fs.mkdir(bingoDir, { recursive: true });

      // File paths
      const bingoPdfFilename = `bingo_${hash}.pdf`;
      const hostCardsPdfFilename = `hostcards_${hash}.pdf`;
      const sanitizedPlaylistName = utils.generateFilename(playlistInfo.playlistName).substring(0, 50);
      const zipFilename = `${paymentId}_${sanitizedPlaylistName}_bingo.zip`;

      const bingoPdfPath = path.join(bingoDir, bingoPdfFilename);
      const hostCardsPdfPath = path.join(bingoDir, hostCardsPdfFilename);
      const zipPath = path.join(bingoDir, zipFilename);

      // Store bingo config in cache to avoid long URLs (expires in 5 minutes)
      const configId = hash;
      const bingoConfig = {
        paymentId,
        userHash,
        playlistId,
        contestants,
        rounds,
        locale: locale || 'en',
        selectedTracks: selectedTracks || [],
      };
      await cache.set(`bingo_config:${configId}`, JSON.stringify(bingoConfig), 300);

      // Generate bingo cards PDF
      const htmlUrl = `${apiUri}/bingo/render/${configId}`;
      logger.log(color.blue.bold(`Generating bingo PDF from: ${white.bold(htmlUrl)}`));

      const pdfBuffer = await pdf.generatePdfFromUrl(htmlUrl, {
        format: 'A4',
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
        preferCSSPageSize: true,
      });

      await fs.writeFile(bingoPdfPath, pdfBuffer);

      logger.log(
        color.green.bold(`Bingo PDF generated: ${white.bold(bingoPdfFilename)} (${sheets.length} sheets)`)
      );

      // Generate host cards PDF (always generated)
      let hostCardsPdfFinalPath: string | null = null;
      if (generateHostCards) {
        const hostCardsHtmlUrl = `${apiUri}/bingo/render-hostcards/${configId}`;
        logger.log(color.blue.bold(`Generating host cards PDF from: ${white.bold(hostCardsHtmlUrl)}`));

        const hostCardsPdfBuffer = await pdf.generatePdfFromUrl(hostCardsHtmlUrl, {
          format: 'A4',
          marginTop: 0,
          marginRight: 0,
          marginBottom: 0,
          marginLeft: 0,
          preferCSSPageSize: true,
        });

        await fs.writeFile(hostCardsPdfPath, hostCardsPdfBuffer);
        hostCardsPdfFinalPath = hostCardsPdfPath;

        logger.log(
          color.green.bold(`Host cards PDF generated: ${white.bold(hostCardsPdfFilename)} (${bingoTracks.length} cards)`)
        );
      }

      // Clean up config from cache
      await cache.del(`bingo_config:${configId}`);

      // Create ZIP file with translated file names
      const validLocale = translation.isValidLocale(locale) ? locale : 'en';
      const bingoCardsLabel = translation.translate('bingo_pdf.bingoCardsFilename', validLocale);
      const hostCardsLabel = translation.translate('bingo_pdf.hostCardsFilename', validLocale);
      await createBingoZip(zipPath, bingoPdfPath, hostCardsPdfFinalPath, playlistInfo.playlistName, bingoCardsLabel, hostCardsLabel);

      logger.log(color.green.bold(`Bingo ZIP created: ${white.bold(zipFilename)}`));

      // Clean up individual PDF files (keep only ZIP)
      await fs.unlink(bingoPdfPath).catch(() => {});
      if (hostCardsPdfFinalPath) {
        await fs.unlink(hostCardsPdfFinalPath).catch(() => {});
      }

      // Store the bingo file in database for future downloads
      await prisma.bingoFile.create({
        data: {
          paymentHasPlaylistId: playlistInfo.paymentHasPlaylistId,
          filename: zipFilename,
          contestants,
          rounds,
          trackCount: bingoTracks.length,
        },
      });

      // Return download URL
      const downloadUrl = `${apiUri}/public/bingo/${zipFilename}`;

      return reply.send({
        success: true,
        downloadUrl,
        filename: zipFilename,
        sheetsGenerated: sheets.length,
        contestants,
        rounds,
      });
    } catch (error: any) {
      logger.log(color.red.bold(`Error in /api/bingo/generate: ${error.message}`));
      console.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to generate bingo PDF',
      });
    }
  });

  /**
   * GET /bingo/render/:configId
   * Render bingo HTML for PDF generation (internal use)
   */
  fastify.get(
    '/bingo/render/:configId',
    async (request: any, reply: any) => {
      try {
        const { configId } = request.params;

        // Read config from cache
        const configData = await cache.get(`bingo_config:${configId}`, false);
        if (!configData) {
          return reply.status(404).send('Config not found or expired');
        }

        const config = JSON.parse(configData);

        const { paymentId, userHash, playlistId, contestants, rounds, locale, selectedTracks } = config;

        // Verify access to the playlist
        const { success, playlistInfo } = await verifyAndGetPlaylist(
          paymentId,
          userHash,
          playlistId
        );

        if (!success || !playlistInfo) {
          return reply.status(401).send('Unauthorized');
        }

        // Get tracks for the playlist
        let bingoTracks = await getPlaylistTracks(playlistInfo.playlistDbId);

        // Filter tracks if selectedTracks is provided
        if (selectedTracks && Array.isArray(selectedTracks) && selectedTracks.length > 0) {
          const selectedSet = new Set(selectedTracks);
          bingoTracks = bingoTracks.filter((track) => selectedSet.has(track.trackId));
        }

        const contestantCount = parseInt(contestants) || 10;
        const roundCount = parseInt(rounds) || 3;

        // Generate bingo sheets
        const sheets = bingo.generateSheets(bingoTracks, contestantCount, roundCount);

        // API URI for assets
        const apiUri = process.env['API_URI'] || 'http://localhost:3004';

        // Get translations for the requested locale
        const validLocale = translation.isValidLocale(locale) ? locale : 'en';
        const t = {
          title: translation.translate('bingo_pdf.title', validLocale),
          roundInfo: (round: number) =>
            translation.translate('bingo_pdf.roundInfo', validLocale, { round }),
          footerBranding: translation.translate('bingo_pdf.footerBranding', validLocale),
          footerGenerator: translation.translate('bingo_pdf.footerGenerator', validLocale),
        };

        // Render EJS template
        return reply.view('pdf_bingo', {
          sheets,
          playlistName: playlistInfo.playlistName,
          contestants: contestantCount,
          rounds: roundCount,
          apiUri,
          t,
        });
      } catch (err: any) {
        logger.log(color.red.bold(`Error in /bingo/render: ${err.message}`));
        return reply.status(500).send('Failed to render bingo template');
      }
    }
  );

  /**
   * GET /bingo/render-hostcards/:configId
   * Render host cards HTML for PDF generation (internal use)
   */
  fastify.get(
    '/bingo/render-hostcards/:configId',
    async (request: any, reply: any) => {
      try {
        const { configId } = request.params;

        // Read config from cache
        const configData = await cache.get(`bingo_config:${configId}`, false);
        if (!configData) {
          return reply.status(404).send('Config not found or expired');
        }

        const config = JSON.parse(configData);
        const { paymentId, userHash, playlistId, selectedTracks } = config;

        // Verify access to the playlist
        const { success, playlistInfo } = await verifyAndGetPlaylist(
          paymentId,
          userHash,
          playlistId
        );

        if (!success || !playlistInfo) {
          return reply.status(401).send('Unauthorized');
        }

        // Get tracks for the playlist
        let bingoTracks = await getPlaylistTracks(playlistInfo.playlistDbId);

        // Filter tracks if selectedTracks is provided
        if (selectedTracks && Array.isArray(selectedTracks) && selectedTracks.length > 0) {
          const selectedSet = new Set(selectedTracks);
          bingoTracks = bingoTracks.filter((track) => selectedSet.has(track.trackId));
        }

        // Get QR code URLs for each track using the payment's qrSubDir
        const apiUri = process.env['API_URI'] || 'http://localhost:3004';
        const qrSubDir = playlistInfo.qrSubDir;

        if (!qrSubDir) {
          return reply.status(400).send('QR codes not yet generated for this playlist');
        }

        const tracksWithQr = bingoTracks.map((track) => ({
          ...track,
          qrUrl: `${apiUri}/public/qr/${qrSubDir}/${track.trackId}.png`,
        }));

        // Render EJS template
        return reply.view('pdf_bingo_hostcards', {
          tracks: tracksWithQr,
          playlistName: playlistInfo.playlistName,
          apiUri,
        });
      } catch (err: any) {
        logger.log(color.red.bold(`Error in /bingo/render-hostcards: ${err.message}`));
        return reply.status(500).send('Failed to render host cards template');
      }
    }
  );
}
