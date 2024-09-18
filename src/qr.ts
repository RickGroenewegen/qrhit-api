import { color } from 'console-log-colors';
import Logger from './logger';
import { PrismaClient } from '@prisma/client';
import Utils from './utils';
import * as QRCode from 'qrcode';

class Qr {
  private logger = new Logger();
  private utils = new Utils();
  private prisma = new PrismaClient();

  public async generateQR(link: string, outputPath: string) {
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
}

export default Qr;
