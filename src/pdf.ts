import { color, white } from 'console-log-colors';
import Logger from './logger';
import { Playlist } from '@prisma/client';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import ConvertApi from 'convertapi';
import AnalyticsClient from './analytics';
import { promises as fs } from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

interface LambdaPdfOptions {
  url: string;
  options: {
    format?: string;
    width?: number;
    height?: number;
    marginTop?: number;
    marginRight?: number;
    marginBottom?: number;
    marginLeft?: number;
    pageRanges?: string;
    landscape?: boolean;
  };
}

interface LambdaMergeOptions {
  operation: 'merge';
  s3Keys: string[];
  s3Bucket?: string;
  deleteAfterMerge?: boolean;
}

interface S3PdfResult {
  s3Bucket: string;
  s3Key: string;
  size: number;
}

class PDF {
  private logger = new Logger();
  private awsRegion = process.env['AWS_LAMBDA_REGION'] || process.env['AWS_REGION'] || 'eu-west-1';
  private awsCredentials = process.env['AWS_LAMBDA_ACCESS_KEY_ID'] ? {
    accessKeyId: process.env['AWS_LAMBDA_ACCESS_KEY_ID']!,
    secretAccessKey: process.env['AWS_LAMBDA_SECRET_KEY_ID']!,
  } : undefined;
  private lambdaClient = new LambdaClient({
    region: this.awsRegion,
    credentials: this.awsCredentials,
  });
  private s3Client = new S3Client({
    region: this.awsRegion,
    credentials: this.awsCredentials,
  });
  private lambdaFunctionName = process.env['PDF_LAMBDA_FUNCTION'] ||
    (process.env['ENVIRONMENT'] === 'development' ? 'convertHTMLToPDF-dev' : 'convertHTMLToPDF');
  private convertapi = new ConvertApi(process.env['CONVERT_API_KEY']!);
  private analytics = AnalyticsClient.getInstance();

