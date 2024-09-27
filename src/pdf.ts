import { color } from 'console-log-colors';
import Logger from './logger';
import { Playlist } from '@prisma/client';
import Utils from './utils';
import ConvertApi from 'convertapi';
import AnalyticsClient from './analytics';
import fs from 'fs';
import path from 'path';

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
    let itemsPerPage = template === 'digital' ? 12 : 1;
    const pagesPerTrack = template === 'printer' ? 2 : 1;
    const totalPages = Math.ceil(numberOfTracks / itemsPerPage) * pagesPerTrack;
    const maxPagesPerPDF = 100;

    this.logger.log(
      color.blue.bold('Generating PDF: ') + color.white.bold(template)
    );

    const tempFiles: string[] = [];

    try {
      for (let i = 0; i < totalPages; i += maxPagesPerPDF) {
        const startIndex = (i * itemsPerPage) / pagesPerTrack;
        const endIndex = Math.min(
          ((i + maxPagesPerPDF) * itemsPerPage) / pagesPerTrack,
          numberOfTracks
        );

        const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${startIndex}/${endIndex}`;

        this.logger.log(
          color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
        );

        const tempFilename = `temp_${i}_${filename}`;
        const tempFilePath = `${process.env['PUBLIC_DIR']}/pdf/${tempFilename}`;

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

        if (template === 'printer') {
          options['PageWidth'] = 60;
          options['PageHeight'] = 60;
        }

        const result = await this.convertapi.convert('pdf', options, 'htm');
        await result.saveFiles(tempFilePath);
        tempFiles.push(tempFilePath);

        this.analytics.increaseCounter('pdf', 'generated', 1);

        this.logger.log(
          color.blue.bold(
            `Generated temporary PDF: ${color.white.bold(tempFilename)}`
          )
        );
      }

      // Merge all temporary PDFs
      await this.mergePDFs(filename, tempFiles);

      this.analytics.increaseCounter('pdf', 'merged', 1);

      this.logger.log(
        color.blue.bold(`Merged PDF saved: ${color.white.bold(filename)}`)
      );
    } finally {
      // Clean up temporary files
      for (const tempFile of tempFiles) {
        fs.unlinkSync(tempFile);
        this.logger.log(
          color.blue.bold(
            `Deleted temporary file: ${color.white.bold(
              path.basename(tempFile)
            )}`
          )
        );
      }
    }

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
