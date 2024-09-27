import { color } from 'console-log-colors';
import Logger from './logger';
import { Playlist } from '@prisma/client';
import Utils from './utils';
import ConvertApi from 'convertapi';
import AnalyticsClient from './analytics';

class PDF {
  private logger = new Logger();
  private convertapi = new ConvertApi(process.env['CONVERT_API_KEY']!);
  private analytics = AnalyticsClient.getInstance();

  public async mergePDFs(filename: string, files: string[]) {
    const result = await this.convertapi.convert(
      'merge',
      {
        Files: files,
      },
      'pdf'
    );
    await result.saveFiles(`${process.env['PUBLIC_DIR']}/pdf/${filename}`);
  }

  public async generatePDF(
    filename: string,
    playlist: Playlist,
    payment: any,
    template: string
  ): Promise<string> {
    const numberOfTracks = playlist.numberOfTracks;
    let itemsPerPage = 1;
    let startIndex = 0;
    let endIndex = 0;

    if (template == 'digital') {
      itemsPerPage = 12;
    }

    this.logger.log(
      color.blue.bold('Generating PDF: ') + color.white.bold(template)
    );

    let startPage = 1;

    const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${startIndex}/${endIndex}`;

    this.logger.log(
      color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
    );

    this.logger.log(
      color.blue.bold(`Converting to PDF: ${color.white.bold(filename)}`)
    );

    try {
      let options = {
        File: url,
        RespectViewport: 'false',
        PageSize: 'a4',
        MarginTop: 0,
        MarginRight: 0,
        MarginBottom: 0,
        MarginLeft: 0,
        CompressPDF: 'true',
      } as any;

      if (template == 'printer') {
        options['PageWidth'] = 60;
        options['PageHeight'] = 60;
      }

      const result = await this.convertapi.convert('pdf', options, 'htm');

      this.analytics.increaseCounter('pdf', 'generated', 1);

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
