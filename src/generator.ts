import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import { MAX_CARDS } from './config/constants';
import PrismaInstance from './prisma';
import Utils from './utils';
import Mollie from './mollie';
import crypto from 'crypto';
import sanitizeFilename from 'sanitize-filename';
import * as fs from 'fs/promises';
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

class Generator {
  private logger = new Logger();
  private utils = new Utils();
  private prisma = PrismaInstance.getInstance();
  private data = new Data();
  private pushover = new PushoverClient();
  private spotify = new Spotify();
  private mail = Mail.getInstance();
  private qr = new QR();
  private pdf = new PDF();
  private order = Order.getInstance();
  private analytics = AnalyticsClient.getInstance();
  private discount = new Discount();
  private cache = Cache.getInstance();

  constructor() {
    this.setupQRCleanupCron();
  }

  private setupQRCleanupCron() {
    const isMainServer = this.utils.parseBoolean(process.env['MAIN_SERVER']!);
    const isPrimary = cluster.isPrimary;

    // if (isMainServer && isPrimary) {
    //   new CronJob(
    //     '*/1 * * * *',
    //     async () => {
    //       await this.cleanupQRCodes();
    //     },
    //     null,
    //     true,
    //     'Europe/Amsterdam'
    //   );
    // }
  }

  private async cleanupQRCodes(): Promise<void> {
    const qrDir = `${process.env['PUBLIC_DIR']}/qr`;
    const now = Date.now();

    const maxAge =
      process.env['ENVIRONMENT'] === 'development'
        ? 24 * 60 * 60 * 1000
        : 5 * 60 * 1000;

    const cleanedDirs = new Set<string>();
    try {
      const subdirs = await fs.readdir(qrDir);
      for (const subdir of subdirs) {
        const subdirPath = path.join(qrDir, subdir);
        const stats = await fs.stat(subdirPath);
        if (stats.isDirectory() && now - stats.mtimeMs > maxAge) {
          await fs.rm(subdirPath, { recursive: true, force: true });
          if (!cleanedDirs.has(subdir)) {
            this.logger.log(
              color.blue.bold(
                `Cleaned up QR code directory: ${color.white.bold(subdir)}`
              )
            );
            cleanedDirs.add(subdir);
          }
        }
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error during QR code cleanup: ${color.white.bold(error)}`
        )
      );
    }
  }

  public async generate(
    paymentId: string,
    ip: string,
    refreshPlaylists: string,
    mollie: Mollie
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
    if (productType == 'cards') {
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
          refreshPlaylistArray.includes(playlist.playlistId)
        );

        // Get tracks for QR generation
        const dbTracks = await this.data.getTracks(playlist.id);

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
      await this.finalizeOrder(payment.paymentId, mollie);
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

  private async storePlaylistData(
    payment: any,
    playlist: any,
    refreshCache: boolean = false
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
      !refreshCache
    );
    const tracks = response.data.tracks;

    // If there are more than 500 remove the last tracks
    if (tracks.length > MAX_CARDS) {
      tracks.splice(MAX_CARDS);
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
    dbTracks: Track[],
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
        const link = `${process.env['API_URI']}/qr/${track.id}`;
        const outputPath = `${outputDir}/${track.trackId}.png`;
        await this.qr.generateQR(link, outputPath);
      }
    } else {
      // Use new method in parallel batches of 25
      const batchSize = 25;
      for (let i = 0; i < dbTracks.length; i += batchSize) {
        const batch = dbTracks.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (track: Track) => {
            const link = `${process.env['API_URI']}/qr/${track.id}`;
            const outputPath = `${outputDir}/${track.trackId}.png`;
            await this.qr.generateQRLambda(link, outputPath);
          })
        );
      }
    }
  }

  public async finalizeOrder(
    paymentId: string,
    mollie: Mollie
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

      if (!payment.finalized) {
        // update payment finalized
        await this.prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            finalized: true,
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

          let digitalTemplate = 'digital';

          if (playlist.doubleSided == 1) {
            digitalTemplate = 'digital_double';
          }

          const [generatedFilenameDigital, generatedFilename] =
            await Promise.all([
              this.pdf.generatePDF(
                filenameDigital,
                playlist,
                payment,
                digitalTemplate,
                payment.qrSubDir
              ),
              playlist.orderType == 'physical'
                ? this.pdf.generatePDF(
                    filename,
                    playlist,
                    payment,
                    'printer',
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

          await this.mail.sendEmail(
            'digital',
            payment,
            [playlist],
            generatedFilename,
            generatedFilenameDigital
          );
        }

        let printApiOrderId = '';
        let printApiOrderRequest = '';
        let printApiOrderResponse = '';

        if (physicalPlaylists.length > 0) {
          payment.printerPageCount = await this.pdf.countPDFPages(
            `${process.env['PUBLIC_DIR']}/pdf/${physicalPlaylists[0].filename}`
          );
          const orderData = await this.order.createOrder(
            payment,
            physicalPlaylists,
            playlists[0].productType
          );
          printApiOrderId = orderData.response.id;
          printApiOrderRequest = JSON.stringify(orderData.request);
          printApiOrderResponse = JSON.stringify(orderData.response);
        }

        await this.prisma.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            printApiOrderId,
            printApiOrderRequest,
            printApiOrderResponse,
          },
        });

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
}

export default Generator;