  /**
   * Invoke the Lambda function to convert HTML to PDF
   */
  private async convertHtmlToPdf(
    url: string,
    options: LambdaPdfOptions['options']
  ): Promise<Buffer> {
    this.logger.log(
      color.blue.bold(`Invoking Lambda ${color.white.bold(this.lambdaFunctionName)} for URL: ${color.white.bold(url)}`)
    );

    const payload: LambdaPdfOptions = {
      url,
      options,
    };

    const command = new InvokeCommand({
      FunctionName: this.lambdaFunctionName,
      Payload: JSON.stringify(payload),
    });

    const response = await this.lambdaClient.send(command);

    if (response.FunctionError) {
      const errorPayload = response.Payload
        ? JSON.parse(Buffer.from(response.Payload).toString())
        : { message: 'Unknown Lambda error' };
      throw new Error(`Lambda error: ${errorPayload.message || errorPayload.errorMessage}`);
    }

    if (!response.Payload) {
      throw new Error('No payload returned from Lambda');
    }

    const resultString = Buffer.from(response.Payload).toString();
    const result = JSON.parse(resultString);

    if (result.statusCode !== 200) {
      const errorBody = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
      const errorDetails = [
        errorBody?.message || 'Unknown error',
        errorBody?.error ? `Error: ${errorBody.error}` : null,
        errorBody?.errorName ? `Type: ${errorBody.errorName}` : null,
        errorBody?.errorStack ? `Stack: ${errorBody.errorStack}` : null,
      ].filter(Boolean).join(' | ');
      throw new Error(`PDF generation failed: ${errorDetails}`);
    }

    // Check if the response contains S3 information (large PDF)
    const bodyContent = typeof result.body === 'string' && result.body.startsWith('{')
      ? JSON.parse(result.body)
      : null;

    if (bodyContent?.s3Key) {
      // Large PDF was uploaded to S3 - download it
      this.logger.log(
        color.blue.bold(`PDF stored in S3, downloading from: ${color.white.bold(bodyContent.s3Key)}`)
      );

      const getCommand = new GetObjectCommand({
        Bucket: bodyContent.s3Bucket,
        Key: bodyContent.s3Key,
      });

      const s3Response = await this.s3Client.send(getCommand);
      const pdfBuffer = Buffer.from(await s3Response.Body!.transformToByteArray());

      this.logger.log(
        color.blue.bold(`PDF downloaded from S3, size: ${white.bold(pdfBuffer.length)} bytes`)
      );

      // Delete from S3 after downloading (lifecycle rule is backup)
      try {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: bodyContent.s3Bucket,
          Key: bodyContent.s3Key,
        }));
        this.logger.log(
          color.blue.bold(`Deleted PDF from S3: ${color.white.bold(bodyContent.s3Key)}`)
        );
      } catch (deleteError) {
        this.logger.log(
          color.yellow.bold(`Warning: Failed to delete PDF from S3: ${bodyContent.s3Key}`)
        );
      }

      return pdfBuffer;
    }

    // Small PDF - returned directly as base64
    const pdfBuffer = Buffer.from(result.body, 'base64');
    this.logger.log(
      color.blue.bold(`PDF buffer size: ${pdfBuffer.length} bytes, first bytes: ${pdfBuffer.slice(0, 10).toString('hex')}`)
    );

    return pdfBuffer;
  }

  /**
   * Convert HTML to PDF and keep in S3 (don't download)
   * Returns S3 key for later merge
   * Includes retry logic (max 3 attempts)
   */
  private async convertHtmlToPdfToS3(
    url: string,
    options: LambdaPdfOptions['options'],
    logPrefix?: string
  ): Promise<S3PdfResult> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const prefix = logPrefix ? `${logPrefix} - ` : '';
        const attemptSuffix = attempt > 1 ? ` (attempt ${attempt}/${maxRetries})` : '';
        this.logger.log(
          color.blue.bold(`${prefix}Invoking Lambda ${color.white.bold(this.lambdaFunctionName)} for URL: ${color.white.bold(url)}${attemptSuffix}`)
        );

        const payload: LambdaPdfOptions = {
          url,
          options,
        };

        const command = new InvokeCommand({
          FunctionName: this.lambdaFunctionName,
          Payload: JSON.stringify(payload),
        });

        const response = await this.lambdaClient.send(command);

        if (response.FunctionError) {
          const errorPayload = response.Payload
            ? JSON.parse(Buffer.from(response.Payload).toString())
            : { message: 'Unknown Lambda error' };
          throw new Error(`Lambda error: ${errorPayload.message || errorPayload.errorMessage}`);
        }

        if (!response.Payload) {
          throw new Error('No payload returned from Lambda');
        }

        const resultString = Buffer.from(response.Payload).toString();
        const result = JSON.parse(resultString);

        if (result.statusCode !== 200) {
          const errorBody = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
          const errorDetails = [
            errorBody?.message || 'Unknown error',
            errorBody?.error ? `Error: ${errorBody.error}` : null,
            errorBody?.errorName ? `Type: ${errorBody.errorName}` : null,
            errorBody?.errorStack ? `Stack: ${errorBody.errorStack}` : null,
          ].filter(Boolean).join(' | ');
          throw new Error(`PDF generation failed: ${errorDetails}`);
        }

        const bodyContent = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;

        if (!bodyContent?.s3Key) {
          throw new Error('Lambda did not return S3 key');
        }

        return {
          s3Bucket: bodyContent.s3Bucket,
          s3Key: bodyContent.s3Key,
          size: bodyContent.size,
        };
      } catch (error) {
        lastError = error as Error;
        const prefix = logPrefix ? `${logPrefix} - ` : '';

        if (attempt < maxRetries) {
          this.logger.log(
            color.yellow.bold(`${prefix}Attempt ${attempt}/${maxRetries} failed: ${lastError.message}. Retrying...`)
          );
          // Small delay before retry (increases with each attempt)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        } else {
          this.logger.log(
            color.red.bold(`${prefix}All ${maxRetries} attempts failed: ${lastError.message}`)
          );
        }
      }
    }

    throw lastError;
  }

  /**
   * Merge multiple PDFs via Lambda
   * Returns the merged PDF as a Buffer
   */
  private async mergePdfsViaLambda(s3Keys: string[]): Promise<Buffer> {
    this.logger.log(
      color.blue.bold(`Invoking Lambda ${color.white.bold(this.lambdaFunctionName)} to merge ${color.white.bold(s3Keys.length.toString())} PDFs`)
    );

    const payload: LambdaMergeOptions = {
      operation: 'merge',
      s3Keys,
      deleteAfterMerge: true,
    };

    const command = new InvokeCommand({
      FunctionName: this.lambdaFunctionName,
      Payload: JSON.stringify(payload),
    });

    const response = await this.lambdaClient.send(command);

    if (response.FunctionError) {
      const errorPayload = response.Payload
        ? JSON.parse(Buffer.from(response.Payload).toString())
        : { message: 'Unknown Lambda error' };
      throw new Error(`Lambda merge error: ${errorPayload.message || errorPayload.errorMessage}`);
    }

    if (!response.Payload) {
      throw new Error('No payload returned from Lambda merge');
    }

    const resultString = Buffer.from(response.Payload).toString();
    this.logger.log(
      color.blue.bold(`Lambda merge response: ${color.white.bold(resultString.substring(0, 500))}`)
    );
    const result = JSON.parse(resultString);

    if (result.statusCode !== 200) {
      const errorBody = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
      const errorDetails = [
        errorBody?.message || 'Unknown error',
        errorBody?.error ? `Error: ${errorBody.error}` : null,
        errorBody?.errorName ? `Type: ${errorBody.errorName}` : null,
        errorBody?.errorStack ? `Stack: ${errorBody.errorStack}` : null,
      ].filter(Boolean).join(' | ');
      throw new Error(`PDF merge failed: ${errorDetails}`);
    }

    const bodyContent = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;

    this.logger.log(
      color.blue.bold(`Merged PDF stored in S3: ${color.white.bold(bodyContent.s3Key)} (${white.bold(bodyContent.size)} bytes, ${white.bold(bodyContent.pageCount)} pages)`)
    );

    // Download merged PDF from S3
    const getCommand = new GetObjectCommand({
      Bucket: bodyContent.s3Bucket,
      Key: bodyContent.s3Key,
    });

    const s3Response = await this.s3Client.send(getCommand);
    const pdfBuffer = Buffer.from(await s3Response.Body!.transformToByteArray());

    this.logger.log(
      color.blue.bold(`Downloaded merged PDF from S3, size: ${white.bold(pdfBuffer.length)} bytes`)
    );

    // Delete merged PDF from S3
    try {
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: bodyContent.s3Bucket,
        Key: bodyContent.s3Key,
      }));
      this.logger.log(
        color.blue.bold(`Deleted merged PDF from S3: ${color.white.bold(bodyContent.s3Key)}`)
      );
    } catch (deleteError) {
      this.logger.log(
        color.yellow.bold(`Warning: Failed to delete merged PDF from S3: ${bodyContent.s3Key}`)
      );
    }

    return pdfBuffer;
  }

  /**
   * Download a PDF from S3 and return as Buffer
   */
  private async downloadFromS3(s3Key: string, s3Bucket: string = 'qrhit-lambda-deployments'): Promise<Buffer> {
    const getCommand = new GetObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
    });

    const s3Response = await this.s3Client.send(getCommand);
    return Buffer.from(await s3Response.Body!.transformToByteArray());
  }

  /**
   * Delete a PDF from S3
   */
  private async deleteFromS3(s3Key: string, s3Bucket: string = 'qrhit-lambda-deployments'): Promise<void> {
    try {
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key,
      }));
      this.logger.log(
        color.blue.bold(`Deleted PDF from S3: ${color.white.bold(s3Key)}`)
      );
    } catch (deleteError) {
      this.logger.log(
        color.yellow.bold(`Warning: Failed to delete PDF from S3: ${s3Key}`)
      );
    }
  }

  /**
   * Cleanup multiple S3 keys (used for error handling)
   */
  private async cleanupS3Keys(s3Keys: string[]): Promise<void> {
    for (const s3Key of s3Keys) {
      await this.deleteFromS3(s3Key);
    }
  }

  /**
   * Merge PDFs using ConvertAPI
   */
  private async mergePDFsViaConvertApi(filename: string, files: string[]): Promise<void> {
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

  /**
   * Main entry point for PDF generation - routes to appropriate provider
   */
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
    // Determine provider based on payment email
    const useLambda = true; // payment.email === 'west14@gmail.com';

    if (useLambda) {
      this.logger.log(color.blue.bold('Using Lambda PDF provider'));
      return this.generatePDFViaLambda(filename, playlist, payment, template, subdir, eco, printerType, itemIndex);
    } else {
      this.logger.log(color.blue.bold('Using ConvertAPI PDF provider'));
      return this.generatePDFViaConvertApi(filename, playlist, payment, template, subdir, eco, printerType, itemIndex);
    }
  }

  /**
   * Generate PDF using ConvertAPI (sequential chunks, rate-limited)
   */
  private async generatePDFViaConvertApi(
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
      template === 'digital_us' ||
      template === 'digital_double_us' ||
      template === 'printer_sheets';

    const itemsPerPage = isDigitalTemplate ? 6 : 1;
    const pagesPerTrack = isDigitalTemplate ? 1 : 2;
    const totalPages = Math.ceil(numberOfTracks / itemsPerPage) * pagesPerTrack;
    const maxPagesPerPDF = 100;

    let ecoInt = eco ? 1 : 0;
    let emptyPages = 0;

    this.logger.log(
      color.blue.bold('Generating PDF: ') + color.white.bold(template) +
      color.blue.bold(` (${white.bold(numberOfTracks.toString())} tracks, ${white.bold(totalPages.toString())} pages)`)
    );

    const tempFiles: string[] = [];
    const itemIndexParam = itemIndex !== undefined ? itemIndex : 0;

    try {
      const totalChunks = Math.ceil(totalPages / maxPagesPerPDF);

      // Sequential chunk generation (ConvertAPI has rate limits)
      for (let i = 0; i < totalPages; i += maxPagesPerPDF) {
        const startIndex = (i * itemsPerPage) / pagesPerTrack;
        const endIndex = Math.min(
          ((i + maxPagesPerPDF) * itemsPerPage) / pagesPerTrack,
          numberOfTracks
        ) - 1;
        const chunkNumber = Math.floor(i / maxPagesPerPDF) + 1;

        const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${startIndex}/${endIndex}/${subdir}/${ecoInt}/${emptyPages}/${itemIndexParam}`;

        this.logger.log(
          color.blue.bold(`Chunk ${white.bold(chunkNumber.toString())} / ${white.bold(totalChunks.toString())} - Retrieving PDF from URL: ${color.white.bold(url)}`)
        );

        const tempFilename = `temp_${i}_${filename}`;
        const tempFilePath = `${process.env['PUBLIC_DIR']}/pdf/${tempFilename}`;

        // Determine page size for digital templates (US Letter for _us templates, A4 otherwise)
        const isUsTemplate = template.endsWith('_us');

        let options = {
          File: url,
          RespectViewport: 'false',
          ConversionDelay: 10,
          MarginTop: 0,
          MarginRight: 0,
          MarginBottom: 0,
          MarginLeft: 0,
          CompressPDF: 'true',
          LoadLazyContent: 'true',
        } as any;

        if (!isDigitalTemplate) {
          // Printer templates use 60x60mm pages
          options['PageWidth'] = 60;
          options['PageHeight'] = 60;
        } else if (isUsTemplate) {
          // US Letter: 8.5" x 11" = 215.9mm x 279.4mm
          options['PageWidth'] = 215.9;
          options['PageHeight'] = 279.4;
        } else {
          // A4: 210mm x 297mm
          options['PageSize'] = 'a4';
        }

        const result = await this.convertapi.convert('pdf', options, 'htm');
        await result.saveFiles(tempFilePath);
        tempFiles.push(tempFilePath);

        this.analytics.increaseCounter('pdf', 'generated', 1);

        this.logger.log(
          color.blue.bold(`Generated temporary PDF: ${color.white.bold(tempFilename)}`)
        );
      }

      const finalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;

      if (tempFiles.length === 1) {
        // If there's only one PDF, rename it instead of merging
        await fs.rename(tempFiles[0], finalPath);
        this.logger.log(
          color.blue.bold(`Single PDF renamed: ${color.white.bold(filename)}`)
        );
        tempFiles.length = 0;
      } else {
        // Merge all temporary PDFs
        await this.mergePDFsViaConvertApi(filename, tempFiles);
        this.analytics.increaseCounter('pdf', 'merged', 1);
        this.logger.log(
          color.blue.bold(`Merged PDF saved: ${color.white.bold(filename)}`)
        );
      }

      // Post-processing
      if (!isDigitalTemplate) {
        if (payment.vibe) {
          await this.resizePDFPages(finalPath, 62, 62);
        } else {
          await this.resizePDFPages(finalPath, 60, 60);
          await this.addBleed(finalPath, 3);
        }
      } else if (template === 'printer_sheets') {
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
                color.blue.bold(`Deleted temporary file: ${color.white.bold(path.basename(tempFile))}`)
              );
            } catch (error) {
              this.logger.log(
                color.yellow.bold(`Failed to delete temporary file: ${color.white.bold(path.basename(tempFile))}`)
              );
            }
          })
        );
      }
    }

    return filename;
  }

  /**
   * Generate PDF using Lambda (parallel chunks, faster)
   */
  private async generatePDFViaLambda(
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
      template === 'digital_us' ||
      template === 'digital_double_us' ||
      template === 'printer_sheets';

    // Calculate chunking parameters
    const itemsPerPage = isDigitalTemplate ? 6 : 1;
    const pagesPerTrack = isDigitalTemplate ? 1 : 2;
    const totalPages = Math.ceil(numberOfTracks / itemsPerPage) * pagesPerTrack;
    const maxPagesPerPDF = 100; // 50 tracks for printer templates (same as convertAPI)

    let ecoInt = eco ? 1 : 0;
    let emptyPages = 0;

    this.logger.log(
      color.blue.bold('Generating PDF: ') + color.white.bold(template) +
      color.blue.bold(` (${white.bold(numberOfTracks.toString())} tracks, ${white.bold(totalPages.toString())} pages)`)
    );

    const finalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
    const itemIndexParam = itemIndex !== undefined ? itemIndex : 0;

    // Build Lambda options
    const options: LambdaPdfOptions['options'] = {
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
    };

    // Determine page size for digital templates (US Letter for _us templates, A4 otherwise)
    const isUsTemplate = template.endsWith('_us');

    if (isDigitalTemplate) {
      options.format = isUsTemplate ? 'letter' : 'a4';
    } else {
      // Printer templates (including custom ones) use 60x60mm pages
      options.width = 60;
      options.height = 60;
    }

    // Generate PDF in chunks if needed
    const tempS3Keys: string[] = [];

    try {
      // Build all chunk requests
      const chunkRequests: { startIndex: number; endIndex: number; chunkNumber: number }[] = [];
      const totalChunks = Math.ceil(totalPages / maxPagesPerPDF);

      for (let i = 0; i < totalPages; i += maxPagesPerPDF) {
        const startIndex = (i * itemsPerPage) / pagesPerTrack;
        const endIndex = Math.min(
          ((i + maxPagesPerPDF) * itemsPerPage) / pagesPerTrack,
          numberOfTracks
        ) - 1;
        const chunkNumber = Math.floor(i / maxPagesPerPDF) + 1;
        chunkRequests.push({ startIndex, endIndex, chunkNumber });
      }

      if (chunkRequests.length > 1) {
        // Multiple chunks: warm up with first chunk, then do rest in parallel
        const firstChunk = chunkRequests[0];
        const remainingChunks = chunkRequests.slice(1);

        // First chunk - warm up Lambda
        const firstUrl = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${firstChunk.startIndex}/${firstChunk.endIndex}/${subdir}/${ecoInt}/${emptyPages}/${itemIndexParam}`;
        const firstResult = await this.convertHtmlToPdfToS3(firstUrl, options, `Chunk ${white.bold('1')} / ${white.bold(totalChunks.toString())} (warming up)`);
        tempS3Keys.push(firstResult.s3Key);
        this.analytics.increaseCounter('pdf', 'generated', 1);

        // Remaining chunks - in parallel
        this.logger.log(
          color.blue.bold(`Generating ${white.bold(remainingChunks.length.toString())} remaining chunks in parallel...`)
        );

        const parallelResults = await Promise.all(
          remainingChunks.map(async (chunk, index) => {
            const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${chunk.startIndex}/${chunk.endIndex}/${subdir}/${ecoInt}/${emptyPages}/${itemIndexParam}`;
            const result = await this.convertHtmlToPdfToS3(url, options, `Chunk ${white.bold(chunk.chunkNumber.toString())} / ${white.bold(totalChunks.toString())}`);
            this.analytics.increaseCounter('pdf', 'generated', 1);
            return { index, result };
          })
        );

        // Sort by index and add results in correct order
        parallelResults.sort((a, b) => a.index - b.index);
        for (const { result } of parallelResults) {
          tempS3Keys.push(result.s3Key);
        }
      } else {
        // Single chunk - just generate it
        const chunk = chunkRequests[0];
        const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${chunk.startIndex}/${chunk.endIndex}/${subdir}/${ecoInt}/${emptyPages}/${itemIndexParam}`;
        const s3Result = await this.convertHtmlToPdfToS3(url, options, `Chunk ${white.bold('1')} / ${white.bold('1')}`);
        tempS3Keys.push(s3Result.s3Key);
        this.analytics.increaseCounter('pdf', 'generated', 1);
      }

      let pdfBuffer: Buffer;

      if (tempS3Keys.length === 1) {
        // Single chunk - download directly
        this.logger.log(
          color.blue.bold(`Single chunk, downloading from S3...`)
        );
        pdfBuffer = await this.downloadFromS3(tempS3Keys[0]);
        await this.deleteFromS3(tempS3Keys[0]);
      } else {
        // Multiple chunks - merge via Lambda
        this.logger.log(
          color.blue.bold(`Merging ${white.bold(tempS3Keys.length.toString())} chunks...`)
        );
        pdfBuffer = await this.mergePdfsViaLambda(tempS3Keys);
        this.analytics.increaseCounter('pdf', 'merged', 1);
      }

      await fs.writeFile(finalPath, pdfBuffer);

      this.logger.log(
        color.blue.bold(`Generated PDF: ${color.white.bold(filename)}`)
      );
    } catch (error) {
      // Cleanup any generated chunks on error
      this.logger.log(
        color.red.bold(`Error generating PDF, cleaning up ${tempS3Keys.length} chunks...`)
      );
      await this.cleanupS3Keys(tempS3Keys);
      throw error;
    }

    // Post-processing
    if (!isDigitalTemplate) {
      if (payment.vibe) {
        await this.resizePDFPages(finalPath, 62, 62);
      } else {
        await this.resizePDFPages(finalPath, 60, 60);
        await this.addBleed(finalPath, 3);
      }
    } else if (template === 'printer_sheets') {
      await this.resizePDFPages(finalPath, 210, 297);
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

    const finalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;

    // Build Lambda options
    const options: LambdaPdfOptions['options'] = {
      format: 'a4',
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      pageRanges: '1',
    };

    if (template === 'printer') {
      options.format = 'a5';
      options.pageRanges = '1-2';
    }

    // Convert HTML to PDF using Lambda
    const pdfBuffer = await this.convertHtmlToPdf(url, options);
    await fs.writeFile(finalPath, pdfBuffer);

    this.analytics.increaseCounter('pdf', 'generated', 1);

    this.logger.log(
      color.blue.bold(`Generated PDF: ${color.white.bold(filename)}`)
    );

    if (template === 'printer') {
      // Resize to A5 dimensions
      await this.resizePDFPages(finalPath, 210, 148);
      // Add a 3 mm bleed for PrintAPI
      await this.addBleed(finalPath, 3);
    }

    return filename;
  }

  private async mmToPoints(mm: number): Promise<number> {
    return mm * (72 / 25.4);
  }

  /**
   * Add bleed by scaling content to extend into bleed area
   */
  public async addBleed(inputPath: string, bleed: number) {
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
        )} mm bleed to PDF file (content extended): ${color.white.bold(
          inputPath
        )}`
      )
    );
  }

  /**
   * Generate a PDF from a URL and save to file (for invoices, quotations, etc.)
   */
  public async generateFromUrl(
    url: string,
    outputPath: string,
    options: {
      format?: string;
      width?: number;
      height?: number;
      marginTop?: number;
      marginRight?: number;
      marginBottom?: number;
      marginLeft?: number;
      pageRanges?: string;
    } = {}
  ): Promise<void> {
    const lambdaOptions: LambdaPdfOptions['options'] = {
      format: options.format || 'a4',
      marginTop: options.marginTop ?? 0,
      marginRight: options.marginRight ?? 0,
      marginBottom: options.marginBottom ?? 0,
      marginLeft: options.marginLeft ?? 0,
    };

    if (options.width && options.height) {
      lambdaOptions.width = options.width;
      lambdaOptions.height = options.height;
      delete lambdaOptions.format;
    }

    if (options.pageRanges) {
      lambdaOptions.pageRanges = options.pageRanges;
    }

    const pdfBuffer = await this.convertHtmlToPdf(url, lambdaOptions);
    await fs.writeFile(outputPath, pdfBuffer);

    this.logger.log(
      color.blue.bold(`Generated PDF from URL: ${color.white.bold(outputPath)}`)
    );
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
}

export default PDF;
