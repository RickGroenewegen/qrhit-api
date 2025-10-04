import fs from 'fs/promises';
import path from 'path';
import Log from './logger';
import Utils from './utils';
import { color, white } from 'console-log-colors';
import sharp from 'sharp';
import PrismaInstance from './prisma';

class Designer {
  private static instance: Designer;
  private logger = new Log();
  private utils = new Utils();
  private prisma = PrismaInstance.getInstance();

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
   * @param qrBackgroundType Type of QR background: 'none', 'circle', 'square' (default: 'square')
   * @returns Object with success status, filename and file path
   */
  public async uploadBackgroundImage(
    base64Image: string,
    filename?: string,
    qrBackgroundType: 'none' | 'circle' | 'square' = 'square'
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
        // Resize to 1000x1000, optionally add white circle, and convert to PNG with compression
        let sharpInstance = sharp(buffer).resize(1000, 1000, { fit: 'cover' });

        // Build composite layers
        const compositeOptions: any[] = [
          {
            input: {
              create: {
                width: 1000,
                height: 1000,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
              },
            },
            blend: 'dest-over',
          },
        ];

        // No longer draw shapes on the background image
        // All QR background shapes (circle, square) are now handled in the EJS templates
        // This keeps the background clean and allows for better PDF generation

        const processedBuffer = await sharpInstance
          .composite(compositeOptions)
          .png({ compressionLevel: 9, quality: 90 }) // Convert to PNG with high compression
          .toBuffer();

        // Write the processed file
        await fs.writeFile(filePath, processedBuffer);

        this.logger.log(
          color.green.bold(
            `Background image processed and uploaded successfully: ${white.bold(
              filePath
            )}`
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
   * Uploads a background image for the back side from a base64 string
   * @param base64Image The base64 encoded image string
   * @param filename Optional filename, if not provided a nanoid will be used
   * @param qrBackgroundType Type of QR background: 'none', 'circle', 'square' (default: 'square')
   * @returns Object with success status, filename and file path
   */
  public async uploadBackgroundBackImage(
    base64Image: string,
    filename?: string,
    qrBackgroundType: 'none' | 'circle' | 'square' = 'square'
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
        // Resize to 1000x1000 and convert to PNG with compression
        let sharpInstance = sharp(buffer).resize(1000, 1000, { fit: 'cover' });

        // Build composite layers
        const compositeOptions: any[] = [
          {
            input: {
              create: {
                width: 1000,
                height: 1000,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
              },
            },
            blend: 'dest-over',
          },
        ];

        const processedBuffer = await sharpInstance
          .composite(compositeOptions)
          .png({ compressionLevel: 9, quality: 90 }) // Convert to PNG with high compression
          .toBuffer();

        // Write the processed file
        await fs.writeFile(filePath, processedBuffer);

        this.logger.log(
          color.green.bold(
            `Background back image processed and uploaded successfully: ${white.bold(
              filePath
            )}`
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
        color.red.bold(`Error uploading background back image: ${white.bold(error)}`)
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

  /**
   * Get card design for a payment/playlist combination
   * Validates ownership through paymentId and userHash
   */
  public async getCardDesign(
    paymentId: string,
    userHash: string,
    playlistId: string
  ): Promise<any> {
    try {
      // Get card design data from PaymentHasPlaylist (ALL design fields)
      const cardDesign = await this.prisma.$queryRaw<any[]>`
        SELECT
          php.background,
          php.logo,
          php.emoji,
          php.hideDomain,
          php.hideCircle,
          php.qrBackgroundType,
          php.qrColor,
          php.qrBackgroundColor,
          php.selectedFont,
          php.selectedFontSize,
          php.doubleSided,
          php.eco,
          php.type,
          php.backgroundFrontType,
          php.backgroundFrontColor,
          php.useFrontGradient,
          php.gradientFrontColor,
          php.gradientFrontDegrees,
          php.gradientFrontPosition,
          php.backgroundBack,
          php.backgroundBackType,
          php.backgroundBackColor,
          php.fontColor,
          php.useGradient,
          php.gradientBackgroundColor,
          php.gradientDegrees,
          php.gradientPosition,
          pl.name as playlistName,
          pl.numberOfTracks,
          pl.playlistId
        FROM payments p
        JOIN users u ON p.userId = u.id
        JOIN payment_has_playlist php ON php.paymentId = p.id
        JOIN playlists pl ON pl.id = php.playlistId
        WHERE p.paymentId = ${paymentId}
        AND u.hash = ${userHash}
        AND pl.playlistId = ${playlistId}
        LIMIT 1
      `;

      if (cardDesign.length > 0) {
        // Get first track ID for QR code preview
        const firstTrack = await this.prisma.$queryRaw<any[]>`
          SELECT t.trackId
          FROM payments p
          JOIN users u ON p.userId = u.id
          JOIN payment_has_playlist php ON php.paymentId = p.id
          JOIN playlists pl ON pl.id = php.playlistId
          JOIN playlist_has_tracks pht ON pht.playlistId = pl.id
          JOIN tracks t ON t.id = pht.trackId
          WHERE p.paymentId = ${paymentId}
          AND u.hash = ${userHash}
          AND pl.playlistId = ${playlistId}
          ORDER BY t.name ASC
          LIMIT 1
        `;

        return {
          success: true,
          data: {
            ...cardDesign[0],
            firstTrackId: firstTrack.length > 0 ? firstTrack[0].trackId : null,
          },
        };
      }

      return { success: false, error: 'Card design not found' };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error getting card design: ${white.bold(error)}`)
      );
      return { success: false, error: String(error) };
    }
  }

  /**
   * Update card design for a payment/playlist combination
   * Validates ownership through paymentId and userHash
   */
  public async updateCardDesign(
    paymentId: string,
    userHash: string,
    playlistId: string,
    design: {
      background?: string;
      logo?: string;
      emoji?: string;
      hideDomain?: boolean;
      hideCircle?: boolean;
      qrBackgroundType?: 'none' | 'circle' | 'square';
      qrColor?: string;
      qrBackgroundColor?: string;
      selectedFont?: string;
      selectedFontSize?: string;
      doubleSided?: boolean;
      eco?: boolean;
      backgroundFrontType?: 'solid' | 'image';
      backgroundFrontColor?: string;
      useFrontGradient?: boolean;
      gradientFrontColor?: string;
      gradientFrontDegrees?: number;
      gradientFrontPosition?: number;
      backgroundBack?: string;
      backgroundBackType?: 'solid' | 'image';
      backgroundBackColor?: string;
      fontColor?: string;
      useGradient?: boolean;
      gradientBackgroundColor?: string;
      gradientDegrees?: number;
      gradientPosition?: number;
    }
  ): Promise<boolean> {
    try {
      // Verify ownership by checking payment and user hash
      const payment = await this.prisma.$queryRaw<any[]>`
        SELECT p.id, p.status
        FROM payments p
        JOIN users u ON p.userId = u.id
        WHERE p.paymentId = ${paymentId}
        AND u.hash = ${userHash}
        AND p.status = 'paid'
        LIMIT 1
      `;

      if (payment.length === 0) {
        this.logger.log(
          color.red.bold(`Unauthorized access attempt for payment ${paymentId}`)
        );
        return false;
      }

      const paymentDbId = payment[0].id;

      // Get the playlist database ID
      const playlist = await this.prisma.playlist.findFirst({
        where: {
          playlistId: playlistId,
        },
        select: {
          id: true,
        },
      });

      if (!playlist) {
        this.logger.log(color.red.bold(`Playlist not found: ${playlistId}`));
        return false;
      }

      // Update the PaymentHasPlaylist record with the new design
      await this.prisma.paymentHasPlaylist.update({
        where: {
          paymentId_playlistId: {
            paymentId: paymentDbId,
            playlistId: playlist.id,
          },
        },
        data: {
          background: design.background,
          logo: design.logo,
          emoji: design.emoji,
          hideDomain: this.utils.parseBoolean(design.hideDomain),
          hideCircle: design.hideCircle,
          qrBackgroundType: design.qrBackgroundType,
          qrColor: design.qrColor,
          qrBackgroundColor: design.qrBackgroundColor,
          selectedFont: design.selectedFont,
          selectedFontSize: design.selectedFontSize,
          doubleSided: design.doubleSided,
          eco: design.eco,
          backgroundFrontType: design.backgroundFrontType,
          backgroundFrontColor: design.backgroundFrontColor,
          useFrontGradient: this.utils.parseBoolean(design.useFrontGradient),
          gradientFrontColor: design.gradientFrontColor,
          gradientFrontDegrees: design.gradientFrontDegrees,
          gradientFrontPosition: design.gradientFrontPosition,
          backgroundBack: design.backgroundBack,
          backgroundBackType: design.backgroundBackType,
          backgroundBackColor: design.backgroundBackColor,
          fontColor: design.fontColor,
          useGradient: this.utils.parseBoolean(design.useGradient),
          gradientBackgroundColor: design.gradientBackgroundColor,
          gradientDegrees: design.gradientDegrees,
          gradientPosition: design.gradientPosition,
        },
      });

      this.logger.log(
        color.green.bold(
          `Card design updated for payment ${color.white.bold(
            paymentId
          )} and playlist ${color.white.bold(playlistId)}`
        )
      );

      return true;
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error updating card design: ${white.bold(error)}`)
      );
      return false;
    }
  }
}

export default Designer;
