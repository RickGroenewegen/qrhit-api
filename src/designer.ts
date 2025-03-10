import fs from 'fs/promises';
import path from 'path';
import Log from './logger';
import Utils from './utils';
import { color, white } from 'console-log-colors';
import sharp from 'sharp';

class Designer {
  private static instance: Designer;
  private logger = new Log();
  private utils = new Utils();

  private constructor() {
    // Initialize the background directory
    this.initBackgroundDirectory();
  }

  public static getInstance(): Designer {
    if (!Designer.instance) {
      Designer.instance = new Designer();
    }
    return Designer.instance;
  }

  private async initBackgroundDirectory(): Promise<void> {
    try {
      const backgroundDir = `${process.env['PUBLIC_DIR']}/background`;
      const logoDir = `${process.env['PUBLIC_DIR']}/logo`;
      await this.utils.createDir(backgroundDir);
      await this.utils.createDir(logoDir);
      this.logger.log(
        color.blue.bold(
          `Directories initialized at: ${white.bold(
            backgroundDir
          )} and ${white.bold(logoDir)}`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error initializing directories: ${white.bold(error)}`)
      );
    }
  }

  /**
   * Uploads a background image from a base64 string
   * @param base64Image The base64 encoded image string
   * @param filename Optional filename, if not provided a nanoid will be used
   * @returns Object with success status, filename and file path
   */
  public async uploadBackgroundImage(
    base64Image: string,
    filename?: string
  ): Promise<{
    success: boolean;
    filename?: string;
    filePath?: string;
    error?: string;
  }> {
    try {
      // Validate the base64 string
      if (!base64Image) {
        return { success: false, error: 'No image provided' };
      }

      let imageType: string;
      let base64Data: string;

      // Handle both full data URI and raw base64 string
      if (base64Image.includes('base64,')) {
        // Extract the actual base64 data and determine the file type
        const matches = base64Image.match(
          /^data:image\/([a-zA-Z]+);base64,(.+)$/
        );
        if (!matches || matches.length !== 3) {
          return { success: false, error: 'Invalid image data format' };
        }
        imageType = matches[1];
        base64Data = matches[2];
      } else {
        // Assume it's a raw base64 string and try to determine format from content
        // Default to png if we can't determine
        imageType = 'png';
        base64Data = base64Image;
      }

      // Generate unique filename using utils.generateRandomString
      const uniqueId = this.utils.generateRandomString(32); // Generate a 32-character unique ID
      const actualFilename = `${uniqueId}.png`.toLowerCase(); // Always use PNG format

      const filePath = path.join(
        process.env['PUBLIC_DIR'] as string,
        'background',
        actualFilename
      );

      try {
        // Create buffer from base64
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Process the image with sharp
        // Resize to 1000x1000, draw a white circle, add a 32px white border, and convert to PNG with compression
        const processedBuffer = await sharp(buffer)
          .resize(1000, 1000, { fit: 'cover' })
          .composite([{
            input: {
              create: {
                width: 1000,
                height: 1000,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
              }
            },
            blend: 'dest-over'
          }, {
            input: Buffer.from(
              `<svg width="1000" height="1000">
                <circle cx="500" cy="500" r="400" fill="white" stroke="white" stroke-width="10"/>
              </svg>`
            ),
            blend: 'over'
          }])
          .extend({
            top: 32,
            bottom: 32,
            left: 32,
            right: 32,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
          }) // Add 32px white border to make it 1064x1064
          .png({ compressionLevel: 9, quality: 90 }) // Convert to PNG with high compression
          .toBuffer();

        // Write the processed file
        await fs.writeFile(filePath, processedBuffer);

        this.logger.log(
          color.green.bold(
            `Background image processed and uploaded successfully: ${white.bold(filePath)}`
          )
        );

        // Return the relative path that would be accessible from the web
        const relativePath = `/public/background/${actualFilename}`;
        return {
          success: true,
          filename: actualFilename,
        };
      } catch (writeError) {
        this.logger.log(
          color.red.bold(`Error writing image file: ${white.bold(writeError)}`)
        );
        return { success: false, error: `Error writing file: ${writeError}` };
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error uploading background image: ${white.bold(error)}`)
      );
      return { success: false, error: String(error) };
    }
  }

  /**
   * Uploads a logo image from a base64 string
   * @param base64Image The base64 encoded image string
   * @param filename Optional filename, if not provided a random string will be used
   * @returns Object with success status, filename and file path
   */
  public async uploadLogoImage(
    base64Image: string,
    filename?: string
  ): Promise<{
    success: boolean;
    filename?: string;
    filePath?: string;
    error?: string;
  }> {
    try {
      // Validate the base64 string
      if (!base64Image) {
        return { success: false, error: 'No image provided' };
      }

      let imageType: string;
      let base64Data: string;

      // Handle both full data URI and raw base64 string
      if (base64Image.includes('base64,')) {
        // Extract the actual base64 data and determine the file type
        const matches = base64Image.match(
          /^data:image\/([a-zA-Z]+);base64,(.+)$/
        );
        if (!matches || matches.length !== 3) {
          return { success: false, error: 'Invalid image data format' };
        }
        imageType = matches[1];
        base64Data = matches[2];
      } else {
        // Assume it's a raw base64 string and try to determine format from content
        // Default to png if we can't determine
        imageType = 'png';
        base64Data = base64Image;
      }

      // Generate unique filename using utils.generateRandomString
      const uniqueId = this.utils.generateRandomString(32); // Generate a 32-character unique ID
      const actualFilename = `${uniqueId}.${imageType}`.toLowerCase();

      const filePath = path.join(
        process.env['PUBLIC_DIR'] as string,
        'logo',
        actualFilename
      );

      try {
        // Create buffer from base64
        const buffer = Buffer.from(base64Data, 'base64');

        // Write the file
        await fs.writeFile(filePath, buffer);

        this.logger.log(
          color.green.bold(
            `Logo image uploaded successfully: ${white.bold(filePath)}`
          )
        );

        // Return the relative path that would be accessible from the web
        const relativePath = `/public/logo/${actualFilename}`;
        return {
          success: true,
          filename: actualFilename,
          filePath: relativePath,
        };
      } catch (writeError) {
        this.logger.log(
          color.red.bold(`Error writing image file: ${white.bold(writeError)}`)
        );
        return { success: false, error: `Error writing file: ${writeError}` };
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error uploading logo image: ${white.bold(error)}`)
      );
      return { success: false, error: String(error) };
    }
  }
}

export default Designer;
