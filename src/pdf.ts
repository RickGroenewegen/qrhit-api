import { color } from 'console-log-colors';
import Logger from './logger';
import { Playlist } from '@prisma/client';
import ConvertApi from 'convertapi';
import AnalyticsClient from './analytics';
import { promises as fs } from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

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

  public async getPageDimensions(
    filePath: string
  ): Promise<{ width: number; height: number }> {
    // Read the PDF file into a Uint8Array
    const pdfBytes = await fs.readFile(filePath);

    // Load the PDF document
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Get the first page
    const firstPage = pdfDoc.getPage(0);

    // Get the dimensions in points
    const { width, height } = firstPage.getSize();

    // Convert points to millimeters (1 point = 0.352778 mm)
    const widthMm = width * 0.352778;
    const heightMm = height * 0.352778;

    return { width: widthMm, height: heightMm };
  }

  public async countPDFPages(filePath: string): Promise<number> {
    // Read the PDF file into a Uint8Array
    const pdfBytes = await fs.readFile(filePath);

    // Load the PDF document
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Get the number of pages
    const pageCount = pdfDoc.getPageCount();

    return pageCount;
  }

  public async generatePDF(
    filename: string,
    playlist: Playlist,
    payment: any,
    template: string,
    subdir: string
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

        const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${startIndex}/${endIndex}/${subdir}`;

        this.logger.log(
          color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
        );

        const tempFilename = `temp_${i}_${filename}`;
        const tempFilePath = `${process.env['PUBLIC_DIR']}/pdf/${tempFilename}`;

        let options = {
          File: url,
          RespectViewport: 'false',
          PageSize: 'a4',
          MarginTop: 10,
          MarginRight: 0,
          MarginBottom: 0,
          MarginLeft: 10,
          CompressPDF: 'true',
        } as any;

        if (template === 'printer') {
          options['PageWidth'] = 66;
          options['PageHeight'] = 66;
          options['MarginTop'] = 0;
          options['MarginLeft'] = 0;
        }

        const result = await this.convertapi.convert('pdf', options, 'htm');
        await result.saveFiles(tempFilePath);
        tempFiles.push(tempFilePath);

        // TODO: Add resize here

        this.analytics.increaseCounter('pdf', 'generated', 1);

        this.logger.log(
          color.blue.bold(
            `Generated temporary PDF: ${color.white.bold(tempFilename)}`
          )
        );
      }

      if (tempFiles.length === 1) {
        // If there's only one PDF, rename it instead of merging
        const finalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
        await fs.rename(tempFiles[0], finalPath);
        this.logger.log(
          color.blue.bold(`Single PDF renamed: ${color.white.bold(filename)}`)
        );
        // Clear the tempFiles array as we've renamed the file
        tempFiles.length = 0;
      } else {
        // Merge all temporary PDFs
        await this.mergePDFs(filename, tempFiles);
        this.analytics.increaseCounter('pdf', 'merged', 1);
        this.logger.log(
          color.blue.bold(`Merged PDF saved: ${color.white.bold(filename)}`)
        );
      }
    } finally {
      // Clean up temporary files only if they were merged
      if (tempFiles.length > 0) {
        await Promise.all(
          tempFiles.map(async (tempFile) => {
            try {
              await fs.access(tempFile);
              await fs.unlink(tempFile);
              this.logger.log(
                color.blue.bold(
                  `Deleted temporary file: ${color.white.bold(
                    path.basename(tempFile)
                  )}`
                )
              );
            } catch (error) {
              // File doesn't exist or couldn't be deleted, log the error
              this.logger.log(
                color.yellow.bold(
                  `Failed to delete temporary file: ${color.white.bold(
                    path.basename(tempFile)
                  )}`
                )
              );
            }
          })
        );
      }
    }

    return filename;
  }

  public async resizePDFPages(
    inputPath: string,
    outputPath: string,
    widthMm: number = 66,
    heightMm: number = 66
  ): Promise<void> {
    // Convert millimeters to points (1 mm = 2.83465 points)
    const widthPts = widthMm * 2.83465;
    const heightPts = heightMm * 2.83465;

    // Read the PDF file into a Uint8Array
    const pdfBytes = await fs.readFile(inputPath);

    // Load the PDF document
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Resize each page
    const pages = pdfDoc.getPages();
    pages.forEach((page) => {
      page.setSize(widthPts, heightPts);
    });

    // Serialize the PDFDocument to bytes (a Uint8Array)
    const pdfBytesResized = await pdfDoc.save();

    // Write the resized PDF to the output path
    await fs.writeFile(outputPath, pdfBytesResized);

    this.logger.log(
      color.blue.bold(
        `PDF pages resized to ${widthMm}x${heightMm} mm: ${color.white.bold(outputPath)}`
      )
    );
  }
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
