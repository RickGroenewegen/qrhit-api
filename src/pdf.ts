import { color, white } from 'console-log-colors';
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
    subdir: string,
    eco: boolean = false,
    printerType: string,
    itemIndex?: number
  ): Promise<string> {
    const numberOfTracks = playlist.numberOfTracks;

    // Determine if this is a digital template (multi-item per page) or printer template (single item, front/back)
    const isDigitalTemplate =
      template === 'digital' ||
      template === 'digital_double' ||
      template === 'printer_sheets';

    let itemsPerPage = isDigitalTemplate ? 6 : 1;
    const pagesPerTrack = isDigitalTemplate ? 1 : 2;
    const totalPages = Math.ceil(numberOfTracks / itemsPerPage) * pagesPerTrack;
    const maxPagesPerPDF = 100;

    let ecoInt = eco ? 1 : 0;
    let emptyPages = 0;

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

        const itemIndexParam = itemIndex !== undefined ? itemIndex : 0;
        const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${startIndex}/${endIndex}/${subdir}/${ecoInt}/${emptyPages}/${itemIndexParam}`;

        this.logger.log(
          color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
        );

        const tempFilename = `temp_${i}_${filename}`;
        const tempFilePath = `${process.env['PUBLIC_DIR']}/pdf/${tempFilename}`;

        let options = {
          File: url,
          RespectViewport: 'false',
          ConversionDelay: 10,
          PageSize: 'a4',
          MarginTop: 0,
          MarginRight: 0,
          MarginBottom: 0,
          MarginLeft: 0,
          CompressPDF: 'true',
          LoadLazyContent: 'true', // Load all lazy content including fonts
        } as any;

        if (!isDigitalTemplate) {
          // Printer templates (including custom ones) use 60x60mm pages
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

      const finalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;

      if (tempFiles.length === 1) {
        // If there's only one PDF, rename it instead of merging

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
      if (!isDigitalTemplate) {
        // Printer templates (including custom ones) need resize and bleed
        if (payment.vibe) {
          // Happibox wants a 3% increase in size for the printer
          await this.resizePDFPages(finalPath, 62, 62);
        } else {
          // Resize them to exactly 60x60 mm because convertAPI is slightly off
          await this.resizePDFPages(finalPath, 60, 60);
        }

        // Add bleed based on printer type
        if (printerType === 'tromp') {
          // True bleed: scale content to extend into bleed area
          await this.addTrueBleed(finalPath, 3);
          // Convert to CMYK color space for professional printing
          await this.convertToCMYK(finalPath);
        } else {
          // Standard bleed: add whitespace around content
          await this.addBleed(finalPath, 3);
        }
      } else if (template === 'printer_sheets') {
        // Resize to A4
        await this.resizePDFPages(finalPath, 210, 297);
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

  public async generateGiftcardPDF(
    filename: string,
    playlist: Playlist,
    discount: any,
    payment: any,
    template: string,
    subdir: string
  ): Promise<string> {
    const url = `${process.env['API_URI']}/discount/voucher/${template}/${discount.code}/${payment.paymentId}`;

    this.logger.log(
      color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
    );

    const tempFilename = `${filename}`;
    const tempFilePath = `${process.env['PUBLIC_DIR']}/pdf/${tempFilename}`;

    let options = {
      File: url,
      RespectViewport: 'false',
      PageSize: 'a4',
      MarginTop: 0,
      MarginRight: 0,
      MarginBottom: 0,
      MarginLeft: 0,
      PageRange: '1',
      CompressPDF: 'true',
    } as any;

    if (template === 'printer') {
      options['PageSize'] = 'a5';
      options['PageRange'] = '1-2';
    }

    const result = await this.convertapi.convert('pdf', options, 'htm');
    await result.saveFiles(tempFilePath);

    this.analytics.increaseCounter('pdf', 'generated', 1);

    this.logger.log(
      color.blue.bold(
        `Generated temporary PDF: ${color.white.bold(tempFilename)}`
      )
    );

    const finalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;

    if (template === 'printer') {
      // Resize them to exactly 60x60 mm because convertAPI is slightly off
      await this.resizePDFPages(finalPath, 210, 148);
      // Add a 3 mm bleed for PrintAPI
      await this.addBleed(finalPath, 3);
    }

    return filename;
  }

  private async mmToPoints(mm: number): Promise<number> {
    return mm * (72 / 25.4);
  }

  private async flattenPdf(inputPath: string): Promise<void> {
    try {
      const result = await this.convertapi.convert(
        'flatten',
        {
          File: inputPath,
        },
        'pdf'
      );

      await result.saveFiles(inputPath);

      this.logger.log(
        color.blue.bold(
          `PDF flattening successful: ${color.white.bold(inputPath)}`
        )
      );
    } catch (error) {
      this.logger.log(color.red.bold('Error flattening PDF!'));
    }
  }

  /**
   * Splits a PDF file into multiple parts based on page ranges
   * @param inputPath Path to the input PDF file
   * @param ranges Array of objects containing start and end page numbers
   * @returns Array of paths to the split PDF files
   */
  public async splitPdf(
    inputPath: string,
    ranges: Array<{ start: number; end: number }>
  ): Promise<string[]> {
    try {
      // Format ranges into the required string format (e.g., "1-54,55-58,59-59")
      const rangeString = ranges
        .map((range) => `${range.start}-${range.end}`)
        .join(',');

      const result = await this.convertapi.convert(
        'split',
        {
          File: inputPath,
          SplitMode: 'ranges',
          SplitByCustomRange: rangeString,
        },
        'pdf'
      );

      // Get the directory path from the input file
      const dir = path.dirname(inputPath);
      const basename = path.basename(inputPath, '.pdf');

      // Save each split file and collect their paths
      const outputPaths: string[] = [];
      for (let i = 0; i < result.files.length; i++) {
        const outputPath = path.join(dir, `${basename}_part${i + 1}.pdf`);
        await result.files[i].save(outputPath);
        outputPaths.push(outputPath);

        this.logger.log(
          color.blue.bold(
            `Split PDF part ${i + 1} saved: ${color.white.bold(outputPath)}`
          )
        );
      }

      return outputPaths;
    } catch (error) {
      this.logger.log(color.red.bold('Error splitting PDF!'));
      throw error;
    }
  }

  public async addBleed(inputPath: string, bleed: number) {
    const bleedSizeInPoints = await this.mmToPoints(bleed);
    const existingPdfBytes = await fs.readFile(inputPath);

    // Load a PDFDocument from the existing PDF bytes
    const pdfDoc = await PDFDocument.load(existingPdfBytes);

    // Calculate new dimensions and bleed
    const pages = pdfDoc.getPages();
    pages.forEach((page) => {
      const { width, height } = page.getSize();
      const newWidth = width + 2 * bleedSizeInPoints; // add bleed to both sides horizontally
      const newHeight = height + 2 * bleedSizeInPoints; // add bleed to both sides vertically

      // Resize page
      page.setSize(newWidth, newHeight);

      // Move existing content into the center, accounting for bleed
      page.translateContent(bleedSizeInPoints, bleedSizeInPoints);
    });

    // Serialize the PDFDocument to bytes (a Uint8Array)
    const pdfBytes = await pdfDoc.save();

    // Write the PDF to a file
    await fs.writeFile(inputPath, pdfBytes);

    this.logger.log(
      color.blue.bold(
        `Added a ${white.bold(bleed)} mm bleed to PDF file: ${color.white.bold(
          inputPath
        )}`
      )
    );
  }

  public async addTrueBleed(inputPath: string, bleed: number) {
    const bleedSizeInPoints = await this.mmToPoints(bleed);
    const existingPdfBytes = await fs.readFile(inputPath);

    // Load a PDFDocument from the existing PDF bytes
    const pdfDoc = await PDFDocument.load(existingPdfBytes);

    // Process each page for true bleed
    const pages = pdfDoc.getPages();
    pages.forEach((page) => {
      const { width, height } = page.getSize();
      const newWidth = width + 2 * bleedSizeInPoints; // add bleed to both sides horizontally
      const newHeight = height + 2 * bleedSizeInPoints; // add bleed to both sides vertically

      // Calculate scale factors to make content extend into bleed area
      const scaleX = newWidth / width;
      const scaleY = newHeight / height;

      // Scale the content first (this makes it larger)
      page.scaleContent(scaleX, scaleY);

      // Calculate the new scaled dimensions
      const scaledWidth = width * scaleX;
      const scaledHeight = height * scaleY;

      // Calculate translation to center the scaled content
      const translateX = (newWidth - scaledWidth) / 2;
      const translateY = (newHeight - scaledHeight) / 2;

      // Translate to center
      page.translateContent(translateX, translateY);

      // Resize page to include bleed
      page.setSize(newWidth, newHeight);
    });

    // Serialize the PDFDocument to bytes (a Uint8Array)
    const pdfBytes = await pdfDoc.save();

    // Write the PDF to a file
    await fs.writeFile(inputPath, pdfBytes);

    this.logger.log(
      color.blue.bold(
        `Added a ${white.bold(
          bleed
        )} mm TRUE bleed to PDF file (content extended): ${color.white.bold(
          inputPath
        )}`
      )
    );
  }

  public async convertToCMYK(inputPath: string): Promise<void> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Create a temporary output path
    const tempOutputPath = `${inputPath}.cmyk.tmp.pdf`;

    // Ghostscript command to convert RGB to CMYK
    const gsCommand = `gs -dSAFER -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -sColorConversionStrategy=CMYK -sColorConversionStrategyForImages=CMYK -sProcessColorModel=DeviceCMYK -dUseCIEColor -sOutputFile="${tempOutputPath}" "${inputPath}"`;

    try {
      this.logger.log(
        color.blue.bold(
          `Converting PDF to CMYK color space: ${color.white.bold(inputPath)}`
        )
      );

      // Execute Ghostscript command
      await execAsync(gsCommand);

      // Replace original file with CMYK version
      await fs.unlink(inputPath);
      await fs.rename(tempOutputPath, inputPath);

      this.logger.log(
        color.green.bold(
          `Successfully converted PDF to CMYK: ${color.white.bold(inputPath)}`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error converting PDF to CMYK: ${error}`)
      );

      // Clean up temp file if it exists
      try {
        await fs.unlink(tempOutputPath);
      } catch {
        // Ignore if temp file doesn't exist
      }

      throw error;
    }
  }

  public async resizePDFPages(
    inputPath: string,
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

    // Resize each page and scale the content
    const pages = pdfDoc.getPages();
    pages.forEach((page) => {
      const { width, height } = page.getSize();

      // Calculate the scale factors
      const scaleX = widthPts / width;
      const scaleY = heightPts / height;

      // Scale the content
      page.scaleContent(scaleX, scaleY);

      // Set the new page size
      page.setSize(widthPts, heightPts);
    });

    // Serialize the PDFDocument to bytes (a Uint8Array)
    const pdfBytesResized = await pdfDoc.save();

    // Write the resized PDF to the output path
    await fs.writeFile(inputPath, pdfBytesResized);

    this.logger.log(
      color.blue.bold(
        `PDF pages resized to ${white.bold(widthMm.toFixed(2))} x ${white.bold(
          heightMm.toFixed(2)
        )} mm: ${color.white.bold(inputPath)}`
      )
    );
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
