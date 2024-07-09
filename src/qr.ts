import { color } from 'console-log-colors';
import Logger from './logger';
import { Playlist, PrismaClient } from '@prisma/client';
import Spotify from './spotify';
import Mollie from './mollie';
import Data from './data';
import * as QRCode from 'qrcode';
import * as fs from 'fs/promises';
import { uuidv4 as uuid } from 'uuidv7';
import sanitizeFilename from 'sanitize-filename';
import Utils from './utils';
import Progress from './progress';
import Mail from './mail';
import Order from './order';
import { promisify } from 'util';
import { exec } from 'child_process';
import ConvertApi from 'convertapi';

class Qr {
  private spotify = new Spotify();
  private mollie = new Mollie();
  private data = new Data();
  private logger = new Logger();
  private utils = new Utils();
  private progress = Progress.getInstance();
  private prisma = new PrismaClient();
  private mail = new Mail();
  private order = Order.getInstance();
  private execPromise = promisify(exec);
  private convertapi = new ConvertApi(process.env['CONVERT_API_KEY']!);

  public async startProgress(paymentId: string) {
    this.progress.startProgress(paymentId);
  }

  public async generate(params: any): Promise<void> {
    this.progress.setProgress(params.paymentId, 0, 'Started ...');

    const paymentStatus = await this.mollie.checkPaymentStatus(
      params.paymentId
    );

    const userId = paymentStatus.data.user.userId;
    const payment = await this.mollie.getPayment(params.paymentId);

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

    this.progress.setProgress(params.paymentId, 0, 'progress.gettingTracks');

    // Retrieve the tracks from Spotify
    const response = await this.spotify.getTracks(
      { authorization: params.accessToken },
      payment.playlist.playlistId
    );

    const tracks = response.data;

    this.progress.setProgress(params.paymentId, 0, 'progress.storingTracks');

    await this.data.storeTracks(payment.paymentId, payment.playlist.id, tracks);

    const dbTracks = await this.data.getTracks(payment.playlist.id);

    // Loop through the tracks and create a QR code for each track
    for (const track of dbTracks) {
      const link = `${process.env['API_URI']}/qr/${track.id}`;
      const outputDir = `${process.env['PUBLIC_DIR']}/qr/${userId}`;
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

    this.progress.setProgress(params.paymentId, 90, `progress.generatingPDF`);

    // Generate the digital version
    const filename = await this.generatePDF(playlist, payment, 'digital');

    // Update the payment with the filename using prisma
    await this.prisma.payment.update({
      where: {
        paymentId: payment.paymentId,
      },
      data: {
        filename,
      },
    });

    this.progress.setProgress(params.paymentId, 100, `Done!`);
    await this.mail.sendEmail(payment, playlist, filename);
    if (payment.orderType.name != 'digital') {
      // Generate the PDF for the printer
      const filename = await this.generatePDF(playlist, payment, 'printer');
      await this.order.createOrder(payment, filename);
    }

    this.logger.log(
      color.green.bold(
        `PDF Generated successfully: ${color.white.bold(filename)}`
      )
    );
  }

  private async generateQR(link: string, outputPath: string) {
    try {
      // Check if the QR code already exists
      try {
        await fs.access(outputPath);
        return;
      } catch (error) {
        await QRCode.toFile(outputPath, link, {
          type: 'png',
          color: {
            dark: '#000000', // Color of the dark squares
            light: '0000', // Color of the light squares (usually background)
          },
          errorCorrectionLevel: 'H', // High error correction level
        });
      }
    } catch (error) {
      this.logger.log(color.red.bold('Error generating QR code!'));
    }
  }

  private async generatePDF(
    playlist: Playlist,
    payment: any,
    template: string
  ): Promise<string> {
    this.logger.log(color.blue.bold('Generating PDF...'));

    const uniqueId = uuid();

    const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}`;
    const filename = sanitizeFilename(
      `${playlist.name}_${uniqueId}_${template}.pdf`.replace(/ /g, '_')
    ).toLowerCase();

    this.logger.log(
      color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
    );

    this.logger.log(
      color.blue.bold(`Converting to PDF: ${color.white.bold(filename)}`)
    );

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
