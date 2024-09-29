import { color } from 'console-log-colors';
import Logger from './logger';
import * as QRCode from 'qrcode';

class Qr {
  private logger = new Logger();
  public async generateQR(link: string, outputPath: string) {
    try {
      await QRCode.toFile(outputPath, link, {
        type: 'png',
        width: 600,
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
