import fs from 'fs/promises';
import path from 'path';
import Log from './logger';
import Utils from './utils';
import { color, white } from 'console-log-colors';

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
      await this.utils.createDir(backgroundDir);
      this.logger.log(
        color.blue.bold(
          `Background directory initialized at: ${white.bold(backgroundDir)}`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error initializing background directory: ${white.bold(error)}`
        )
      );
    }
  }

  /**
   * Uploads a background image from a base64 string
   * @param base64Image The base64 encoded image string
   * @param filename Optional filename, if not provided a timestamp will be used
   * @returns Object with success status and file path
   */
  public async uploadBackgroundImage(
    base64Image: string,
    filename?: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      // Validate the base64 string
      if (!base64Image || !base64Image.includes('base64,')) {
        return { success: false, error: 'Invalid image format' };
      }

      // Extract the actual base64 data and determine the file type
      const matches = base64Image.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return { success: false, error: 'Invalid image data format' };
      }

      const imageType = matches[1];
      const base64Data = matches[2];
      const buffer = Buffer.from(base64Data, 'base64');

      // Generate filename if not provided
      const actualFilename = filename || `background_${Date.now()}.${imageType}`;
      const filePath = path.join(
        process.env['PUBLIC_DIR'] as string,
        'background',
        actualFilename
      );

      // Write the file
      await fs.writeFile(filePath, buffer);

      this.logger.log(
        color.green.bold(
          `Background image uploaded successfully: ${white.bold(filePath)}`
        )
      );

      return { success: true, filePath };
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error uploading background image: ${white.bold(error)}`
        )
      );
      return { success: false, error: String(error) };
    }
  }
}

export default Designer;
