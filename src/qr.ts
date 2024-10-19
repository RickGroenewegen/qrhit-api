import { color } from 'console-log-colors';
import Logger from './logger';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

class Qr {
  private logger = new Logger();
  public async generateQR(link: string, outputPath: string) {
    if (process.env['ENVIRONMENT'] === 'development') {
      // Old QR method logic
      this.logger.log(
        color.yellow.bold('Using old QR method in development mode.')
      );
      // Implement the old QR method here
    } else {
      const lambdaClient = new LambdaClient({
        region: 'eu-west-1',
        credentials: {
          accessKeyId: process.env['AWS_LAMBDA_ACCESS_KEY_ID']!,
          secretAccessKey: process.env['AWS_LAMBDA_SECRET_KEY_ID']!,
        },
      });
      const command = new InvokeCommand({
        FunctionName: 'arn:aws:lambda:eu-west-1:071455255929:function:qrLambda',
        Payload: new TextEncoder().encode(
          JSON.stringify({ action: 'qr', url: link, outputPath: outputPath })
        ),
      });

      try {
        const response = await lambdaClient.send(command);
        const result = JSON.parse(
          new TextDecoder('utf-8').decode(response.Payload)
        );

        if (result.errorMessage) {
          throw new Error(result.errorMessage);
        }

        this.logger.log(color.green.bold('QR code generated successfully!'));
      } catch (error) {
        this.logger.log(color.red.bold('Error generating QR code via Lambda!'));
        console.log(error);
      }
    }
  }
}

export default Qr;
