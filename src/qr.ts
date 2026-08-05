import { color } from 'console-log-colors';
import QRCode from 'qrcode';
import Logger from './logger';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// The qrcode package's default quiet zone, in modules, on every side.
const QR_QUIET_ZONE = 4;

/**
 * Module count of the QR symbol for a link, quiet zone included.
 *
 * Templates that overlay something on a QR code use this to line the overlay up
 * with the module grid: a rendered PNG is exactly `width` px wide, so one module
 * is `width / getQrTotalModules(link)`. Snapping an overlay to that pitch keeps
 * it from slicing modules in half, which reads as ragged half-squares.
 *
 * The symbol version depends on the link length, so this must be called with
 * the same link the QR was generated from, and it mirrors generateQR's error
 * correction level H.
 */
export function getQrTotalModules(link: string): number {
  return (
    QRCode.create(link, { errorCorrectionLevel: 'H' }).modules.size +
    QR_QUIET_ZONE * 2
  );
}

class Qr {
  private logger = new Logger();
  public async generateQRLambda(
    link: string,
    outputPath: string,
    qrColor: string
  ) {
    const lambdaClient = new LambdaClient({
      region: 'eu-west-1',
      credentials: {
        accessKeyId: process.env['AWS_LAMBDA_ACCESS_KEY_ID']!,
        secretAccessKey: process.env['AWS_LAMBDA_SECRET_KEY_ID']!,
      },
    });

    const params = {
      action: 'qr',
      url: link,
      outputPath: outputPath,
      qrColor: qrColor || '#000000',
    };

    const command = new InvokeCommand({
      FunctionName: 'arn:aws:lambda:eu-west-1:071455255929:function:qrLambda',
      Payload: new TextEncoder().encode(JSON.stringify(params)),
    });

    try {
      const response = await lambdaClient.send(command);
      const result = JSON.parse(
        new TextDecoder('utf-8').decode(response.Payload)
      );

      if (result.statusCode == 500) {
        const errorObject = JSON.parse(result.body);
        this.logger.log(
          color.red.bold('Error running Lambda function: ') +
            color.white.bold(errorObject.error)
        );
        // Fallback to old method. Must carry qrColor: without it the fallback
        // silently defaults to black and the customer gets a deck where the
        // failed cards are the wrong colour.
        await this.generateQR(link, outputPath, qrColor);
      }
    } catch (error) {
      this.logger.log(color.red.bold('Error generating QR code via Lambda!'));
      console.log(error);
    }
  }

  public async generateQR(
    link: string,
    outputPath: string,
    qrColor: string = '#000000',
    type: 'png' | 'svg' = 'png'
  ) {
    await QRCode.toFile(outputPath, link, {
      type: type as any,
      width: 600,
      color: {
        dark: qrColor,
        light: '#0000',
      },
      errorCorrectionLevel: 'H',
    });
  }
}

export default Qr;
