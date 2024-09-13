import { color } from 'console-log-colors';
import Logger from './logger';
import { Playlist, PrismaClient } from '@prisma/client';
import Spotify from './spotify';
import Mollie from './mollie';
import Data from './data';
import * as QRCode from 'qrcode';
import * as fs from 'fs/promises';
import sanitizeFilename from 'sanitize-filename';
import Utils from './utils';
import Progress from './progress';
import Mail from './mail';
import Order from './order';
import ConvertApi from 'convertapi';
import PushoverClient from './pushover';
import crypto from 'crypto';
class Qr {
  private spotify = new Spotify();
  private mollie = new Mollie();
  private data = new Data();
  private logger = new Logger();
  private utils = new Utils();
  private progress = Progress.getInstance();
  private mail = new Mail();
  private pushover = new PushoverClient();
  private order = Order.getInstance();
  private convertapi = new ConvertApi(process.env['CONVERT_API_KEY']!);
  private prisma = new PrismaClient();

  public async startProgress(paymentId: string) {
    this.progress.startProgress(paymentId);
  }

  public async generate(params: any, ip: string): Promise<void> {
    let filename = '';
    let filenameDigital = '';

    this.progress.setProgress(params.paymentId, 0, 'Started ...');

    const paymentStatus = await this.mollie.checkPaymentStatus(
      params.paymentId
    );

    const userId = paymentStatus.data.payment.user.userId;
    let payment = await this.mollie.getPayment(params.paymentId);

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

    const fullPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;

    // Check if the file exists using fs
    let exists = false;
    try {
      await fs.access(fullPath);
      exists = true;
      this.logger.log(
        color.yellow.bold(`PDF already exists: ${color.white.bold(filename)}`)
      );
    } catch (error) {
      // Continue
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

    // Pushover
    this.pushover.sendMessage(
      {
        title: `KA-CHING! € ${payment.orderType.amount
          .toString()
          .replace('.', ',')} verdiend!`,
        message: `${payment.fullname} (${payment.countrycode}) heeft ${
          payment.numberOfTracks
        } kaarten besteld voor € ${payment.totalPrice
          .toString()
          .replace('.', ',')}. Playlist: ${playlist.name}`,
        sound: 'incoming',
      },
      ip
    );

    this.progress.setProgress(params.paymentId, 0, 'progress.gettingTracks');

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

      this.progress.setProgress(params.paymentId, 0, 'progress.storingTracks');

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
        const threeChars = track.trackId.substring(0, 4);
        const outputDir = `${process.env['PUBLIC_DIR']}/qr/${threeChars}`;
        const outputPath = `${outputDir}/${track.trackId}.png`;
        await this.utils.createDir(outputDir);
        await this.generateQR(link, outputPath);

        // Create a progress based on 70-90% of the total tracks
        const progress = Math.floor(
          (tracks.indexOf(track) / tracks.length) * 20 + 70
        );

        this.progress.setProgress(
          params.paymentId,
          progress,
          `Generated QR code for: ${track.name}`
        );
      }

      this.progress.setProgress(params.paymentId, 80, `progress.generatingPDF`);

      const [generatedFilename, generatedFilenameDigital] = await Promise.all([
        this.generatePDF(filename, playlist, payment, 'printer', 80, 89),
        payment.orderType.name === 'digital'
          ? this.generatePDF(
              filenameDigital,
              playlist,
              payment,
              'digital',
              90,
              99
            )
          : Promise.resolve(''),
      ]);

      filename = generatedFilename;
      filenameDigital = generatedFilenameDigital;
    }

    if (payment.orderType.name != 'digital') {
      await this.order.createOrder(payment, filename);
    }

    payment = await this.mollie.getPayment(params.paymentId);

    if (payment.orderType.name === 'digital') {
      // Update the payment with the order id
      await this.prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          filenameDigital: filenameDigital,
        },
      });
    }

    await this.mail.sendEmail(
      payment.orderType.name,
      payment,
      playlist,
      filename,
      filenameDigital
    );

    this.progress.setProgress(params.paymentId, 100, `Done!`);

    this.logger.log(
      color.green.bold(
        `PDF Generated successfully: ${color.white.bold(filename)}`
      )
    );
  }

  private async generateQR(link: string, outputPath: string) {
    try {
      await QRCode.toFile(outputPath, link, {
        type: 'png',
        color: {
          dark: '#000000', // Color of the dark squares
          light: '0000', // Color of the light squares (usually background)
        },
        errorCorrectionLevel: 'H', // High error correction level
      });
    } catch (error) {
      this.logger.log(color.red.bold('Error generating QR code!'));
    }
  }

  private async generatePDF(
    filename: string,
    playlist: Playlist,
    payment: any,
    template: string,
    startProgress: number,
    endProgress: number
  ): Promise<string> {
    this.logger.log(color.blue.bold('Generating PDF...'));

    const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}`;

    this.logger.log(
      color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
    );

    this.logger.log(
      color.blue.bold(`Converting to PDF: ${color.white.bold(filename)}`)
    );

    // Start a timer to increment progress
    const incrementInterval = (13 * 1000) / (endProgress - startProgress); // 13 seconds divided into the progress range
    let currentProgress = startProgress;
    const intervalId = setInterval(() => {
      if (currentProgress < endProgress) {
        currentProgress++;
        this.progress.setProgress(
          payment.paymentId,
          currentProgress,
          `Generating PDF...`
        );
      }
    }, incrementInterval);

    try {
      const result = await this.convertapi.convert(
        'pdf',
        {
          File: url,
          RespectViewport: 'false',
          PageSize: 'a4',
          MarginTop: 0,
          MarginRight: 0,
          MarginBottom: 0,
          MarginLeft: 0,
          CompressPDF: 'true',
        },
        'htm'
      );
      await result.saveFiles(`${process.env['PUBLIC_DIR']}/pdf/${filename}`);
    } finally {
      clearInterval(intervalId); // Clear the interval once the PDF generation is complete
    }

    this.logger.log(
      color.blue.bold(`Saving done: ${color.white.bold(filename)}`)
    );

    return filename;
  }

  async compressPDF(inputPath: string, outputPath: string): Promise<void> {
    try {
      const result = await this.convertapi.convert(
        'compress',
        {
          File: inputPath,
        },
        'pdf'
      );

      await result.saveFiles(outputPath);

      this.logger.log(
        color.blue.bold(
          `PDF compression successful: ${color.white.bold(outputPath)}`
        )
      );
    } catch (error) {
      this.logger.log(color.red.bold('Error compressing PDF!'));
    }
  }
}

export default Qr;
