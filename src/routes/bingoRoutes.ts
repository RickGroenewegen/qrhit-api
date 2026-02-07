import { FastifyInstance } from 'fastify';
import Bingo, { BingoTrack, BINGO_UPGRADE_PRICE, calculateBingoUpgradePrice } from '../bingo';
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
import { createMollieClient, Locale } from '@mollie/api-client';

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

export default async function bingoRoutes(
  fastify: FastifyInstance,
  getAuthHandler?: any
) {
  const bingo = Bingo.getInstance();
  const pdf = new PDF();
  const logger = new Logger();
  const prisma = PrismaInstance.getInstance();
  const translation = new Translation();
  const utils = new Utils();
  const cache = CacheInstance.getInstance();

  // Daily generation limit (disabled in development)
  const DAILY_GENERATION_LIMIT = 5;
  const isDevelopment = process.env['NODE_ENV'] !== 'production';

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
   * Count today's bingo generations for a user (by userHash)
   */
  async function getTodayGenerationCount(userHash: string): Promise<number> {
    // Get start of today (UTC)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const result = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count
      FROM bingo_files bf
      JOIN payment_has_playlist php ON php.id = bf.paymentHasPlaylistId
      JOIN payments p ON p.id = php.paymentId
      JOIN users u ON u.id = p.userId
      WHERE u.hash = ${userHash}
      AND bf.createdAt >= ${today}
    `;

    return Number(result[0]?.count || 0);
  }

  /**
   * Verify user owns a bingo file and can delete it
   */
  async function verifyBingoFileOwnership(
    filename: string,
    userId: number
  ): Promise<{ success: boolean; bingoFile?: any; error?: string }> {
    const bingoFile = await prisma.bingoFile.findFirst({
      where: {
        filename,
      },
      include: {
        paymentHasPlaylist: {
          include: {
            payment: true,
          },
        },
      },
    });

    if (!bingoFile) {
      return { success: false, error: 'Bingo file not found' };
    }

    // Check if the user owns this bingo file (through the payment)
    if (bingoFile.paymentHasPlaylist.payment.userId !== userId) {
      return { success: false, error: 'Unauthorized' };
    }

    return { success: true, bingoFile };
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

      // Check daily generation limit (skip in development)
      if (!isDevelopment) {
        const todayCount = await getTodayGenerationCount(userHash);
        if (todayCount >= DAILY_GENERATION_LIMIT) {
          return reply.status(429).send({
            success: false,
            error: `dailyLimitReached`,
            limit: DAILY_GENERATION_LIMIT,
          });
        }
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

      // Check if bingo is enabled for this order
      const php = await prisma.paymentHasPlaylist.findFirst({
        where: { id: playlistInfo.paymentHasPlaylistId },
        select: { gamesEnabled: true }
      });

      if (php?.gamesEnabled === false) {
        return reply.status(403).send({ success: false, error: 'bingoNotEnabled' });
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
      // Save the trackIds that were used so the host screen can filter to just these tracks
      const usedTrackIds = bingoTracks.map((t) => t.trackId);
      await prisma.bingoFile.create({
        data: {
          paymentHasPlaylistId: playlistInfo.paymentHasPlaylistId,
          filename: zipFilename,
          contestants,
          rounds,
          trackCount: bingoTracks.length,
          selectedTrackIds: usedTrackIds,
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

        // Add bingo numbers to tracks (1-based index)
        bingoTracks = bingoTracks.map((track, index) => ({
          ...track,
          bingoNumber: index + 1,
        }));

        const contestantCount = parseInt(contestants) || 10;
        const roundCount = parseInt(rounds) || 3;

        // Generate bingo sheets
        const sheets = bingo.generateSheets(bingoTracks, contestantCount, roundCount);

        // Generate QR data for each sheet
        const sheetsWithQR = sheets.map((sheet) => ({
          ...sheet,
          qrData: bingo.generateQRData(sheet),
        }));

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
          sheets: sheetsWithQR,
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

        // Add bingo numbers to tracks (1-based index)
        bingoTracks = bingoTracks.map((track, index) => ({
          ...track,
          bingoNumber: index + 1,
        }));

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

  /**
   * GET /api/bingo/host/:filename
   * Get host data for bingo verification (tracks with bingoNumbers)
   */
  if (getAuthHandler) {
    fastify.get(
      '/api/bingo/host/:filename',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const { filename } = request.params;
          const userIdString = request.user?.userId;

          if (!filename || !userIdString) {
            return reply.status(400).send({
              success: false,
              error: 'Missing required parameters',
            });
          }

          // Look up user to get database ID
          const user = await prisma.user.findUnique({
            where: { userId: userIdString },
          });

          if (!user) {
            return reply.status(401).send({
              success: false,
              error: 'User not found',
            });
          }

          // Verify ownership of the bingo file
          const { success, bingoFile, error } = await verifyBingoFileOwnership(
            filename,
            user.id
          );

          if (!success || !bingoFile) {
            return reply.status(401).send({
              success: false,
              error: error || 'Unauthorized',
            });
          }

          // Get playlist info through the payment has playlist relation
          const playlistDbId = bingoFile.paymentHasPlaylist.playlistId;

          // Get playlist name
          const playlist = await prisma.playlist.findUnique({
            where: { id: playlistDbId },
            select: { name: true },
          });

          // Get tracks for the playlist
          let bingoTracks = await getPlaylistTracks(playlistDbId);

          // Filter to only the tracks that were used in this bingo game
          const selectedTrackIds = bingoFile.selectedTrackIds as string[] | null;
          if (selectedTrackIds && Array.isArray(selectedTrackIds) && selectedTrackIds.length > 0) {
            const selectedSet = new Set(selectedTrackIds);
            bingoTracks = bingoTracks.filter((track) => selectedSet.has(track.trackId));
          }

          // Add bingo numbers to tracks (1-based index)
          const tracksWithNumbers = bingoTracks.map((track, index) => ({
            ...track,
            bingoNumber: index + 1,
          }));

          return reply.send({
            success: true,
            playlistName: playlist?.name || 'Unknown Playlist',
            tracks: tracksWithNumbers,
            rounds: bingoFile.rounds,
            contestants: bingoFile.contestants,
            trackCount: bingoFile.trackCount,
          });
        } catch (error: any) {
          logger.log(color.red.bold(`Error in GET /api/bingo/host: ${error.message}`));
          return reply.status(500).send({
            success: false,
            error: 'Failed to get host data',
          });
        }
      }
    );
  }

  /**
   * DELETE /api/bingo/file/:filename
   * Delete a bingo file (requires authentication)
   */
  if (getAuthHandler) {
    fastify.delete(
      '/api/bingo/file/:filename',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const { filename } = request.params;
          const userIdString = request.user?.userId;

          if (!filename || !userIdString) {
            return reply.status(400).send({
              success: false,
              error: 'Missing required parameters',
            });
          }

          // Look up user to get database ID
          const user = await prisma.user.findUnique({
            where: { userId: userIdString },
          });

          if (!user) {
            return reply.status(401).send({
              success: false,
              error: 'User not found',
            });
          }

          // Verify ownership
          const { success, bingoFile, error } = await verifyBingoFileOwnership(
            filename,
            user.id
          );

          if (!success || !bingoFile) {
            return reply.status(401).send({
              success: false,
              error: error || 'Unauthorized',
            });
          }

          // Delete the file from disk
          const publicDir = process.env['PUBLIC_DIR'] || '/tmp';
          const filePath = path.join(publicDir, 'bingo', filename);

          try {
            await fs.unlink(filePath);
            logger.log(color.blue.bold(`Deleted bingo file: ${white.bold(filename)}`));
          } catch (unlinkError: any) {
            // File might not exist on disk, but we still delete from DB
            if (unlinkError.code !== 'ENOENT') {
              logger.log(color.yellow.bold(`Warning: Could not delete file ${filename}: ${unlinkError.message}`));
            }
          }

          // Delete from database
          await prisma.bingoFile.delete({
            where: {
              id: bingoFile.id,
            },
          });

          return reply.send({
            success: true,
          });
        } catch (error: any) {
          logger.log(color.red.bold(`Error in DELETE /api/bingo/file: ${error.message}`));
          return reply.status(500).send({
            success: false,
            error: 'Failed to delete bingo file',
          });
        }
      }
    );
  }

  /**
   * POST /api/bingo/calculate-price
   * Calculate price for enabling bingo on multiple playlists (with volume discounts)
   * Requires authentication
   */
  if (getAuthHandler) {
    fastify.post(
      '/api/bingo/calculate-price',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const { paymentHasPlaylistIds } = request.body;
          const userIdString = request.user?.userId;

          if (!paymentHasPlaylistIds || !Array.isArray(paymentHasPlaylistIds) || paymentHasPlaylistIds.length === 0) {
            return reply.status(400).send({
              success: false,
              error: 'Missing required parameters: paymentHasPlaylistIds array',
            });
          }

          // Look up user to get database ID
          const user = await prisma.user.findUnique({
            where: { userId: userIdString },
          });

          if (!user) {
            return reply.status(401).send({
              success: false,
              error: 'User not found',
            });
          }

          // Validate all playlist IDs belong to user
          const phpIds = paymentHasPlaylistIds.map((id: any) => parseInt(id));
          const playlists = await prisma.paymentHasPlaylist.findMany({
            where: { id: { in: phpIds } },
            include: {
              payment: true,
              playlist: true,
            },
          });

          // Verify all playlists exist and belong to user
          if (playlists.length !== phpIds.length) {
            return reply.status(404).send({
              success: false,
              error: 'One or more playlists not found',
            });
          }

          for (const php of playlists) {
            if (php.payment.userId !== user.id) {
              return reply.status(403).send({
                success: false,
                error: 'Unauthorized access to one or more playlists',
              });
            }
            if (php.gamesEnabled) {
              return reply.status(400).send({
                success: false,
                error: `Bingo is already enabled for playlist: ${php.playlist.name}`,
              });
            }
            if (php.numberOfTracks < 75) {
              return reply.status(400).send({
                success: false,
                error: `Music Bingo requires at least 75 tracks. "${php.playlist.name}" has ${php.numberOfTracks} tracks.`,
              });
            }
          }

          // Calculate pricing with volume discount
          const pricing = calculateBingoUpgradePrice(playlists.length);

          return reply.send({
            success: true,
            count: playlists.length,
            basePrice: BINGO_UPGRADE_PRICE,
            ...pricing,
            playlists: playlists.map((php) => ({
              paymentHasPlaylistId: php.id,
              playlistName: php.playlist.name,
              playlistImage: php.playlist.image,
              numberOfTracks: php.numberOfTracks,
            })),
          });
        } catch (error: any) {
          logger.log(color.red.bold(`Error in POST /api/bingo/calculate-price: ${error.message}`));
          return reply.status(500).send({
            success: false,
            error: 'Failed to calculate price',
          });
        }
      }
    );
  }

  /**
   * POST /api/bingo/enable-payment
   * Create a Mollie payment to enable bingo on multiple playlists (with volume discounts)
   * Requires authentication
   */
  if (getAuthHandler) {
    fastify.post(
      '/api/bingo/enable-payment',
      getAuthHandler(['users']),
      async (request: any, reply: any) => {
        try {
          const { paymentHasPlaylistIds, locale } = request.body;
          const userIdString = request.user?.userId;

          if (!paymentHasPlaylistIds || !Array.isArray(paymentHasPlaylistIds) || paymentHasPlaylistIds.length === 0) {
            return reply.status(400).send({
              success: false,
              error: 'Missing required parameters: paymentHasPlaylistIds array',
            });
          }

          // Look up user to get database ID
          const user = await prisma.user.findUnique({
            where: { userId: userIdString },
          });

          if (!user) {
            return reply.status(401).send({
              success: false,
              error: 'User not found',
            });
          }

          // Validate all playlist IDs belong to user
          const phpIds = paymentHasPlaylistIds.map((id: any) => parseInt(id));
          const playlists = await prisma.paymentHasPlaylist.findMany({
            where: { id: { in: phpIds } },
            include: {
              payment: true,
              playlist: true,
            },
          });

          // Verify all playlists exist and belong to user
          if (playlists.length !== phpIds.length) {
            return reply.status(404).send({
              success: false,
              error: 'One or more playlists not found',
            });
          }

          const playlistNames: string[] = [];
          for (const php of playlists) {
            if (php.payment.userId !== user.id) {
              return reply.status(403).send({
                success: false,
                error: 'Unauthorized',
              });
            }
            if (php.gamesEnabled) {
              return reply.status(400).send({
                success: false,
                error: `Bingo is already enabled for playlist: ${php.playlist.name}`,
              });
            }
            if (php.numberOfTracks < 75) {
              return reply.status(400).send({
                success: false,
                error: `Music Bingo requires at least 75 tracks. "${php.playlist.name}" has ${php.numberOfTracks} tracks.`,
              });
            }
            playlistNames.push(php.playlist.name);
          }

          // Calculate pricing with volume discount
          const pricing = calculateBingoUpgradePrice(playlists.length);

          // Create Mollie payment for bingo upgrade
          const mollieClient = createMollieClient({
            apiKey: process.env['MOLLIE_API_KEY']!,
          });

          // Get locale mapping
          const localeMap: { [key: string]: string } = {
            en: 'en_US',
            nl: 'nl_NL',
            de: 'de_DE',
            fr: 'fr_FR',
            es: 'es_ES',
            it: 'it_IT',
            pt: 'pt_PT',
            pl: 'pl_PL',
          };
          const mollieLocale = (localeMap[locale || 'en'] || 'en_US') as Locale;
          const userLocale = locale || 'en';

          // Build description
          const description = playlists.length === 1
            ? `Music Bingo - ${playlistNames[0]}`
            : `Music Bingo - ${playlists.length} playlists`;

          const payment = await mollieClient.payments.create({
            amount: {
              currency: 'EUR',
              value: pricing.totalPrice.toFixed(2),
            },
            metadata: {
              type: 'bingo_upgrade',
              paymentHasPlaylistIds: phpIds.join(','),
              userId: user.id.toString(),
              pricePerPlaylist: pricing.pricePerPlaylist.toString(),
            },
            description,
            redirectUrl: `${process.env['FRONTEND_URI']}/${userLocale}/my-account`,
            webhookUrl: `${process.env['API_URI']}/mollie/webhook`,
            locale: mollieLocale,
          });

          const checkoutUrl = payment.getCheckoutUrl();

          logger.log(
            color.blue.bold(`Created bingo upgrade payment: ${white.bold(payment.id)} for ${white.bold(playlists.length.toString())} playlists (${white.bold('€' + pricing.totalPrice.toFixed(2))})`)
          );

          return reply.send({
            success: true,
            paymentUrl: checkoutUrl,
            paymentId: payment.id,
          });
        } catch (error: any) {
          logger.log(color.red.bold(`Error in POST /api/bingo/enable-payment: ${error.message}`));
          console.error(error);
          return reply.status(500).send({
            success: false,
            error: 'Failed to create bingo upgrade payment',
          });
        }
      }
    );
  }
}
