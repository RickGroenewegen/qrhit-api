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

class Qr {
  private prisma = new PrismaClient();
  private spotify = new Spotify();
  private mollie = new Mollie();
  private data = new Data();
  private logger = new Logger();

  public async generate(params: any): Promise<void> {
    const userProfile = await this.spotify.getUserProfile(params.accessToken);
    const paymentStatus = await this.mollie.checkPaymentStatus(
      params.paymentId
    );
    const userId = paymentStatus.data.user.userId;
    const payment = await this.mollie.getPayment(params.paymentId);

    // Get the playlist from the database
    const playlist = await this.data.getPlaylist(payment.playlist.playlistId);

    // Check if the user is the same as the one who made the payment
    if (userProfile.data.userId !== userId) {
      this.logger.log(
        color.red.bold('User is not the same as the one who made the payment')
      );
      return;
    }

    // Retrieve the tracks from Spotify
    const response = await this.spotify.getTracks(
      { authorization: params.accessToken },
      payment.playlist.playlistId
    );

    const tracks = response.data;

    await this.data.storeTracks(payment.playlist.id, tracks);

    // Loop through the tracks and create a QR code for each track
    for (const track of tracks) {
      const hash = `${userId}-${track.id}`;
      const outputDir = `${process.env['PUBLIC_DIR']}/qr/${userId}`;
      const outputPath = `${outputDir}/${track.id}.png`;

      // Create the output directory if it doesn't exist using fs
      try {
        await fs.mkdir(outputDir, { recursive: true });
      } catch (error) {
        console.log(111, error);
      }

      const qrCode = await this.generateQR(hash, outputPath);
    }

    this.generatePDF(playlist, payment);
  }

  private async generateQR(hash: string, outputPath: string) {
    try {
      // Check if the QR code already exists
      try {
        await fs.access(outputPath);
        return;
      } catch (error) {
        await QRCode.toFile(outputPath, hash, {
          type: 'png',
          color: {
            dark: '#000000', // Color of the dark squares
            light: '#FFFFFF', // Color of the light squares (usually background)
          },
          errorCorrectionLevel: 'H', // High error correction level
        });
        this.logger.log(
          color.blue.bold(`QR code generated: ${color.white.bold(outputPath)}`)
        );
      }
    } catch (error) {
      this.logger.log(color.red.bold('Error generating QR code!'));
    }
  }

  private async generatePDF(playlist: Playlist, payment: any) {
    this.logger.log(color.blue.bold('Generating PDF...'));

    console.log(111, playlist);

    const uniqueId = uuid();
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    const url = `http://localhost:3003/qr/pdf/${playlist.playlistId}/${payment.paymentId}`;
    const filename = sanitizeFilename(`${playlist.name}_${uniqueId}.pdf`);

    console.log(222, url);

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
  }
}

export default Qr;
