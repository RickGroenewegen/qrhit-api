import { color } from 'console-log-colors';
import Logger from './logger';
import { Prisma, PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';

import PushoverClient from './pushover';
import Mollie from './mollie';
import Generator from './generator';

class Suggestion {
  private static instance: Suggestion;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private pushover = new PushoverClient();
  private mollie = new Mollie();
  private generator = Generator.getInstance();

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

    const tracks = await this.prisma.$queryRaw<any[]>`
      SELECT 
        t.id,
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
      metadata: { payment },
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
          data: { suggestionsPending: true },
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
        // Set eligableForPrinter to true
        await this.prisma.paymentHasPlaylist.update({
          where: { id: paymentHasPlaylist.id },
          data: { eligableForPrinter: true, eligableForPrinterAt: new Date() },
        });

        this.prisma.payment.update({
          where: { paymentId },
          data: {
            userAgreedToPrinting: true,
            userAgreedToPrintingAt: new Date(),
          },
        });

        this.checkIfReadyForPrinter(paymentId, clientIp);

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
          php.id AS paymentHasPlaylistId,
          php.type AS playlistType,
          us.extraNameAttribute as suggestedExtraNameAttribute,
          us.extraArtistAttribute as suggestedExtraArtistAttribute
        FROM payments p
        JOIN users u ON p.userId = u.id
        JOIN payment_has_playlist php ON php.paymentId = p.id
        JOIN playlists pl ON pl.id = php.playlistId
        JOIN playlist_has_tracks pht ON pht.playlistId = pl.id
        JOIN tracks t ON t.id = pht.trackId
        JOIN usersuggestions us ON us.trackId = t.id
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

      let hasPhysicalPlaylists = suggestions.some(
        (suggestion) => suggestion.playlistType === 'physical'
      );

      // Execute all updates if there are any
      if (updateQueries.length > 0) {
        // Run updates in series to avoid exhausting the connection pool
        for (const query of updateQueries) {
          await query;
        }
        // Update payment status
        await this.prisma.$executeRaw`
          UPDATE payment_has_playlist
          SET suggestionsPending = false
          WHERE id = ${suggestions[0].paymentHasPlaylistId}
        `;
        // Delete all user suggestions for this payment
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

        this.logger.log(
          color.green.bold(
            `Successfully processed ${color.white.bold(
              updateQueries.length
            )} corrections`
          )
        );

        if (andSend) {
          // set userAgreed van paymentByPlaylist op true
          if (hasPhysicalPlaylists) {
            await this.prisma.paymentHasPlaylist.update({
              where: {
                id: suggestions[0].paymentHasPlaylistId,
              },
              data: {
                eligableForPrinter: true,
                eligableForPrinterAt: new Date(),
              },
            });
          }

          await this.mollie.clearPDFs(paymentId);
          await this.generator.queueGenerate(
            paymentId,
            '',
            '',
            true, // Force finalize
            true, // Skip main mail
            false // Only produt mail
          );

          if (hasPhysicalPlaylists) {
            this.checkIfReadyForPrinter(paymentId, clientIp);
          }
        }
      } else {
        this.logger.log(
          color.yellow.bold('No changes detected in suggestions')
        );

        // Set suggestionsPending to false
        await this.prisma.$executeRaw`
          UPDATE payment_has_playlist
          SET suggestionsPending = false
          WHERE id = ${suggestions[0].paymentHasPlaylistId}
        `;

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
      this.generator.sendToPrinter(paymentId, clientIp);
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
