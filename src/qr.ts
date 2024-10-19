import { color } from 'console-log-colors';
import Logger from './logger';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

class Qr {
  private logger = new Logger();
  public async generateQRLambda(link: string, outputPath: string) {
    const lambdaClient = new LambdaClient({
      region: 'eu-west-1',
      credentials: {
        accessKeyId: process.env['AWS_LAMBDA_ACCESS_KEY_ID']!,
        secretAccessKey: process.env['AWS_LAMBDA_SECRET_KEY_ID']!,
      },
    });

    const params = { action: 'qr', url: link, outputPath: outputPath };

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

  public async generateQR(link: string, outputPath: string) {
    this.logger.log(
      color.yellow.bold('Using old QR method in development mode.')
    );
    const QRCode = require('qrcode');
    await QRCode.toFile(outputPath, link, {
      type: 'png',
      width: 600,
      color: {
        dark: '#000000',
        light: '#0000',
      },
      errorCorrectionLevel: 'H',
    });
    this.logger.log(
      color.green.bold('QR code generated successfully using the old method!')
    );
  }
}

export default Qr;
