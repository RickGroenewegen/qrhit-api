import { color } from 'console-log-colors';
import Logger from './logger';
import { Playlist, PrismaClient } from '@prisma/client';
import Spotify from './spotify';
import Mollie from './mollie';
import Data from './data';
import * as QRCode from 'qrcode';
import * as fs from 'fs/promises';
import * as puppeteer from 'puppeteer';
import { uuidv4 as uuid } from 'uuidv7';
import sanitizeFilename from 'sanitize-filename';
import Utils from './utils';
import Progress from './progress';
import { SocketStream } from '@fastify/websocket';
import Mail from './mail';
import Order from './order';

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

  public async startProgress(paymentId: string, connection: SocketStream) {
    this.progress.startProgress(paymentId);
  }

  public async generate(params: any): Promise<void> {
    this.progress.setProgress(params.paymentId, 0, 'Started ...');

    const userProfile = await this.spotify.getUserProfile(params.accessToken);
    const paymentStatus = await this.mollie.checkPaymentStatus(
      params.paymentId
    );

    const userId = paymentStatus.data.user.userId;
    const payment = await this.mollie.getPayment(params.paymentId);

    const user = await this.data.getUserByUserId(userId);

    // Get the playlist from the database
    const playlist = await this.data.getPlaylist(payment.playlist.playlistId);

    // Check if the user is the same as the one who made the payment
    if (userProfile.data.userId !== userId) {
      this.logger.log(
        color.red.bold('User is not the same as the one who made the payment')
      );
      return;
    }

    this.progress.setProgress(
      params.paymentId,
      0,
      'Getting tracks from Spotify '
    );

    // Retrieve the tracks from Spotify
    const response = await this.spotify.getTracks(
      { authorization: params.accessToken },
      payment.playlist.playlistId
    );

    const tracks = response.data;

    this.progress.setProgress(
      params.paymentId,
      0,
      'Storing tracks in database'
    );

    await this.data.storeTracks(payment.paymentId, payment.playlist.id, tracks);

    const dbTracks = await this.data.getTracks(payment.playlist.id);

    // Loop through the tracks and create a QR code for each track
    for (const track of dbTracks) {
      const link = `${process.env['FRONTEND_SHORT_URI']}/qr/${paymentStatus.data.user.hash}/${track.id}`;
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

    this.progress.setProgress(
      params.paymentId,
      90,
      `Generating PDF for: ${playlist.name}`
    );

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
    await this.mail.sendEmail(user, playlist, filename);
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
    let puppeteerOptions = {};

    if (process.env['CHROMIUM_PATH']) {
      puppeteerOptions = {
        executablePath: process.env['CHROMIUM_PATH'],
      };
    }

    const browser = await puppeteer.launch(puppeteerOptions);
    const page = await browser.newPage();
    const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}`;
    const filename = sanitizeFilename(
      `${playlist.name}_${uniqueId}_${template}.pdf`.replace(/ /g, '_')
    ).toLowerCase();

    this.logger.log(
      color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
    );

    // Navigate to the URL
    await page.goto(url, {
      waitUntil: 'networkidle0',
    });

    // Define PDF options
    const pdfOptions: puppeteer.PDFOptions = {
      path: `${process.env['PUBLIC_DIR']}/pdf/${filename}`,
      format: 'A4',
      printBackground: true,
    };

    // Generate the PDF
    await page.pdf(pdfOptions);
    await browser.close();

    return filename;
  }
}

export default Qr;
