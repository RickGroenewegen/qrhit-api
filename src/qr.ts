import { color } from 'console-log-colors';
import Logger from './logger';
import AWS from 'aws-sdk';

class Qr {
  private logger = new Logger();
  public async generateQR(link: string, outputPath: string) {
    const lambda = new AWS.Lambda();
    const params = {
      FunctionName: 'qrLambda',
      Payload: JSON.stringify({ link, outputPath }),
    };

    try {
      const response = await lambda.invoke(params).promise();
      const result = JSON.parse(response.Payload as string);

      if (result.errorMessage) {
        throw new Error(result.errorMessage);
      }

      this.logger.log(color.green.bold('QR code generated successfully!'));
    } catch (error) {
      this.logger.log(color.red.bold('Error generating QR code via Lambda!'));
    }
  }
}

export default Qr;
