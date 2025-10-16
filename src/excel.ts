import { color } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Spotify from './spotify';
import Mollie from './mollie';
import Discount from './discount';
import * as ExcelJS from 'exceljs';

class Excel {
  private static instance: Excel;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): Excel {
    if (!Excel.instance) {
      Excel.instance = new Excel();
    }
    return Excel.instance;
  }

  /**
   * Queue Excel processing job via BullMQ
   * @param parts Fastify multipart parts iterator
   * @param clientIp Client IP address
   * @returns Job ID for polling
   */
  public async queueExcelProcessing(
    parts: any,
    clientIp: string
  ): Promise<{ jobId: string; filename: string }> {
    let fileBuffer: Buffer | null = null;
    let originalFilename = 'unknown.xlsx';
    let hasHeader = true;
    let spotifyColumn = 1;
    let outputColumn = 2;
    let playlistName: string | undefined;
    let yearColumn: number | undefined;

    // Parse multipart form data
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
        originalFilename = (part as any).filename || 'unknown.xlsx';
      } else {
        const fieldValue = (part as any).value;
        if (part.fieldname === 'hasHeader') {
          hasHeader = fieldValue === 'true';
        } else if (part.fieldname === 'spotifyColumn') {
          spotifyColumn = parseInt(fieldValue);
        } else if (part.fieldname === 'outputColumn') {
          outputColumn = parseInt(fieldValue);
        } else if (part.fieldname === 'playlistName') {
          playlistName = fieldValue?.trim() || undefined;
        } else if (part.fieldname === 'yearColumn') {
          const parsedYear = parseInt(fieldValue);
          yearColumn = !isNaN(parsedYear) && parsedYear > 0 ? parsedYear : undefined;
        }
      }
    }

    if (!fileBuffer) {
      throw new Error('No file uploaded');
    }

    // Queue the job
    const ExcelQueue = (await import('./excelQueue')).default;
    const excelQueue = ExcelQueue.getInstance();

    const jobId = await excelQueue.queueExcelJob({
      fileBuffer,
      originalFilename,
      hasHeader,
      spotifyColumn,
      outputColumn,
      playlistName,
      yearColumn,
      clientIp,
    });

    return { jobId, filename: originalFilename };
  }

  /**
   * Process multipart upload and supplement Excel file (synchronous version)
   * @param parts Fastify multipart parts iterator
   * @param clientIp Client IP address
   * @returns Modified Excel file buffer
   */
  public async processMultipartUpload(
    parts: any,
    clientIp: string
  ): Promise<Buffer> {
    let fileBuffer: Buffer | null = null;
    let hasHeader = true;
    let spotifyColumn = 1;
    let outputColumn = 2;
    let playlistName: string | undefined;
    let yearColumn: number | undefined;

    // Parse multipart form data
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
      } else {
        const fieldValue = (part as any).value;
        if (part.fieldname === 'hasHeader') {
          hasHeader = fieldValue === 'true';
        } else if (part.fieldname === 'spotifyColumn') {
          spotifyColumn = parseInt(fieldValue);
        } else if (part.fieldname === 'outputColumn') {
          outputColumn = parseInt(fieldValue);
        } else if (part.fieldname === 'playlistName') {
          playlistName = fieldValue?.trim() || undefined;
        } else if (part.fieldname === 'yearColumn') {
          const parsedYear = parseInt(fieldValue);
          yearColumn = !isNaN(parsedYear) && parsedYear > 0 ? parsedYear : undefined;
        }
      }
    }

    if (!fileBuffer) {
      throw new Error('No file uploaded');
    }

    // Process the Excel file
    return await this.supplementExcelWithQRLinks(
      fileBuffer,
      hasHeader,
      spotifyColumn,
      outputColumn,
      clientIp,
      playlistName,
      yearColumn
    );
  }

  /**
   * Supplement Excel file with QRSong links
   * @param buffer Excel file buffer
   * @param hasHeader Whether the Excel file has a header row
   * @param spotifyColumn Column number containing Spotify links (1-indexed)
   * @param outputColumn Column number where QRSong links will be written (1-indexed)
   * @param clientIp Client IP address for the request
   * @param playlistName Optional name for the Spotify playlist
   * @param yearColumn Optional column number containing release year (1-indexed)
   * @returns Modified Excel file buffer
   */
  public async supplementExcelWithQRLinks(
    buffer: Buffer,
    hasHeader: boolean,
    spotifyColumn: number,
    outputColumn: number,
    clientIp: string,
    playlistName?: string,
    yearColumn?: number
  ): Promise<Buffer> {
    try {
      this.logger.log(
        color.blue.bold(
          `Supplementing Excel file with QRSong links (spotifyColumn=${color.white.bold(
            spotifyColumn
          )}, outputColumn=${color.white.bold(
            outputColumn
          )}, hasHeader=${color.white.bold(hasHeader)})`
        )
      );

      // Load the workbook
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as any);
      const worksheet = workbook.worksheets[0];

      if (!worksheet) {
        throw new Error('No worksheet found in Excel file');
      }

      const spotify = Spotify.getInstance();
      const startRow = hasHeader ? 2 : 1;
      const lastRow = worksheet.lastRow?.number || 0;

      // ========== PHASE 1: Extract all Spotify track IDs ==========
      this.logger.log(
        color.blue.bold(`Phase ${color.white.bold('1')}: Extracting Spotify track IDs from Excel`)
      );

      const trackIds: string[] = [];
      const rowToTrackIdMap: Map<number, string> = new Map();
      const trackIdToOrderMap: Map<string, number> = new Map();

      for (let rowNumber = startRow; rowNumber <= lastRow; rowNumber++) {
        const row = worksheet.getRow(rowNumber);
        const spotifyCell = row.getCell(spotifyColumn);

        // Extract cell value properly
        let spotifyUrl = '';
        if (spotifyCell.value) {
          if (typeof spotifyCell.value === 'string') {
            spotifyUrl = spotifyCell.value.trim();
          } else if (
            typeof spotifyCell.value === 'object' &&
            (spotifyCell.value as any).hyperlink
          ) {
            spotifyUrl = (spotifyCell.value as any).hyperlink.trim();
          } else if (
            typeof spotifyCell.value === 'object' &&
            (spotifyCell.value as any).text
          ) {
            const textValue = (spotifyCell.value as any).text;
            if (typeof textValue === 'string') {
              spotifyUrl = textValue.trim();
            } else if (
              textValue.richText &&
              Array.isArray(textValue.richText)
            ) {
              spotifyUrl = textValue.richText
                .map((rt: any) => rt.text || '')
                .join('')
                .trim();
            }
          } else {
            spotifyUrl = String(spotifyCell.value).trim();
          }
        }

        if (!spotifyUrl) {
          this.logger.log(
            color.yellow.bold(
              `Row ${color.white.bold(rowNumber)}: No Spotify URL found, will skip`
            )
          );
          continue;
        }

        // Extract Spotify track ID from URL
        const trackIdMatch = spotifyUrl.match(/track\/([a-zA-Z0-9]+)/);
        if (!trackIdMatch) {
          this.logger.log(
            color.yellow.bold(
              `Row ${color.white.bold(
                rowNumber
              )}: Invalid Spotify URL format: ${color.white.bold(spotifyUrl)}`
            )
          );
          row.getCell(outputColumn).value = 'Error: Invalid Spotify URL';
          continue;
        }

        const spotifyTrackId = trackIdMatch[1];
        trackIds.push(spotifyTrackId);
        rowToTrackIdMap.set(rowNumber, spotifyTrackId);
        // Store the order (use row number relative to start)
        trackIdToOrderMap.set(spotifyTrackId, rowNumber - startRow + 1);
      }

      if (trackIds.length === 0) {
        throw new Error('No valid Spotify track IDs found in Excel file');
      }

      this.logger.log(
        color.blue.bold(
          `Extracted ${color.white.bold(trackIds.length)} track IDs from Excel`
        )
      );

      // ========== PHASE 2: Create Spotify playlist and process tracks ==========
      this.logger.log(
        color.blue.bold(
          `Phase ${color.white.bold('2')}: Creating Spotify playlist with ${color.white.bold(
            trackIds.length
          )} tracks`
        )
      );

      const finalPlaylistName =
        playlistName || `Excel Import ${new Date().toISOString()}`;

      this.logger.log(
        color.blue.bold(
          `Creating Spotify playlist: ${color.white.bold(finalPlaylistName)}`
        )
      );

      const playlistResult = await spotify.createOrUpdatePlaylist(
        finalPlaylistName,
        trackIds
      );

      if (!playlistResult.success || !playlistResult.data) {
        throw new Error(
          `Failed to create Spotify playlist: ${
            playlistResult.error || 'Unknown error'
          }`
        );
      }

      const createdPlaylistId = playlistResult.data.playlistId;
      this.logger.log(
        color.blue.bold(
          `Created Spotify playlist: ${color.white.bold(
            createdPlaylistId
          )} with ${color.white.bold(trackIds.length)} tracks`
        )
      );

      // Fetch tracks from the created playlist
      this.logger.log(color.blue.bold(`Fetching tracks from created playlist`));
      const tracksResult = await spotify.getTracks(
        createdPlaylistId,
        false,
        '',
        false
      );

      if (!tracksResult.success || !tracksResult.data?.tracks) {
        throw new Error(
          `Failed to fetch tracks from playlist: ${
            tracksResult.error || 'Unknown error'
          }`
        );
      }

      const fetchedTracks = tracksResult.data.tracks;
      this.logger.log(
        color.blue.bold(
          `Fetched ${color.white.bold(
            fetchedTracks.length
          )} tracks from playlist`
        )
      );

      // ========== PHASE 3: Create Payment and Playlist Records ==========
      this.logger.log(
        color.blue.bold(
          `Phase ${color.white.bold('3')}: Creating payment and playlist records for Excel import`
        )
      );

      // Create a discount code for the full amount (Excel imports are free)
      const discount = new Discount();
      const price = 100; // Set a nominal price that will be fully discounted
      const discountCode = await discount.createDiscountCode(price, '', '');

      const items = [
        {
          productType: 'cards',
          playlistId: createdPlaylistId,
          playlistName: finalPlaylistName,
          numberOfTracks: fetchedTracks.length,
          hideCircle: false,
          qrColor: '#000000',
          amount: 1,
          price: price,
          type: 'digital',
          subType: 'none',
          background: null,
          image: '',
          doubleSided: false,
          eco: false,
          isSlug: false,
        },
      ];

      const discounts = [
        { code: discountCode.code, amountLeft: price, fullAmount: price },
      ];

      const paymentParams = {
        user: { userId: null, email: null, displayName: null },
        locale: 'en',
        refreshPlaylists: [],
        onzevibe: false,
        cart: { items, discounts },
        extraOrderData: {
          fullname: 'Excel Import',
          email: 'excel@qrsong.io',
          address: '-',
          housenumber: '-',
          city: '-',
          zipcode: '-',
          countrycode: 'NL',
          price: 0,
          shipping: 0,
          total: 0,
          taxRate: 21,
          taxRateShipping: 21,
          agreeNoRefund: true,
          agreeTerms: true,
          marketingEmails: false,
          differentInvoiceAddress: false,
          invoiceAddress: '',
          invoiceHousenumber: '',
          invoiceCity: '',
          invoiceZipcode: '',
          invoiceCountrycode: '',
          orderType: 'digital',
          vibe: true,
        },
      };

      this.logger.log(
        color.blue.bold(
          `Creating payment record for Excel import: ${color.white.bold(
            finalPlaylistName
          )}`
        )
      );

      const mollie = new Mollie();
      const paymentResult = await mollie.getPaymentUri(
        paymentParams,
        clientIp,
        true, // skipPayment
        true // finalizeNow
      );

      if (!paymentResult.success) {
        throw new Error(
          `Failed to create payment record: ${
            paymentResult.error || 'Unknown error'
          }`
        );
      }

      const userId = paymentResult.data.userId;
      const paymentId = paymentResult.data.paymentId;

      this.logger.log(
        color.blue.bold(
          `Created payment record: ${color.white.bold(
            paymentId
          )} for user ${color.white.bold(userId)}`
        )
      );

      // Get the playlist using the Spotify playlist ID
      const tempPlaylist = await this.prisma.playlist.findUnique({
        where: { playlistId: createdPlaylistId },
      });

      if (!tempPlaylist) {
        throw new Error(
          `Playlist not found after payment creation: ${createdPlaylistId}`
        );
      }

      this.logger.log(
        color.blue.bold(
          `Processing tracks through storeTracks (will determine years and preserve Excel row order)`
        )
      );

      this.logger.log(
        color.blue.bold(
          `Preserving Excel row order for ${color.white.bold(
            trackIdToOrderMap.size
          )} tracks`
        )
      );

      // Import Data dynamically to avoid circular dependency
      const Data = (await import('./data')).default;
      const data = Data.getInstance();
      await data.storeTracks(
        tempPlaylist.id,
        createdPlaylistId,
        fetchedTracks,
        trackIdToOrderMap
      );

      this.logger.log(
        color.blue.bold(`Tracks processed and stored in database`)
      );

      // ========== PHASE 4: Query payment_has_playlist record ==========
      this.logger.log(
        color.blue.bold(`Phase ${color.white.bold('4')}: Querying payment_has_playlist record`)
      );

      // Find payment_has_playlist record for this playlist
      const paymentHasPlaylists = await this.prisma.$queryRaw<
        Array<{ id: number }>
      >`
        SELECT php.id
        FROM payment_has_playlist php
        INNER JOIN playlists pl ON php.playlistId = pl.id
        WHERE pl.id = ${tempPlaylist.id}
        LIMIT 1
      `;

      if (!paymentHasPlaylists || paymentHasPlaylists.length === 0) {
        throw new Error(
          'No payment_has_playlist found for the created playlist'
        );
      }

      const phpId = paymentHasPlaylists[0].id;
      this.logger.log(
        color.blue.bold(
          `Found payment_has_playlist record: ${color.white.bold(phpId)}`
        )
      );

      // ========== PHASE 5: Update release years from Excel column (if provided) ==========
      if (yearColumn) {
        this.logger.log(
          color.blue.bold(
            `Phase ${color.white.bold('5')}: Updating release years from Excel column ${color.white.bold(
              yearColumn
            )}`
          )
        );

        let yearsUpdated = 0;
        let yearsSkipped = 0;
        let yearsInvalid = 0;

        for (const [rowNumber, trackId] of Array.from(
          rowToTrackIdMap.entries()
        )) {
          const row = worksheet.getRow(rowNumber);
          const yearCell = row.getCell(yearColumn);

          // Extract year value from cell
          let yearValue: number | null = null;
          if (yearCell.value) {
            if (typeof yearCell.value === 'number') {
              yearValue = yearCell.value;
            } else if (typeof yearCell.value === 'string') {
              const parsedYear = parseInt(yearCell.value.trim());
              if (!isNaN(parsedYear)) {
                yearValue = parsedYear;
              }
            }
          }

          if (!yearValue) {
            this.logger.log(
              color.yellow.bold(
                `Row ${color.white.bold(
                  rowNumber
                )}: No year value found in column ${color.white.bold(
                  yearColumn
                )}, skipping`
              )
            );
            yearsSkipped++;
            continue;
          }

          // Validate year is >= 1000
          if (yearValue < 1000) {
            this.logger.log(
              color.yellow.bold(
                `Row ${color.white.bold(
                  rowNumber
                )}: Invalid year ${color.white.bold(
                  yearValue
                )} (must be >= 1000), skipping`
              )
            );
            yearsInvalid++;
            continue;
          }

          // Update the track's year in the database
          const track = await this.prisma.track.findUnique({
            where: { trackId },
            select: { id: true, name: true, artist: true },
          });

          if (!track) {
            this.logger.log(
              color.yellow.bold(
                `Row ${color.white.bold(
                  rowNumber
                )}: Track not found for ID ${color.white.bold(trackId)}, skipping`
              )
            );
            yearsSkipped++;
            continue;
          }

          await this.prisma.track.update({
            where: { trackId },
            data: {
              year: yearValue,
              manuallyChecked: true,
              manuallyCorrected: true
            },
          });

          this.logger.log(
            color.blue.bold(
              `Row ${color.white.bold(rowNumber)}: Updated year to ${color.white.bold(
                yearValue
              )} for ${color.white.bold(track.artist)} - ${color.white.bold(
                track.name
              )}`
            )
          );
          yearsUpdated++;
        }

        this.logger.log(
          color.green.bold(
            `Phase ${color.white.bold('5')} complete: ${color.white.bold(
              yearsUpdated
            )} years updated, ${color.white.bold(
              yearsSkipped
            )} skipped, ${color.white.bold(yearsInvalid)} invalid`
          )
        );
      } else {
        this.logger.log(
          color.blue.bold(
            `Phase ${color.white.bold('5')}: Skipping year update (no yearColumn provided)`
          )
        );
      }

      // ========== PHASE 6: Write QRSong links back to Excel ==========
      this.logger.log(
        color.blue.bold(`Phase ${color.white.bold('6')}: Writing QRSong links back to Excel`)
      );

      let processedCount = 0;
      let errorCount = 0;

      for (const [rowNumber, trackId] of Array.from(
        rowToTrackIdMap.entries()
      )) {
        const row = worksheet.getRow(rowNumber);

        // Get track details for logging and to get the database ID
        const track = await this.prisma.track.findUnique({
          where: { trackId },
          select: { id: true, name: true, artist: true },
        });

        if (!track) {
          this.logger.log(
            color.yellow.bold(
              `Row ${color.white.bold(rowNumber)}: Track ${color.white.bold(
                trackId
              )} not found in database`
            )
          );
          row.getCell(outputColumn).value = 'Error: Track not found';
          errorCount++;
          continue;
        }

        // Generate QRSong link using the single phpId for all tracks
        const qrsongLink = `${process.env['API_URI']}/qr2/${track.id}/${phpId}`;
        row.getCell(outputColumn).value = qrsongLink;
        processedCount++;

        this.logger.log(
          color.blue.bold(
            `Row ${color.white.bold(rowNumber)}: Generated QRSong link for ${color.white.bold(
              track.artist
            )} - ${color.white.bold(track.name)}`
          )
        );
      }

      // ========== CLEANUP: Delete Spotify playlist only, keep local DB records ==========
      this.logger.log(
        color.blue.bold(`Cleaning up: Deleting Spotify playlist from user's account`)
      );

      const deleteResult = await spotify.deletePlaylist(createdPlaylistId);
      if (!deleteResult.success) {
        this.logger.log(
          color.yellow.bold(
            `Warning: Could not delete Spotify playlist ${color.white.bold(
              createdPlaylistId
            )}: ${deleteResult.error || 'Unknown error'}`
          )
        );
      } else {
        this.logger.log(
          color.blue.bold(
            `Successfully deleted Spotify playlist ${color.white.bold(
              createdPlaylistId
            )} from user's account`
          )
        );
      }

      this.logger.log(
        color.blue.bold(
          `Keeping local database records (playlist, tracks, payment_has_playlist) - they are needed for the QRSong links`
        )
      );

      this.logger.log(
        color.green.bold(
          `Phase ${color.white.bold('6')} complete: ${color.white.bold(
            processedCount
          )} QRSong links written, ${color.white.bold(errorCount)} errors`
        )
      );

      this.logger.log(
        color.green.bold(
          `Excel supplementation complete: All phases finished successfully`
        )
      );

      // Generate buffer
      const resultBuffer = await workbook.xlsx.writeBuffer();
      return Buffer.from(resultBuffer);
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error supplementing Excel file: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      throw error;
    }
  }
}

export default Excel;
