import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import { MAX_CARDS, MAX_CARDS_PHYSICAL } from './config/constants';
import PrismaInstance from './prisma';
import Utils from './utils';
import Mollie from './mollie';
import crypto from 'crypto';
import sanitizeFilename from 'sanitize-filename';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import * as path from 'path';
import Data from './data';
import PushoverClient from './pushover';
import Spotify from './spotify';
import Mail from './mail';
import QR from './qr';
import PDF from './pdf';
import Order from './order';
import AnalyticsClient from './analytics';
import { CronJob } from 'cron';
import cluster from 'cluster';
import { Track } from '@prisma/client';
import Discount from './discount';
import { ApiResult } from './interfaces/ApiResult';
import Cache from './cache';
import archiver from 'archiver';

class Generator {
  private static instance: Generator;
  private logger = new Logger();
  private utils = new Utils();
  private prisma = PrismaInstance.getInstance();
  private data = Data.getInstance();
  private pushover = new PushoverClient();
  private spotify = Spotify.getInstance();
  private mail = Mail.getInstance();
  private qr = new QR();
  private pdf = new PDF();
  private order = Order.getInstance();
  private analytics = AnalyticsClient.getInstance();
  private discount = new Discount();
  private cache = Cache.getInstance();

  private constructor() {
    this.setCron();
  }

  public static getInstance(): Generator {
    if (!Generator.instance) {
      Generator.instance = new Generator();
    }
    return Generator.instance;
  }

