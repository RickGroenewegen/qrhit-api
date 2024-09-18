import { color } from 'console-log-colors';
import Logger from './logger';
import { Playlist, PrismaClient } from '@prisma/client';
import Utils from './utils';
import Progress from './progress';
import ConvertApi from 'convertapi';
import Mollie from './mollie';
import crypto from 'crypto';
import sanitizeFilename from 'sanitize-filename';
import * as fs from 'fs/promises';
import Data from './data';
import PushoverClient from './pushover';
import Spotify from './spotify';
import Mail from './mail';
import QR from './qr';
import PDF from './pdf';
import Order from './order';

class Generator {
  private logger = new Logger();
  private utils = new Utils();
  private prisma = new PrismaClient();
  private progress = Progress.getInstance();
  private data = new Data();
  private pushover = new PushoverClient();
  private spotify = new Spotify();
  private mail = new Mail();
  private qr = new QR();
  private pdf = new PDF();
  private order = Order.getInstance();

  public async generate(
    paymentId: string,
    ip: string,
    mollie: Mollie
  ): Promise<void> {
    let filename = '';
    let filenameDigital = '';

    this.progress.setProgress(paymentId, 0, 'Started ...');

    const paymentStatus = await mollie.checkPaymentStatus(paymentId);

    const userId = paymentStatus.data.payment.user.userId;
    let payment = await mollie.getPayment(paymentId);

    const hash = crypto
      .createHmac('sha256', process.env['PLAYLIST_SECRET']!)
      .update(payment.playlist.playlistId)
      .digest('hex');

    filename = sanitizeFilename(
      `${hash}_printer.pdf`.replace(/ /g, '_')
    ).toLowerCase();

    filenameDigital = sanitizeFilename(
      `${hash}_digital.pdf`.replace(/ /g, '_')
    ).toLowerCase();

    let fullPath = `${process.env['PUBLIC_DIR']}/pdf/${filenameDigital}`;

    if (payment.orderType.name != 'digital') {
      fullPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
    }

    let exists = false;
    if (payment.orderType.name === 'digital') {
      const digitalPath = `${process.env['PUBLIC_DIR']}/pdf/${filenameDigital}`;
      try {
        await fs.access(digitalPath);
        exists = true;
        this.logger.log(
          color.yellow.bold(
            `Digital PDF already exists: ${color.white.bold(filenameDigital)}`
          )
        );
      } catch (error) {
        // Digital file doesn't exist
      }
    } else {
      const normalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
      const digitalPath = `${process.env['PUBLIC_DIR']}/pdf/${filenameDigital}`;
      try {
        await Promise.all([fs.access(normalPath), fs.access(digitalPath)]);
        exists = true;
        this.logger.log(
          color.yellow.bold(
            `Both PDFs already exist: ${color.white.bold(
              filename
            )} and ${color.white.bold(filenameDigital)}`
          )
        );
      } catch (error) {
        // At least one of the files doesn't exist
      }
    }

    const user = await this.data.getUserByUserId(userId);

    // Get the playlist from the database
    const playlist = await this.data.getPlaylist(payment.playlist.playlistId);

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

    let cardType = 'fysieke';
    let orderName = `${payment.fullname} (${payment.countrycode})`;
    if (payment.orderType.name === 'digital') {
      cardType = 'digitale';
      orderName = `${payment.fullname}`;
    }

    // Pushover
    this.pushover.sendMessage(
      {
        title: `KA-CHING! € ${payment.orderType.amount
          .toString()
          .replace('.', ',')} verdiend!`,
        message: `${orderName} heeft ${
          payment.numberOfTracks
        } ${cardType} kaarten besteld voor € ${payment.totalPrice
          .toString()
          .replace('.', ',')}. Playlist: ${playlist.name}`,
        sound: 'incoming',
      },
      ip
    );

    this.progress.setProgress(paymentId, 0, 'progress.gettingTracks');

    if (playlist.resetCache) {
      exists = false;
    }

    if (!exists) {
      // Retrieve the tracks from Spotify
      const response = await this.spotify.getTracks(
        payment.playlist.playlistId
      );

      const tracks = response.data;

      // If there are more than 500 remove the last tracks
      if (tracks.length > 500) {
        tracks.splice(500);
      }

      this.progress.setProgress(paymentId, 0, 'progress.storingTracks');

      await this.data.storeTracks(
        payment.paymentId,
        payment.playlist.id,
        tracks
      );

      const dbTracks = await this.data.getTracks(payment.playlist.id);

      // Loop through the tracks and create a QR code for each track
      for (const track of dbTracks) {
        const link = `${process.env['API_URI']}/qr/${track.id}`;

        // Get the first 3 characters of the track id
        const startChars = track.trackId.substring(0, 4);
        const outputDir = `${process.env['PUBLIC_DIR']}/qr/${startChars}`;
        const outputPath = `${outputDir}/${track.trackId}.png`;
        await this.utils.createDir(outputDir);
        await this.qr.generateQR(link, outputPath);

        // Create a progress based on 70-90% of the total tracks
        const progress = Math.floor(
          (tracks.indexOf(track) / tracks.length) * 20 + 70
        );

        this.progress.setProgress(
          paymentId,
          progress,
          `Generated QR code for: ${track.name}`
        );
      }

      this.progress.setProgress(paymentId, 80, `progress.generatingPDF`);

      const [generatedFilenameDigital, generatedFilename] = await Promise.all([
        this.pdf.generatePDF(
          filenameDigital,
          playlist,
          payment,
          'digital',
          80,
          89
        ),
        payment.orderType.name != 'digital'
          ? this.pdf.generatePDF(filename, playlist, payment, 'printer', 90, 99)
          : Promise.resolve(''),
      ]);

      filename = generatedFilename;
      filenameDigital = generatedFilenameDigital;
    }

    let printerPageCount = 0;
    let printApiOrderId = '';
    let printApiOrderResponse = '';

    if (payment.orderType.name != 'digital') {
      payment.printerPageCount = await this.utils.countPdfPages(
        `${process.env['PUBLIC_DIR']}/pdf/${filename}`
      );
      const orderData = await this.order.createOrder(payment, filename);
      printApiOrderId = orderData.id;
      printApiOrderResponse = JSON.stringify(orderData);
    }

    payment = await mollie.getPayment(paymentId);

    // Update the payment with the order id
    await this.prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        filename,
        filenameDigital,
        printerPageCount: payment.printerPageCount,
        printApiOrderId,
        printApiOrderResponse,
      },
    });

    await this.mail.sendEmail(
      payment.orderType.name,
      payment,
      playlist,
      filename,
      filenameDigital
    );

    this.progress.setProgress(paymentId, 100, `Done!`);

    this.logger.log(
      color.green.bold(
        `PDF Generated successfully: ${color.white.bold(filename)}`
      )
    );
  }
}

export default Generator;
