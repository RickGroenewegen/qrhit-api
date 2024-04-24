import { color } from 'console-log-colors';
import Logger from './logger';
import { PrismaClient } from '@prisma/client';
import Spotify from './spotify';
import Mollie from './mollie';
import Data from './data';
import * as QRCode from 'qrcode';
import * as fs from 'fs/promises';
import * as puppeteer from 'puppeteer';

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

    // Check if the user is the same as the one who made the payment
    if (userProfile.data.userId !== userId) {
      console.log(
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

    this.generatePDF();
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
      console.error('Error generating QR code:', error);
    }
  }

  private async generatePDF() {
    this.logger.log(color.blue.bold('Generating PDF...'));

    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // Navigate to the URL
    await page.goto('http://localhost:3003/qr/pdf', {
      waitUntil: 'networkidle0', // Ensures the page has loaded completely
    });

    // Define PDF options
    const pdfOptions: puppeteer.PDFOptions = {
      path: 'trivia-card.pdf', // Path to save PDF
      format: 'A4',
      printBackground: true,
    };

    // Generate the PDF
    await page.pdf(pdfOptions);
    await browser.close();

    console.log('PDF Generated from URL!');
  }
}

export default Qr;
