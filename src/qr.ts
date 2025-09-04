import { color } from 'console-log-colors';
import QRCode from 'qrcode';
import Logger from './logger';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

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
        // Fallback to old method
        this.generateQR(link, outputPath);
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