  private setCron() {
    const isPrimary = cluster.isPrimary;

    if (isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.setSendToPrinterCron();
        }
      });
    }
  }

  public setSendToPrinterCron() {
    // Setup printer check cron
    new CronJob(
      '0 * * * *',
      async () => {
        const payments = await this.prisma.payment.findMany({
          where: {
            sentToPrinter: false,
            vibe: false,
            OR: [
              {
                canBeSentToPrinter: true,
                userAgreedToPrinting: true,
              },
              {
                canBeSentToPrinter: true,
                canBeSentToPrinterAt: {
                  lte: new Date(),
                },
              },
            ],
          },
          include: {
            PaymentHasPlaylist: {
              select: {
                suggestionsPending: true,
              },
            },
          },
        });

        // Filter payments to only include those where all PaymentHasPlaylist records have suggestionsPending = false
        const eligiblePayments = payments.filter((payment) =>
          payment.PaymentHasPlaylist.every(
            (php) => php.suggestionsPending === false
          )
        );

        if (eligiblePayments.length > 0) {
          this.logger.log(
            blue.bold(
              `Found ${white.bold(
                eligiblePayments.length.toString()
              )} payments ready to be sent to printer`
            )
          );

          for (const payment of eligiblePayments) {
            try {
              await this.sendToPrinter(payment.paymentId, '');
              this.logger.log(
                color.green.bold(
                  `Successfully sent payment ${white.bold(
                    payment.paymentId
                  )} to printer`
                )
              );
            } catch (error) {
              this.logger.log(
                color.red.bold(
                  `Error sending payment ${white.bold(
                    payment.paymentId
                  )} to printer: ${error}`
                )
              );
            }
          }
        }
      },
      null,
      true,
      'Europe/Amsterdam'
    );
  }

  public async generate(
    paymentId: string,
    ip: string,
    refreshPlaylists: string,
    mollie: Mollie,
    forceFinalize: boolean = false,
    skipMainMail: boolean = false,
    onlyProductMail: boolean = false,
    userAgent: string = ''
  ): Promise<void> {
    this.logger.log(
      blue.bold(`Starting generation for payment: ${white.bold(paymentId)}`)
    );

    let orderType = 'digital';
    let productType = 'cards';

    const refreshPlaylistArray = refreshPlaylists.split(',');

    const paymentStatus = await mollie.checkPaymentStatus(paymentId);

    const userId = paymentStatus.data.payment.user.userId;
    let payment = await mollie.getPayment(paymentId);

    const user = await this.data.getUserByUserId(userId);

    // Check if the user is the same as the one who made the payment
    if (user.userId !== userId) {
      this.logger.log(
        color.red.bold('User is not the same as the one who made the payment')
      );
      return;
    }

    if (!paymentStatus.success) {
      this.logger.log(color.red.bold('Payment failed!'));
      return;
    }

    // Get all playlists associated with the payment
    const playlists = await this.data.getPlaylistsByPaymentId(paymentId);

    // Determine order type and product type
    for (const playlist of playlists) {
      if (playlist.orderType !== 'digital') {
        orderType = 'physical';
      }
      if (playlist.productType == 'giftcard') {
        productType = 'giftcard';
      }
    }

    // Send the main mail for cards
    if (productType == 'cards' && !skipMainMail && !onlyProductMail) {
      await this.mail.sendEmail('main_' + orderType, payment, playlists);
    }

    // Create a random 16 character string for the QR codes directory
    const subdir = sanitizeFilename(crypto.randomBytes(8).toString('hex'));

    // Store data and generate QR codes for each playlist
    for (const playlist of playlists) {
      if (productType == 'cards') {
        // Store playlist data
        await this.storePlaylistData(
          payment,
          playlist,
          refreshPlaylistArray.includes(playlist.playlistId),
          ip,
          userAgent
        );

        // Get tracks for QR generation
        const dbTracks = await this.data.getTracks(playlist.id, payment.userId);

        // Generate QR codes
        await this.generateQRCodes(playlist, dbTracks, subdir);

        // Update analytics
        this.analytics.increaseCounter(
          'qr',
          'generated',
          playlist.numberOfTracks
        );
        if (playlist.orderType === 'digital') {
          this.analytics.increaseCounter('purchase', 'digital', 1);
        } else {
          this.analytics.increaseCounter('purchase', 'physical', 1);
          this.analytics.increaseCounter(
            'purchase',
            'cards',
            playlist.numberOfTracks
          );
        }
      }
    }
    // Update the payment with the QR code directory
    await this.prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        qrSubDir: subdir,
      },
    });

    const allTracksChecked = await this.data.areAllTracksManuallyChecked(
      payment.paymentId
    );

    // Generate PDFs and finalize order
    if (
      productType == 'giftcard' ||
      (productType == 'cards' && allTracksChecked)
    ) {
      await this.finalizeOrder(
        payment.paymentId,
        mollie,
        forceFinalize,
        skipMainMail && !onlyProductMail
      );
    }

    let orderName = `${payment.fullname} (${payment.countrycode})`;

    let totalNumberOfTracks = 0;
    // Loop through the playlists and update the total number of tracks
    for (const playlist of playlists) {
      totalNumberOfTracks += playlist.numberOfTracks;
    }

    this.analytics.increaseCounter(
      'finance',
      'profit',
      parseInt(payment.profit)
    );
    this.analytics.increaseCounter(
      'finance',
      'turnover',
      parseInt(payment.totalPrice)
    );

    this.logger.log(
      color.green.bold(
        `Order processed successfully for payment: ${white.bold(paymentId)}`
      )
    );

    if (!skipMainMail) {
      let message = `${orderName} heeft ${
        payment.PaymentHasPlaylist.length
      } set(s) met in totaal ${totalNumberOfTracks} kaarten besteld voor totaal € ${payment.totalPrice
        .toString()
        .replace('.', ',')}.`;
      let title = `KA-CHING! € ${payment.profit
        .toString()
        .replace('.', ',')} verdiend!`;

      if (productType == 'giftcard') {
        message = `${orderName} heeft een cadeaubon van € ${(
          payment.totalPrice - (payment.shipping ? payment.shipping : 0)
        ).toFixed(2)} besteld.`;
      }

      // Pushover
      this.pushover.sendMessage(
        {
          title,
          message,
          sound: 'incoming',
        },
        ip
      );
    }
  }

  private async storePlaylistData(
    payment: any,
    playlist: any,
    refreshCache: boolean = false,
    clientIp: string = '',
    userAgent: string = ''
  ): Promise<void> {
    let exists = true;

    this.logger.log(
      blue.bold(
        `Retrieving tracks for playlist: ${white.bold(playlist.playlistId)}`
      )
    );

    if (refreshCache) {
      exists = false;
      this.logger.log(
        color.yellow.bold(
          `User has refreshed the playlist cache for playlist: ${white.bold(
            playlist.playlistId
          )} so we are regenerating the PDFs`
        )
      );
    }

    // Retrieve the tracks from Spotify
    const response = await this.spotify.getTracks(
      playlist.playlistId,
      !refreshCache,
      '',
      false,
      false,
      clientIp,
      userAgent
    );
    const tracks = response.data.tracks;

    // If there are more than 500 remove the last tracks
    if (playlist.orderType == 'digital' && tracks.length > MAX_CARDS) {
      tracks.splice(MAX_CARDS);
    } else if (
      playlist.orderType == 'physical' &&
      tracks.length > MAX_CARDS_PHYSICAL
    ) {
      tracks.splice(MAX_CARDS_PHYSICAL);
    }

    this.logger.log(
      blue.bold(
        `Storing ${white.bold(tracks.length)} tracks for playlist: ${white.bold(
          playlist.playlistId
        )}`
      )
    );

    await this.data.storeTracks(playlist.id, playlist.playlistId, tracks);

    this.logger.log(
      blue.bold(
        `Retrieving ${white.bold(
          tracks.length
        )} tracks for playlist: ${white.bold(playlist.playlistId)}`
      )
    );
    const dbTracks = await this.data.getTracks(playlist.id);
    playlist.numberOfTracks = dbTracks.length;
  }

  private async generateQRCodes(
    playlist: any,
    dbTracks: any[],
    subdir: string
  ): Promise<void> {
    this.logger.log(
      blue.bold(
        `Creating QR codes for ${white.bold(
          dbTracks.length
        )} tracks for playlist: ${white.bold(playlist.playlistId)}`
      )
    );

    const outputDir = `${process.env['PUBLIC_DIR']}/qr/${subdir}`;
    await this.utils.createDir(outputDir);

    if (process.env['ENVIRONMENT'] === 'development') {
      // Use old method in series
      for (const track of dbTracks) {
        const link = `${process.env['API_URI']}/qr2/${track.id}/${track.paymentHasPlaylistId}`;
        const outputPath = `${outputDir}/${track.trackId}.png`;
        await this.qr.generateQR(link, outputPath, playlist.qrColor);
      }
    } else {
      // Use new method in parallel batches of 25
      const batchSize = 25;
      for (let i = 0; i < dbTracks.length; i += batchSize) {
        const batch = dbTracks.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (track: any) => {
            const link = `${process.env['API_URI']}/qr2/${track.id}/${track.paymentHasPlaylistId}`;
            const outputPath = `${outputDir}/${track.trackId}.png`;
            await this.qr.generateQRLambda(link, outputPath, playlist.qrColor);
          })
        );
      }
    }
  }

  public async finalizeOrder(
    paymentId: string,
    mollie: Mollie,
    forceFinalize: boolean = false,
    skipMail: boolean = false
  ): Promise<ApiResult> {
    // Try to acquire a lock for this payment
    const lockAcquired = await this.cache.acquireLock(
      `finalizeOrder:${paymentId}`
    );
    if (!lockAcquired) {
      this.logger.log(
        color.yellow.bold(
          'Order finalization already in progress for payment: ' +
            color.white.bold(paymentId)
        )
      );
      return {
        success: false,
        error: 'Order finalization already in progress',
      };
    }

    try {
      const payment = await mollie.getPayment(paymentId);

      if (
        !payment.finalized ||
        forceFinalize ||
        process.env['ENVIRONMENT'] === 'development'
      ) {
        // update payment finalized
        await this.prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            finalized: true,
            finalizedAt: new Date(),
          },
        });

        const playlists = await this.data.getPlaylistsByPaymentId(
          payment.paymentId
        );
        const physicalPlaylists = [];

        for (const playlist of playlists) {
          if (playlist.productType === 'giftcard') {
            await this.finalizeGiftcardOrder(
              payment,
              playlist,
              physicalPlaylists
            );
            continue;
          }

          const hash = (
            payment.paymentId +
            '_' +
            playlist.id +
            '_' +
            playlist.name.replace(/ /g, '_')
          )
            .replace(/[^a-zA-Z0-9_]/g, '') // Keep underscores
            .toLowerCase();

          let eco = false;
          let ecoString = '';

          if (playlist.eco == 1) {
            eco = true;
            ecoString = '_eco';
          }

          const filename = sanitizeFilename(
            `${hash}_printer${ecoString}.pdf`.replace(/ /g, '_')
          ).toLowerCase();
          const filenameDigital = sanitizeFilename(
            `${hash}_digital${ecoString}.pdf`.replace(/ /g, '_')
          ).toLowerCase();

          let digitalTemplate = 'digital';

          if (playlist.doubleSided == 1) {
            digitalTemplate = 'digital_double';
          }

          let printerTemplate = 'printer';

          if (payment.vibe) {
            printerTemplate = 'printer_vibe';
          }

          const [generatedFilenameDigital, generatedFilename] =
            await Promise.all([
              this.pdf.generatePDF(
                filenameDigital,
                playlist,
                payment,
                digitalTemplate,
                payment.qrSubDir,
                eco
              ),
              playlist.orderType == 'physical'
                ? this.pdf.generatePDF(
                    filename,
                    playlist,
                    payment,
                    playlist.subType == 'sheets'
                      ? 'printer_sheets'
                      : printerTemplate,
                    payment.qrSubDir
                  )
                : Promise.resolve(''),
            ]);

          if (playlist.orderType == 'physical') {
            physicalPlaylists.push({
              playlist,
              filename: generatedFilename,
            });
          }

          await this.prisma.paymentHasPlaylist.update({
            where: {
              id: playlist.paymentHasPlaylistId,
            },
            data: {
              filename: generatedFilename,
              filenameDigital: generatedFilenameDigital,
            },
          });

          if (playlist.orderType == 'digital' && !skipMail) {
            await this.mail.sendEmail(
              'digital',
              payment,
              [playlist],
              generatedFilename,
              generatedFilenameDigital
            );
          }
        }

        // TODO: Implement API
        if (physicalPlaylists.length > 0) {
          let sendToPrinterAt = new Date().setHours(new Date().getHours() + 36);
          await this.prisma.payment.update({
            where: {
              id: payment.id,
            },
            data: {
              canBeSentToPrinter: true,
              canBeSentToPrinterAt: new Date(sendToPrinterAt),
            },
          });

          // Loop over the physical playlists and send them to the printer
          if (!skipMail) {
            for (const playlistItem of physicalPlaylists) {
              const playlist = playlistItem.playlist;
              this.mail.sendFinalizedMail(
                payment,
                `${process.env['FRONTEND_URI']}/${payment.locale}/usersuggestions/${payment.paymentId}/${payment.user.hash}/${playlist.playlistId}/0`,
                playlist
              );
            }
          }
        }

        this.logger.log(
          color.green.bold(
            `Order finalized for payment: ${white.bold(paymentId)}`
          )
        );

        return {
          success: true,
        };
      } else {
        this.logger.log(
          color.yellow.bold(
            'Order already finalized for payment: ' +
              color.white.bold(paymentId)
          )
        );
        return {
          success: false,
          error: 'Order already finalized',
        };
      }
    } finally {
      // Always release the lock when done
      await this.cache.releaseLock(`finalizeOrder:${paymentId}`);
    }
  }

  public async sendToPrinter(paymentId: string, clientIp: string) {
    let printApiOrderId = '';
    let printApiOrderRequest = '';
    let printApiOrderResponse = '';

    const payment = await this.prisma.payment.findFirst({
      where: {
        paymentId,
      },
      include: {
        user: {
          select: {
            hash: true,
          },
        },
      },
    });

    if (
      (payment && payment.canBeSentToPrinter && !payment.sentToPrinter) ||
      (payment && process.env['ENVIRONMENT'] === 'development')
    ) {
      const playlists = await this.data.getPlaylistsByPaymentId(
        payment.paymentId
      );
      const physicalPlaylists: any[] = [];

      // Loop over playlists and get physical ones with their filenames
      for (const playlist of playlists) {
        if (playlist.orderType === 'physical') {
          const paymentHasPlaylist =
            await this.prisma.paymentHasPlaylist.findFirst({
              select: {
                filename: true,
              },
              where: {
                paymentId: payment.id,
                playlistId: playlist.id,
              },
            });

          if (paymentHasPlaylist?.filename) {
            physicalPlaylists.push({
              playlist,
              filename: paymentHasPlaylist.filename,
            });
          }
        }
      }

      // Validate PDF page counts before sending to printer
      const validationErrors: string[] = [];
      for (const physicalPlaylist of physicalPlaylists) {
        const { playlist, filename } = physicalPlaylist;
        const pdfPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;

        try {
          // Count pages in the physical PDF
          const pageCount = await this.pdf.countPDFPages(pdfPath);

          // Get actual track count for this playlist
          const actualTracks = playlist.numberOfTracks;

          // Calculate expected pages based on format
          let expectedPages: number;
          let formatType: string;
          
          if (playlist.subType === 'sheets') {
            // Sheets format: 12 cards processed per iteration (6 cards per page, 3x2 layout)
            // Each iteration creates 2 pages: one for fronts, one for backs
            // Example: 25 tracks = Math.ceil(25/12) = 3 iterations = 6 pages
            expectedPages = Math.ceil(actualTracks / 12) * 2;
            formatType = 'sheets';
          } else {
            // Cards format: 1 card per page, 2 pages per track (front and back)
            expectedPages = actualTracks * 2;
            formatType = 'cards';
          }

          if (pageCount !== expectedPages) {
            const errorMessage = `PDF validation failed for playlist ${white.bold(
              playlist.name
            )} (${white.bold(playlist.playlistId)}) [${formatType}]: Expected ${white.bold(
              expectedPages.toString()
            )} pages for ${white.bold(
              actualTracks.toString()
            )} tracks but PDF has ${white.bold(pageCount.toString())} pages`;
            validationErrors.push(errorMessage);
            this.logger.log(color.red.bold(errorMessage));
          } else {
            this.logger.log(
              color.green.bold(
                `PDF validation passed for playlist ${white.bold(
                  playlist.name
                )} [${formatType}]: ${white.bold(actualTracks.toString())} tracks, ${white.bold(
                  pageCount.toString()
                )} pages`
              )
            );
          }
        } catch (error) {
          const errorMessage = `Failed to validate PDF for playlist ${white.bold(
            playlist.name
          )} (${white.bold(playlist.playlistId)}): ${error}`;
          validationErrors.push(errorMessage);
          this.logger.log(color.red.bold(errorMessage));
        }
      }

      // If there are validation errors, send Pushover notification and abort
      if (validationErrors.length > 0) {
        const fullMessage = `PDF validation errors for payment ${paymentId}:\n\n${validationErrors.join(
          '\n'
        )}`;

        // Send Pushover notification
        this.pushover.sendMessage(
          {
            title: '🚨 PDF Validation Error - Order Not Sent',
            message: fullMessage,
            sound: 'siren',
            priority: 1, // High priority
          },
          clientIp
        );

        // Log the error and return without sending to printer
        this.logger.log(
          color.red.bold(
            `Order ${white.bold(
              paymentId
            )} not sent to printer due to PDF validation errors`
          )
        );

        return;
      }

      const orderData = await this.order.createOrder(
        payment,
        physicalPlaylists,
        playlists[0].productType
      );

      printApiOrderId = orderData.response.id;
      printApiOrderRequest = JSON.stringify(orderData.request);
      printApiOrderResponse = JSON.stringify(orderData.response);

      await this.prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          sentToPrinter: true,
          sentToPrinterAt: new Date(),
          printApiOrderId,
          printApiOrderRequest,
          printApiOrderResponse,
        },
      });

      if (orderData.success) {
        // Send email notification to customer about printing started
        if (payment.user) {
          for (const physicalPlaylist of physicalPlaylists) {
            await this.mail.sendToPrinterMail(
              payment as typeof payment & { user: { hash: string } },
              physicalPlaylist.playlist
            );
          }
        }

        this.logger.log(
          color.green.bold(
            `Order sent to printer for payment: ${white.bold(paymentId)}`
          )
        );
      } else {
        // Pushover
        this.pushover.sendMessage(
          {
            title: 'Fout tijdens Print&Bind bestelling',
            message: `Er is een fout opgetreden bi het maken van een Print&Bind bestelling voor betaling: ${paymentId}`,
            sound: 'incoming',
          },
          clientIp
        );
        this.logger.log(
          color.red.bold(
            `There was an error while sending order ${white.bold(
              paymentId
            )} to the printer`
          )
        );
        console.log(111, orderData.response.apiCalls);
      }
    }
  }

  private async finalizeGiftcardOrder(
    payment: any,
    playlist: any,
    physicalPlaylists: any[] = []
  ): Promise<void> {
    const hash = crypto
      .createHmac('sha256', process.env['PLAYLIST_SECRET']!)
      .update(playlist.playlistId)
      .digest('hex');

    const filename = sanitizeFilename(
      `${hash}_printer.pdf`.replace(/ /g, '_')
    ).toLowerCase();
    const filenameDigital = sanitizeFilename(
      `${hash}_digital.pdf`.replace(/ /g, '_')
    ).toLowerCase();

    const discount = await this.discount.createDiscountCode(
      playlist.giftcardAmount,
      playlist.giftcardFrom,
      playlist.giftcardMessage
    );

    const [generatedFilenameDigital, generatedFilename] = await Promise.all([
      this.pdf.generateGiftcardPDF(
        filenameDigital,
        playlist,
        discount,
        payment,
        'digital',
        payment.qrSubDir
      ),
      playlist.orderType != 'digital'
        ? this.pdf.generateGiftcardPDF(
            filename,
            playlist,
            discount,
            payment,
            'printer',
            payment.qrSubDir
          )
        : Promise.resolve(''),
    ]);

    await this.prisma.paymentHasPlaylist.update({
      where: {
        id: playlist.paymentHasPlaylistId,
      },
      data: {
        filename: generatedFilename,
        filenameDigital: generatedFilenameDigital,
      },
    });

    if (playlist.orderType !== 'digital') {
      physicalPlaylists.push({
        playlist,
        filename: generatedFilename,
      });
    }

    await this.mail.sendEmail(
      'voucher_' + playlist.orderType,
      payment,
      [playlist],
      generatedFilename,
      generatedFilenameDigital
    );
  }

  private async generateGiftcardPDF(
    payment: any,
    playlist: any,
    ip: string,
    subdir: string
  ): Promise<{ filename: string; filenameDigital: string }> {
    let filename = '';
    let filenameDigital = '';

    this.logger.log(
      blue.bold(`Generating PDF for giftcard: ${white.bold(playlist.name)}`)
    );

    const hash = crypto
      .createHmac('sha256', process.env['PLAYLIST_SECRET']!)
      .update(playlist.playlistId)
      .digest('hex');

    filename = sanitizeFilename(
      `${hash}_printer.pdf`.replace(/ /g, '_')
    ).toLowerCase();
    filenameDigital = sanitizeFilename(
      `${hash}_digital.pdf`.replace(/ /g, '_')
    ).toLowerCase();

    // Now we generate the discount code
    const discount = await this.discount.createDiscountCode(
      playlist.giftcardAmount,
      playlist.giftcardFrom,
      playlist.giftcardMessage
    );

    const [generatedFilenameDigital, generatedFilename] = await Promise.all([
      this.pdf.generateGiftcardPDF(
        filenameDigital,
        playlist,
        discount,
        payment,
        'digital',
        subdir
      ),
      playlist.orderType != 'digital'
        ? this.pdf.generateGiftcardPDF(
            filename,
            playlist,
            discount,
            payment,
            'printer',
            subdir
          )
        : Promise.resolve(''),
    ]);

    filename = generatedFilename;
    filenameDigital = generatedFilenameDigital;

    return { filename, filenameDigital };
  }

  public async createGameset(
    paymentId: string,
    paymentHasPlaylistId: number
  ): Promise<string> {
    try {
      this.logger.log(
        blue.bold('Creating gameset ZIP for payment ') +
          white.bold(paymentId) +
          blue.bold(', playlist ') +
          white.bold(paymentHasPlaylistId.toString()) +
          blue.bold('...')
      );

      // Get the specific payment_has_playlist entry with its playlist and tracks
      const paymentHasPlaylist =
        await this.prisma.paymentHasPlaylist.findUnique({
          where: { id: paymentHasPlaylistId },
          include: {
            playlist: {
              include: {
                tracks: {
                  include: {
                    track: true,
                  },
                  orderBy: {
                    order: 'asc',
                  },
                },
              },
            },
          },
        });

      if (!paymentHasPlaylist) {
        throw new Error(
          'Payment has playlist entry not found: ' + paymentHasPlaylistId
        );
      }

      const playlist = paymentHasPlaylist.playlist;

      // Get all tracks from the playlist with their order
      const tracksWithOrder = playlist.tracks.map((pt) => ({
        track: pt.track,
        order: pt.order,
      }));

      // Create a unique filename for this gameset
      const timestamp = Date.now();
      const zipFilename = `gameset_${paymentId}_${playlist.playlistId}_${timestamp}.zip`;
      const publicDir =
        process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');
      const zipPath = path.join(publicDir, 'gamesets', zipFilename);

      // Ensure the gamesets directory exists
      await fs.mkdir(path.join(publicDir, 'gamesets'), { recursive: true });

      // Create a file stream
      const output = createWriteStream(zipPath);
      const archive = archiver('zip', {
        zlib: { level: 9 }, // Maximum compression
      });

      // Pipe archive data to the file
      archive.pipe(output);

      // Create temporary directory for QR codes
      const tempDir = path.join(process.cwd(), 'temp', `gameset_${timestamp}`);
      await fs.mkdir(tempDir, { recursive: true });

      // Generate QR codes for all tracks
      const trackData = [];
      for (const item of tracksWithOrder) {
        const { track, order } = item;
        const qrLink = `https://api.musicmatchgame.com/${paymentHasPlaylistId}/${track.id}`;
        const safeArtist = sanitizeFilename(
          track.artist || 'unknown'
        ).toLowerCase();
        const safeName = sanitizeFilename(
          track.name || 'untitled'
        ).toLowerCase();

        // Prepend order number with zero padding (5 characters)
        const orderPadded = String(order).padStart(5, '0');
        const svgFilename = `${orderPadded}_track_${track.id}_${safeArtist}_${safeName}.svg`;
        const svgPath = path.join(tempDir, svgFilename);

        // Generate QR code as SVG
        await this.qr.generateQR(qrLink, svgPath, '#000000', 'svg');

        // Add to archive
        archive.file(svgPath, { name: svgFilename });

        // Add track data for JSON
        // Extract track ID from Spotify link (format: https://open.spotify.com/track/TRACKID)
        const spotifyTrackId = track.spotifyLink
          ? track.spotifyLink.split('/track/')[1]?.split('?')[0] || ''
          : '';
        trackData.push({
          i: track.id,
          l: spotifyTrackId,
        });
      }

      // Create JSON file with track information
      const jsonContent = JSON.stringify(
        {
          i: paymentHasPlaylistId,
          n: '',
          t: trackData,
        },
        null,
        2
      );
      const jsonPath = path.join(tempDir, 'tracks.json');
      await fs.writeFile(jsonPath, jsonContent);
      archive.file(jsonPath, { name: 'tracks.json' });

      // Finalize the archive
      await archive.finalize();

      // Wait for the stream to finish
      await new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve());
        output.on('error', reject);
      });

      // Clean up temporary directory
      await fs.rm(tempDir, { recursive: true, force: true });

      this.logger.log(
        color.green.bold('Gameset ZIP created: ') + white.bold(zipFilename)
      );

      // Return the URL to download the ZIP
      return `/public/gamesets/${zipFilename}`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.log(
        color.red.bold('Error creating gameset: ') + white.bold(errorMessage)
      );
      console.error(error);
      throw error;
    }
  }
}

export default Generator;
