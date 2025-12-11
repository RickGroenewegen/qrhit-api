import { color, white } from 'console-log-colors';
import Logger from './logger';
import { Playlist } from '@prisma/client';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import AnalyticsClient from './analytics';
import { promises as fs } from 'fs';
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
  private lambdaFunctionName = process.env['PDF_LAMBDA_FUNCTION'] || 'convertHTMLToPDF';
  private analytics = AnalyticsClient.getInstance();

  /**
   * Invoke the Lambda function to convert HTML to PDF
   */
  private async convertHtmlToPdf(
    url: string,
    options: LambdaPdfOptions['options']
  ): Promise<Buffer> {
    this.logger.log(
      color.blue.bold(`Invoking Lambda for URL: ${color.white.bold(url)}`)
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
      throw new Error(`PDF generation failed: ${errorBody?.message || 'Unknown error'}`);
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

    let ecoInt = eco ? 1 : 0;
    let emptyPages = 0;

    this.logger.log(
      color.blue.bold('Generating PDF: ') + color.white.bold(template)
    );

    // Build the URL for the entire PDF (no more pagination needed)
    const itemIndexParam = itemIndex !== undefined ? itemIndex : 0;
    const startIndex = 0;
    const endIndex = numberOfTracks - 1;
    const url = `${process.env['API_URI']}/qr/pdf/${playlist.playlistId}/${payment.paymentId}/${template}/${startIndex}/${endIndex}/${subdir}/${ecoInt}/${emptyPages}/${itemIndexParam}`;

    this.logger.log(
      color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
    );

    const finalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;

    // Build Lambda options
    const options: LambdaPdfOptions['options'] = {
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
    };

    if (isDigitalTemplate) {
      options.format = 'a4';
    } else {
      // Printer templates (including custom ones) use 60x60mm pages
      options.width = 60;
      options.height = 60;
    }

    // Convert HTML to PDF using Lambda
    const pdfBuffer = await this.convertHtmlToPdf(url, options);
    await fs.writeFile(finalPath, pdfBuffer);

    this.analytics.increaseCounter('pdf', 'generated', 1);

    this.logger.log(
      color.blue.bold(`Generated PDF: ${color.white.bold(filename)}`)
    );

    if (!isDigitalTemplate) {
      // Printer templates (including custom ones) need resize and bleed
      if (payment.vibe) {
        // Happibox wants a 3% increase in size for the printer
        await this.resizePDFPages(finalPath, 62, 62);
      } else {
        // Resize them to exactly 60x60 mm
        await this.resizePDFPages(finalPath, 60, 60);
      }

      // Add bleed based on printer type
      if (printerType === 'tromp') {
        // True bleed: scale content to extend into bleed area
        await this.addTrueBleed(finalPath, 3);
      } else {
        // Standard bleed: add whitespace around content
        await this.addBleed(finalPath, 3);
      }
    } else if (template === 'printer_sheets') {
      // Resize to A4
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

    this.logger.log(
      color.blue.bold(`Retrieving PDF from URL: ${color.white.bold(url)}`)
    );

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
