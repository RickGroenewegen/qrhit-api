import { color } from 'console-log-colors';
import Logger from './logger';
import { Playlist } from '@prisma/client';
import Utils from './utils';
import ConvertApi from 'convertapi';

class PDF {
  private logger = new Logger();
  private convertapi = new ConvertApi(process.env['CONVERT_API_KEY']!);

  public async generatePDF(
    filename: string,
    playlist: Playlist,
    payment: any,
    template: string,
    startProgress: number,
    endProgress: number
  ): Promise<string> {
    this.logger.log(
      color.blue.bold('Generating PDF: ') + color.white.bold(template)
    );

    const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}`;

    this.logger.log(
      color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
    );

    this.logger.log(
      color.blue.bold(`Converting to PDF: ${color.white.bold(filename)}`)
    );

    // Start a timer to increment progress
    const incrementInterval = (13 * 1000) / (endProgress - startProgress); // 13 seconds divided into the progress range
    let currentProgress = startProgress;
    const intervalId = setInterval(() => {
      if (currentProgress < endProgress) {
        currentProgress++;
      }
    }, incrementInterval);

    try {
      const result = await this.convertapi.convert(
        'pdf',
        {
          File: url,
          RespectViewport: 'false',
          PageSize: 'a4',
          MarginTop: 0,
          MarginRight: 0,
          MarginBottom: 0,
          MarginLeft: 0,
          CompressPDF: 'true',
        },
        'htm'
      );
      await result.saveFiles(`${process.env['PUBLIC_DIR']}/pdf/${filename}`);
    } finally {
      clearInterval(intervalId); // Clear the interval once the PDF generation is complete
    }

    this.logger.log(
      color.blue.bold(`Saving done: ${color.white.bold(filename)}`)
    );

    return filename;
  }

  public async compressPDF(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
    try {
      const result = await this.convertapi.convert(
        'compress',
        {
          File: inputPath,
        },
        'pdf'
      );

      await result.saveFiles(outputPath);

      this.logger.log(
        color.blue.bold(
          `PDF compression successful: ${color.white.bold(outputPath)}`
        )
      );
    } catch (error) {
      this.logger.log(color.red.bold('Error compressing PDF!'));
    }
  }
}

export default PDF;
