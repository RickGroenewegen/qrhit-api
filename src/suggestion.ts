import { color } from 'console-log-colors';
import Logger from './logger';
import { Prisma, PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';

import PushoverClient from './pushover';
import Mollie from './mollie';
import Generator from './generator';
import Spotify from './spotify';
import MusicServiceRegistry from './services/MusicServiceRegistry';
import Data from './data';
import Cache from './cache';

class Suggestion {
  private static instance: Suggestion;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private pushover = new PushoverClient();
  private mollie = new Mollie();
  private generator = Generator.getInstance();
  private spotify = new Spotify();
  private musicRegistry = MusicServiceRegistry.getInstance();
  private data = Data.getInstance();
  private cache = Cache.getInstance();

  private constructor() {}

  public async getUserSuggestions(
    paymentId: string,
    userHash: string,
    playlistId: string,
    digital: boolean = true
  ): Promise<any> {
    const payment = await this.prisma.payment.findFirst({
      select: {
        canBeSentToPrinterAt: true,
      },
      where: {
        paymentId,
      },
    });

    const playlist = await this.prisma.playlist.findFirst({
      where: { playlistId },
      select: { serviceType: true },
    });

    const tracks = await this.prisma.$queryRaw<any[]>`
      SELECT
        t.id,
        t.trackId,
        COALESCE(NULLIF(tei.name, ''), t.name) as name,
        COALESCE(NULLIF(tei.artist, ''), t.artist) as artist,
        COALESCE(tei.year, t.year) as year,
        tei.extraArtistAttribute,
        tei.extraNameAttribute,
        us.id as suggestionId,
        us.name as suggestedName,
        us.artist as suggestedArtist,
        us.year as suggestedYear,
        us.extraArtistAttribute as suggestedExtraArtistAttribute,
        us.extraNameAttribute as suggestedExtraNameAttribute,
        us.comment as comment,
        php.eligableForPrinter,
        php.suggestionsPending,
        php.userConfirmedPrinting,
        CASE
          WHEN (SELECT COUNT(*) FROM usersuggestions WHERE trackId = t.id AND userId = u.id) > 0
          THEN 'true'
          ELSE 'false'
        END as hasSuggestion
      FROM payments p
      JOIN users u ON p.userId = u.id
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      JOIN playlist_has_tracks pht ON pht.playlistId = pl.id
      JOIN tracks t ON t.id = pht.trackId
      LEFT JOIN usersuggestions us ON us.trackId = t.id AND us.userId = u.id AND us.playlistId = pl.id
      LEFT JOIN trackextrainfo tei ON tei.trackId = t.id AND tei.playlistId = pl.id
      WHERE p.paymentId = ${paymentId}
      AND u.hash = ${userHash}
      AND pl.playlistId = ${playlistId}
      AND t.manuallyChecked = true
    `;
    return {
      suggestions: tracks,
      metadata: { payment, serviceType: playlist?.serviceType ?? 'spotify' },
    };
  }

  private async verifyPaymentOwnership(
    paymentId: string,
    userHash: string
  ): Promise<{ verified: boolean; paymentDbId?: number }> {
    const payment = await this.prisma.$queryRaw<any[]>`
      SELECT p.id, p.status
      FROM payments p
      JOIN users u ON p.userId = u.id
      WHERE p.paymentId = ${paymentId}
      AND u.hash = ${userHash}
      AND p.status = 'paid'
      LIMIT 1
    `;

    return {
      verified: payment.length > 0,
      paymentDbId: payment.length > 0 ? payment[0].id : undefined,
    };
  }

  public async saveUserSuggestion(
    paymentId: string,
    userHash: string,
    playlistId: string,
    trackId: number,
    suggestion: {
      name: string;
      artist: string;
      year: number;
      extraNameAttribute?: string;
      extraArtistAttribute?: string;
    }
  ): Promise<boolean> {
    try {
      const { verified, paymentDbId } = await this.verifyPaymentOwnership(
        paymentId,
        userHash
      );

      if (!verified) {
        return false;
      }

      // Then verify the track belongs to this payment
      const check = await this.prisma.$queryRaw<any[]>`
        SELECT pl.id AS playlistDBId
        FROM  payment_has_playlist php
        JOIN  playlists pl ON pl.id = php.playlistId
        JOIN  playlist_has_tracks pht ON pht.playlistId = pl.id
        JOIN  payments p ON p.id = php.paymentId
        WHERE p.paymentId = ${paymentId}
        AND   pht.trackId = ${trackId}
        AND   pl.playlistId = ${playlistId}
        LIMIT 1
      `;

      if (check.length === 0) {
        return false;
      }

      // Get the user ID
      const user = await this.prisma.user.findFirst({
        where: {
          hash: userHash,
        },
        select: {
          id: true,
        },
      });

      if (!user) {
        return false;
      }

      // Check if suggestion already exists
      const existingSuggestion = await this.prisma.userSuggestion.findFirst({
        where: {
          trackId: trackId,
          userId: user.id,
        },
      });

      if (existingSuggestion) {
        // Update existing suggestion
        await this.prisma.userSuggestion.update({
          where: {
            id: existingSuggestion.id,
          },
          data: {
            name: suggestion.name,
            artist: suggestion.artist,
            year: suggestion.year,
            extraNameAttribute: suggestion.extraNameAttribute,
            extraArtistAttribute: suggestion.extraArtistAttribute,
          },
        });
      } else {
        // Create new suggestion
        await this.prisma.userSuggestion.create({
          data: {
            trackId: trackId,
            userId: user.id,
            playlistId: check[0].playlistDBId,
            name: suggestion.name,
            artist: suggestion.artist,
            year: suggestion.year,
            extraNameAttribute: suggestion.extraNameAttribute,
            extraArtistAttribute: suggestion.extraArtistAttribute,
          },
        });
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  public async submitUserSuggestions(
    paymentId: string,
    userHash: string,
    playlistId: string,
    clientIp: string
  ): Promise<boolean> {
    try {
      const { verified, paymentDbId } = await this.verifyPaymentOwnership(
        paymentId,
        userHash
      );

      if (!verified) {
        return false;
      }

      const payment = await this.prisma.payment.findFirst({
        where: {
          paymentId,
        },
      });

      const playlist = await this.prisma.playlist.findFirst({
        where: {
          playlistId,
        },
      });

      const paymentHasPlaylist = await this.prisma.paymentHasPlaylist.findFirst(
        {
          where: {
            paymentId: payment?.id,
            playlistId: playlist?.id,
          },
        }
      );

      // Count the number of suggestions
      const suggestionCount = await this.prisma.userSuggestion.count({
        where: {
          playlistId: playlist?.id,
          userId: payment?.userId,
        },
      });

      // Only proceed if there are actual suggestions
      if (suggestionCount > 0 && paymentHasPlaylist) {
        // Get the payment

        await this.prisma.paymentHasPlaylist.update({
          where: { id: paymentHasPlaylist.id },
          data: {
            suggestionsPending: true,
            userConfirmedPrinting: true,
          },
        });

        this.pushover.sendMessage(
          {
            title: `QRSong! Correcties doorgegeven`,
            message: `${suggestionCount} correcties doorgegeven door: ${payment?.fullname}`,
            sound: 'incoming',
          },
          clientIp
        );

        return true;
      } else if (paymentHasPlaylist?.type == 'physical') {
        // User approved without text corrections, but design might have changed
        // Set eligableForPrinter to FALSE first, then regenerate PDFs
        await this.prisma.paymentHasPlaylist.update({
          where: { id: paymentHasPlaylist.id },
          data: {
            eligableForPrinter: false,
            userConfirmedPrinting: true,
          },
        });

        await this.prisma.payment.update({
          where: { paymentId },
          data: {
            userAgreedToPrinting: true,
            userAgreedToPrintingAt: new Date(),
          },
        });

        // Regenerate PDFs (to capture any design changes)
        // Old PDFs are automatically cleared by generator.generate()
        await this.generator.queueGenerate(
          paymentId,
          '',
          '',
          true, // Force finalize
          true, // Skip main mail
          false, // Only product mail
          '', // User agent
          // Callback to set eligableForPrinter and check printer readiness after generation
          {
            type: 'checkPrinter',
            paymentId,
            clientIp,
            paymentHasPlaylistId: paymentHasPlaylist.id,
          }
        );

        return true;
      } else if (paymentHasPlaylist) {
        // User approved without text corrections (digital order or other)
        // Design might have changed, regenerate PDFs to capture changes
        await this.prisma.payment.update({
          where: { paymentId },
          data: {
            userAgreedToPrinting: true,
            userAgreedToPrintingAt: new Date(),
          },
        });

        // Set suggestionsPending to show "processing" view until email is sent
        await this.prisma.paymentHasPlaylist.update({
          where: { id: paymentHasPlaylist.id },
          data: {
            suggestionsPending: true,
            userConfirmedPrinting: true,
          },
        });

        // Regenerate PDFs (to capture any design changes)
        // Old PDFs are automatically cleared by generator.generate()
        const callbackData = {
          type: 'sendDigitalEmail' as const,
          paymentId,
          playlistId,
          userHash,
        };

        await this.generator.queueGenerate(
          paymentId,
          '',
          '',
          true,  // Force finalize
          true,  // Skip main mail
          false, // Only product mail
          '',    // User agent
          callbackData
        );

        return true;
      }

      return false;
    } catch (error) {
      console.error('Error submitting user suggestions:', error);
      return false;
    }
  }

  public async deleteUserSuggestion(
    paymentId: string,
    userHash: string,
    playlistId: string,
    trackId: number
  ): Promise<boolean> {
    try {
      const { verified } = await this.verifyPaymentOwnership(
        paymentId,
        userHash
      );
      if (!verified) {
        return false;
      }

      // Verify the track belongs to this payment
      const hasAccess = await this.prisma.$queryRaw<any[]>`
        SELECT 1
        FROM payment_has_playlist php
        JOIN playlists pl ON pl.id = php.playlistId
        JOIN playlist_has_tracks pht ON pht.playlistId = pl.id
        JOIN payments p ON p.id = php.paymentId
        WHERE p.paymentId = ${paymentId}
        AND pht.trackId = ${trackId}
        LIMIT 1
      `;

      if (hasAccess.length === 0) {
        return false;
      }

      // Get the user ID
      const user = await this.prisma.user.findFirst({
        where: {
          hash: userHash,
        },
        select: {
          id: true,
        },
      });

      if (!user) {
        return false;
      }

      // Delete the suggestion for this specific user
      await this.prisma.userSuggestion.deleteMany({
        where: {
          trackId: trackId,
          userId: user.id,
        },
      });

      return true;
    } catch (error) {
      console.error('Error deleting user suggestion:', error);
      return false;
    }
  }

  public async getCorrections(): Promise<any[]> {
    const corrections = await this.prisma.$queryRaw<any[]>`
      SELECT 
        u.id as userId,
        u.email,
        p.fullname,
        pl.name as playlistName,
        p.paymentId,
        u.hash as userHash,
        pl.playlistId,
        CAST(COUNT(DISTINCT us.id) AS SIGNED) as suggestionCount
      FROM payments p
      JOIN users u ON p.userId = u.id
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      LEFT JOIN usersuggestions us ON us.playlistId = pl.id
      WHERE php.suggestionsPending = 1
      GROUP BY u.id, u.email, p.fullname, pl.name, p.paymentId, u.hash, pl.playlistId
    `;

    return corrections;
  }

  public async processCorrections(
    paymentId: string,
    userHash: string,
    playlistId: string,
    artistOnlyForMe: boolean,
    titleOnlyForMe: boolean,
    yearOnlyForMe: boolean,
    andSend: boolean,
    clientIp: string
  ): Promise<boolean> {
    try {
      // First verify ownership
      const { verified } = await this.verifyPaymentOwnership(
        paymentId,
        userHash
      );

      if (!verified) {
        return false;
      }

      // Get paymentHasPlaylistId and type independently (needed even if no text corrections)
      const phpInfo = await this.prisma.$queryRaw<any[]>`
        SELECT
          php.id AS paymentHasPlaylistId,
          php.type AS playlistType
        FROM payments p
        JOIN users u ON p.userId = u.id
        JOIN payment_has_playlist php ON php.paymentId = p.id
        JOIN playlists pl ON pl.id = php.playlistId
        WHERE p.paymentId = ${paymentId}
        AND u.hash = ${userHash}
        AND pl.playlistId = ${playlistId}
        LIMIT 1
      `;

      if (phpInfo.length === 0) {
        this.logger.log(
          color.red.bold('PaymentHasPlaylist not found for correction')
        );
        return false;
      }

      const paymentHasPlaylistId = phpInfo[0].paymentHasPlaylistId;
      const playlistType = phpInfo[0].playlistType;
      const hasPhysicalPlaylists = playlistType === 'physical';

      // Get all suggestions for this payment/playlist combination
      const suggestions = await this.prisma.$queryRaw<any[]>`
        SELECT
          t.id as trackId,
          t.name as originalName,
          t.artist as originalArtist,
          t.year as originalYear,
          us.name as suggestedName,
          us.artist as suggestedArtist,
          us.year as suggestedYear,
          us.extraNameAttribute as suggestedExtraNameAttribute,
          us.extraArtistAttribute as suggestedExtraArtistAttribute
        FROM payments p
        JOIN users u ON p.userId = u.id
        JOIN payment_has_playlist php ON php.paymentId = p.id
        JOIN playlists pl ON pl.id = php.playlistId
        JOIN playlist_has_tracks pht ON pht.playlistId = pl.id
        JOIN tracks t ON t.id = pht.trackId
        JOIN usersuggestions us ON us.trackId = t.id AND us.userId = u.id
        WHERE p.paymentId = ${paymentId}
        AND u.hash = ${userHash}
        AND pl.playlistId = ${playlistId}
      `;

      const updateQueries = [];

      for (const suggestion of suggestions) {
        const changes = [];
        let hasChanges = false;

        // Check for differences
        if (suggestion.originalName !== suggestion.suggestedName) {
          changes.push(
            `Name changed from '${color.white.bold(
              suggestion.originalName
            )}' to '${color.white.bold(suggestion.suggestedName)}'` +
              (titleOnlyForMe ? ' (only for this playlist)' : '')
          );
          hasChanges = true;
        }
        if (suggestion.originalArtist !== suggestion.suggestedArtist) {
          changes.push(
            `Artist changed from '${color.white.bold(
              suggestion.originalArtist
            )}' to '${color.white.bold(suggestion.suggestedArtist)}'` +
              (artistOnlyForMe ? ' (only for this playlist)' : '')
          );
          hasChanges = true;
        }
        if (suggestion.originalYear !== suggestion.suggestedYear) {
          changes.push(
            `Year changed from ${color.white.bold(
              suggestion.originalYear
            )} to ${color.white.bold(suggestion.suggestedYear)}` +
              (yearOnlyForMe ? ' (only for this playlist)' : '')
          );
          hasChanges = true;
        }
        if (suggestion.suggestedExtraNameAttribute) {
          changes.push(
            `Extra name attribute added: '${color.white.bold(
              suggestion.suggestedExtraNameAttribute
            )}'`
          );
          hasChanges = true;
        }
        if (suggestion.suggestedExtraArtistAttribute) {
          changes.push(
            `Extra artist attribute added: '${color.white.bold(
              suggestion.suggestedExtraArtistAttribute
            )}'`
          );
          hasChanges = true;
        }

        if (hasChanges) {
          // Log the changes
          this.logger.log(
            color.blue.bold(
              `Track ${color.white.bold(suggestion.trackId)} changes:`
            )
          );
          changes.forEach((change) => {
            this.logger.log(color.blue.bold(`  ${change}`));
          });

          const trackModifications: Prisma.TrackUpdateInput = {};
          const extraInfoModifications: Prisma.TrackExtraInfoUpdateInput = {};
          let requiresExtraInfoUpdate = false;

          // Determine modifications for Track
          if (
            suggestion.originalName !== suggestion.suggestedName &&
            !titleOnlyForMe
          ) {
            trackModifications.name = suggestion.suggestedName;
          }
          if (
            suggestion.originalArtist !== suggestion.suggestedArtist &&
            !artistOnlyForMe
          ) {
            trackModifications.artist = suggestion.suggestedArtist;
          }
          if (
            suggestion.originalYear !== suggestion.suggestedYear &&
            !yearOnlyForMe
          ) {
            trackModifications.year = suggestion.suggestedYear;
          }

          // Determine modifications for TrackExtraInfo
          if (
            suggestion.originalName !== suggestion.suggestedName &&
            titleOnlyForMe
          ) {
            extraInfoModifications.name = suggestion.suggestedName;
            requiresExtraInfoUpdate = true;
          }
          if (
            suggestion.originalArtist !== suggestion.suggestedArtist &&
            artistOnlyForMe
          ) {
            extraInfoModifications.artist = suggestion.suggestedArtist;
            requiresExtraInfoUpdate = true;
          }
          if (
            suggestion.originalYear !== suggestion.suggestedYear &&
            yearOnlyForMe
          ) {
            extraInfoModifications.year = suggestion.suggestedYear;
            requiresExtraInfoUpdate = true;
          }
          if (suggestion.suggestedExtraNameAttribute) {
            extraInfoModifications.extraNameAttribute =
              suggestion.suggestedExtraNameAttribute;
            requiresExtraInfoUpdate = true;
          }
          if (suggestion.suggestedExtraArtistAttribute) {
            extraInfoModifications.extraArtistAttribute =
              suggestion.suggestedExtraArtistAttribute;
            requiresExtraInfoUpdate = true;
          }

          // If any change occurred, mark track as manually corrected
          trackModifications.manuallyCorrected = true;

          // Add Track update to queries
          updateQueries.push(
            this.prisma.track.update({
              where: { id: suggestion.trackId },
              data: trackModifications,
            })
          );

          // Add TrackExtraInfo update/create to queries if needed
          if (requiresExtraInfoUpdate) {
            const playlist = await this.prisma.playlist.findFirst({
              where: { playlistId: playlistId },
              select: { id: true },
            });

            if (playlist) {
              const existingExtraInfo =
                await this.prisma.trackExtraInfo.findFirst({
                  where: {
                    trackId: suggestion.trackId,
                    playlistId: playlist.id,
                  },
                });

              if (existingExtraInfo) {
                updateQueries.push(
                  this.prisma.trackExtraInfo.update({
                    where: { id: existingExtraInfo.id },
                    data: extraInfoModifications,
                  })
                );
              } else {
                const createData: Prisma.TrackExtraInfoCreateInput = {
                  track: { connect: { id: suggestion.trackId } },
                  playlist: { connect: { id: playlist.id } },
                  // Conditionally spread properties, casting to simple types expected by CreateInput
                  ...(extraInfoModifications.name !== undefined && {
                    name: extraInfoModifications.name as string | null,
                  }),
                  ...(extraInfoModifications.artist !== undefined && {
                    artist: extraInfoModifications.artist as string | null,
                  }),
                  ...(extraInfoModifications.year !== undefined && {
                    year: extraInfoModifications.year as number | null,
                  }),
                  ...(extraInfoModifications.extraNameAttribute !==
                    undefined && {
                    extraNameAttribute:
                      extraInfoModifications.extraNameAttribute as
                        | string
                        | null,
                  }),
                  ...(extraInfoModifications.extraArtistAttribute !==
                    undefined && {
                    extraArtistAttribute:
                      extraInfoModifications.extraArtistAttribute as
                        | string
                        | null,
                  }),
                };
                updateQueries.push(
                  this.prisma.trackExtraInfo.create({
                    data: createData,
                  })
                );
              }
            }
          }
        }
      }

      // Execute all text correction updates if there are any
      if (updateQueries.length > 0) {
        // Run updates in series to avoid exhausting the connection pool
        for (const query of updateQueries) {
          await query;
        }

        this.logger.log(
          color.green.bold(
            `Successfully processed ${color.white.bold(
              updateQueries.length
            )} text corrections`
          )
        );
      } else {
        this.logger.log(color.yellow.bold('No text corrections detected'));
      }

      // Always clear suggestionsPending flag (using the independently queried paymentHasPlaylistId)
      await this.prisma.$executeRaw`
        UPDATE payment_has_playlist
        SET suggestionsPending = false
        WHERE id = ${paymentHasPlaylistId}
      `;

      // Delete all user suggestions for this payment (if any exist)
      await this.prisma.$executeRaw`
        DELETE FROM usersuggestions
        WHERE userId = (SELECT id FROM users WHERE hash = ${userHash})
        AND trackId IN (
          SELECT id
          FROM tracks
          WHERE id IN (
            SELECT trackId
            FROM playlist_has_tracks
            WHERE playlistId = (
              SELECT id
              FROM playlists
              WHERE playlistId = ${playlistId}
            )
          )
        )
      `;

      // Clear playlist cache to ensure changes are reflected
      await this.data.clearPlaylistCache(playlistId);

      // ALWAYS regenerate PDFs when andSend=true (even if only design changes, no text corrections)
      if (andSend) {
        this.logger.log(
          color.blue.bold(
            'Regenerating PDFs (may include design changes from correction form)'
          )
        );

        // Set eligableForPrinter to FALSE first to prevent premature sending to printer
        // It will be set to true AFTER the PDFs are regenerated
        if (hasPhysicalPlaylists) {
          await this.prisma.paymentHasPlaylist.update({
            where: {
              id: paymentHasPlaylistId,
            },
            data: {
              eligableForPrinter: false,
            },
          });
        }

        // Regenerate PDFs (old PDFs are automatically cleared by generator.generate())
        // Determine callback based on playlist type
        let callbackData;
        if (hasPhysicalPlaylists) {
          // Physical playlists: check printer readiness
          callbackData = {
            type: 'checkPrinter' as const,
            paymentId,
            clientIp,
            paymentHasPlaylistId,
          };
        } else {
          // Digital lists: send email after PDF generation
          callbackData = {
            type: 'sendDigitalEmail' as const,
            paymentId,
            playlistId,
            userHash,
          };
        }

        await this.generator.queueGenerate(
          paymentId,
          '',
          '',
          true, // Force finalize
          true, // Skip main mail
          false, // Only product mail
          '', // User agent
          callbackData
        );
      } else {
        // If not sending, just check if ready for printer (for physical orders)
        if (hasPhysicalPlaylists) {
          this.checkIfReadyForPrinter(paymentId, clientIp);
        }
      }

      return true;
    } catch (error) {
      console.error('Error processing corrections:', error);
      return false;
    }
  }

  public async extendPrinterDeadline(
    paymentId: string,
    userHash: string,
    playlistId: string
  ): Promise<boolean> {
    try {
      const { verified, paymentDbId } = await this.verifyPaymentOwnership(
        paymentId,
        userHash
      );

      if (!verified) {
        return false;
      }

      const payment = await this.prisma.payment.findFirst({
        where: { paymentId },
        select: {
          id: true,
          canBeSentToPrinterAt: true,
        },
      });

      if (!payment) {
        return false;
      }

      // Add 24 hours to canBeSentToPrinterAt
      const newPrinterDate = payment.canBeSentToPrinterAt
        ? new Date(payment.canBeSentToPrinterAt.getTime() + 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 24 * 60 * 60 * 1000);

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { canBeSentToPrinterAt: newPrinterDate },
      });

      return true;
    } catch (error) {
      console.error('Error extending printer deadline:', error);
      return false;
    }
  }

  private async checkIfReadyForPrinter(paymentId: string, clientIp: string) {
    // First get the internal payment ID
    const payment = await this.prisma.payment.findUnique({
      where: { paymentId },
      select: { id: true },
    });

    if (!payment) return;

    const internalPaymentId = payment.id;

    // See if all physical playlists are ready for printing
    const allPhysicalPlaylistsReady = await this.prisma.$queryRaw<any[]>`
            SELECT COUNT(*) as count,
                   (SELECT COUNT(*)
                    FROM payment_has_playlist
                    WHERE paymentId = ${internalPaymentId}
                    AND type = 'physical') as total
            FROM payment_has_playlist
            WHERE paymentId = ${internalPaymentId}
            AND type = 'physical'
            AND eligableForPrinter = true
          `;

    this.logger.log(
      color.blue.bold(
        `Physical playlists for payment ${color.white.bold(
          paymentId
        )} ready for printing: ${color.white.bold(
          allPhysicalPlaylistsReady[0].count
        )} / ${color.white.bold(allPhysicalPlaylistsReady[0].total)}`
      )
    );

    if (
      allPhysicalPlaylistsReady[0].total > 0 &&
      allPhysicalPlaylistsReady[0].count === allPhysicalPlaylistsReady[0].total
    ) {
      // Update payment status
      await this.prisma.payment.update({
        where: {
          paymentId,
        },
        data: {
          canBeSentToPrinter: true,
        },
      });

      this.logger.log(
        color.blue.bold('All physical playlists are ready for printing')
      );
      try {
        await this.generator.sendToPrinter(paymentId, clientIp);
      } catch (error) {
        this.logger.log(
          color.red.bold(
            `Error sending to printer from user approval: ${error}`
          )
        );
      }
    }
  }

  /**
   * Validates if a playlist can be reloaded from its music service based on track count limits.
   * Users can only reload if the current playlist has <= tracks than they paid for.
   */
  private async validateTrackCountForReload(
    paymentId: string,
    userHash: string,
    playlistId: string
  ): Promise<{
    valid: boolean;
    paidTracks?: number;
    currentTracks?: number;
    serviceType?: string;
    error?: string;
  }> {
    try {
      // Get the number of tracks the user paid for and the service type
      const paymentInfo = await this.prisma.$queryRaw<any[]>`
        SELECT php.numberOfTracks as paidTracks, pl.id as playlistDbId, pl.serviceType
        FROM payments p
        JOIN users u ON p.userId = u.id
        JOIN payment_has_playlist php ON php.paymentId = p.id
        JOIN playlists pl ON pl.id = php.playlistId
        WHERE p.paymentId = ${paymentId}
        AND u.hash = ${userHash}
        AND pl.playlistId = ${playlistId}
        LIMIT 1
      `;

      if (paymentInfo.length === 0) {
        return {
          valid: false,
          error: 'Payment or playlist not found',
        };
      }

      const paidTracks = paymentInfo[0].paidTracks;
      const serviceType = paymentInfo[0].serviceType || 'spotify';

      // Get the correct provider for this service type
      const provider = this.musicRegistry.getProviderByString(serviceType);
      if (!provider) {
        return {
          valid: false,
          error: `Unsupported music service: ${serviceType}`,
        };
      }

      // Fetch current playlist data from the music service
      const playlistData = await provider.getPlaylist(playlistId);

      if (!playlistData.success || !playlistData.data) {
        return {
          valid: false,
          error: `Failed to fetch playlist from ${serviceType}`,
        };
      }

      const currentTracks = playlistData.data.trackCount;

      // Validate: service tracks must be <= paid tracks
      if (currentTracks > paidTracks) {
        this.logger.log(
          color.red.bold(
            `Reload blocked: ${serviceType} has ${currentTracks} tracks but user only paid for ${paidTracks}`
          )
        );
        return {
          valid: false,
          paidTracks,
          currentTracks,
          serviceType,
          error: 'track_limit_exceeded',
        };
      }

      return {
        valid: true,
        paidTracks,
        currentTracks,
        serviceType,
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error validating track count: ${error}`)
      );
      return {
        valid: false,
        error: 'Validation error',
      };
    }
  }

  /**
   * Reloads a playlist from its music service if the track count is within the paid limit.
   * This allows users to refresh their playlist data if tracks were removed or metadata changed.
   * Rate limited to once every 15 minutes (bypassed in development).
   */
  public async reloadPlaylist(
    paymentId: string,
    userHash: string,
    playlistId: string
  ): Promise<{
    success: boolean;
    message?: string;
    paidTracks?: number;
    currentTracks?: number;
    error?: string;
    retryAfter?: number;
    lastReloadAt?: string;
  }> {
    try {
      // Verify payment ownership
      const { verified } = await this.verifyPaymentOwnership(
        paymentId,
        userHash
      );

      if (!verified) {
        return {
          success: false,
          error: 'Unauthorized',
        };
      }

      // Get PaymentHasPlaylist to check rate limit (unless in development)
      const isDevelopment = process.env.ENVIRONMENT === 'development';

      if (!isDevelopment) {
        const payment = await this.prisma.payment.findFirst({
          where: { paymentId },
          select: { id: true },
        });

        if (!payment) {
          return {
            success: false,
            error: 'Payment not found',
          };
        }

        const playlist = await this.prisma.playlist.findFirst({
          where: { playlistId },
          select: { id: true },
        });

        if (!playlist) {
          return {
            success: false,
            error: 'Playlist not found',
          };
        }

        const paymentHasPlaylist = await this.prisma.paymentHasPlaylist.findFirst({
          where: {
            paymentId: payment.id,
            playlistId: playlist.id,
          },
          select: {
            lastReloadAt: true,
          },
        });

        if (paymentHasPlaylist?.lastReloadAt) {
          const now = new Date();
          const lastReload = new Date(paymentHasPlaylist.lastReloadAt);
          const elapsedMinutes = (now.getTime() - lastReload.getTime()) / (1000 * 60);
          const rateLimitMinutes = 15;

          if (elapsedMinutes < rateLimitMinutes) {
            const remainingMinutes = rateLimitMinutes - elapsedMinutes;
            const remainingSeconds = Math.ceil(remainingMinutes * 60);

            this.logger.log(
              color.yellow.bold(
                `Rate limit: Reload blocked for ${paymentId}. Last reload: ${elapsedMinutes.toFixed(1)} minutes ago`
              )
            );

            return {
              success: false,
              error: 'rate_limit_exceeded',
              retryAfter: remainingSeconds,
              lastReloadAt: lastReload.toISOString(),
            };
          }
        }
      } else {
        this.logger.log(
          color.cyan.bold(
            `Development mode: Rate limiting bypassed for ${paymentId}`
          )
        );
      }

      // Validate track count
      const validation = await this.validateTrackCountForReload(
        paymentId,
        userHash,
        playlistId
      );

      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
          paidTracks: validation.paidTracks,
          currentTracks: validation.currentTracks,
        };
      }

      const serviceType = validation.serviceType || 'spotify';

      this.logger.log(
        color.blue.bold(
          `Reloading playlist ${playlistId} (${serviceType}) for payment ${paymentId}`
        )
      );

      // Get playlist database ID
      const playlist = await this.prisma.playlist.findFirst({
        where: { playlistId },
        select: { id: true, numberOfTracks: true },
      });

      if (!playlist) {
        return {
          success: false,
          error: 'Playlist not found in database',
        };
      }

      // Get the correct provider for this service type
      const provider = this.musicRegistry.getProviderByString(serviceType);
      if (!provider) {
        return {
          success: false,
          error: `Unsupported music service: ${serviceType}`,
        };
      }

      // Fetch fresh tracks from the music service (cache=false to get latest data)
      const serviceTracks = await provider.getTracks(playlistId, false);

      if (!serviceTracks.success || !serviceTracks.data || !serviceTracks.data.tracks) {
        return {
          success: false,
          error: `Failed to fetch tracks from ${serviceType}`,
        };
      }

      // Store updated tracks in database with order from playlist
      const trackOrder = new Map<string, number>();
      serviceTracks.data.tracks.forEach((track: any, index: number) => {
        trackOrder.set(track.id, index + 1);
      });
      await this.data.storeTracks(
        playlist.id,
        playlistId,
        serviceTracks.data.tracks,
        trackOrder,
        serviceType
      );

      // Update playlist numberOfTracks to match service
      await this.prisma.playlist.update({
        where: { id: playlist.id },
        data: { numberOfTracks: validation.currentTracks },
      });

      // Clear old cache entries
      const oldCacheKey = `tracks2_${playlistId}_${playlist.numberOfTracks}`;
      const newCacheKey = `tracks2_${playlistId}_${validation.currentTracks}`;
      await this.cache.del(oldCacheKey);
      await this.cache.del(newCacheKey);

      // Update lastReloadAt timestamp
      const payment = await this.prisma.payment.findFirst({
        where: { paymentId },
        select: { id: true },
      });

      if (payment) {
        const playlistDbId = playlist.id;
        await this.prisma.paymentHasPlaylist.updateMany({
          where: {
            paymentId: payment.id,
            playlistId: playlistDbId,
          },
          data: {
            lastReloadAt: new Date(),
          },
        });
      }

      this.logger.log(
        color.green.bold(
          `Successfully reloaded playlist ${color.white.bold(playlistId)} with ${color.white.bold(validation.currentTracks)} tracks`
        )
      );

      return {
        success: true,
        message:
          validation.currentTracks !== playlist.numberOfTracks
            ? 'Playlist reloaded successfully with updated track count'
            : 'Playlist reloaded successfully',
        paidTracks: validation.paidTracks,
        currentTracks: validation.currentTracks,
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error reloading playlist: ${error}`)
      );
      return {
        success: false,
        error: 'Failed to reload playlist',
      };
    }
  }

  public static getInstance(): Suggestion {
    if (!Suggestion.instance) {
      Suggestion.instance = new Suggestion();
    }
    return Suggestion.instance;
  }
}

export default Suggestion;
