import { color } from 'console-log-colors';
import slugify from 'slugify';
import { CartItem } from '../interfaces/CartItem';
import { DataDeps } from './types';

export const BLOCKED_PLAYLISTS_CACHE_KEY = 'blocked_playlists_v1';

export async function storePlaylists(
  deps: DataDeps,
  userDatabaseId: number,
  cartItems: CartItem[],
  resetCache: boolean = false
): Promise<number[]> {
  const playlistDatabaseIds: number[] = [];

  for (const cartItem of cartItems) {
    let playlistDatabaseId: number = 0;

    let usePlaylistId = cartItem.playlistId;
    if (cartItem.isSlug) {
      const dbPlaylist = await deps.prisma.playlist.findFirst({
        where: { slug: cartItem.playlistId },
      });

      usePlaylistId = dbPlaylist!.playlistId;
    }

    // Check if the playlist exists. If not, create it
    const playlist = await deps.prisma.playlist.findUnique({
      where: {
        playlistId: usePlaylistId,
      },
    });

    if (!playlist) {
      // create the playlist
      let extraPrice = 0;

      // Extra protection. Messing the other way around will increase the price
      if (cartItem.price < 0) {
        extraPrice = 0;
      }

      let giftcardAmount = 0;
      let giftcardFrom = '';
      let giftcardMessage = '';

      if (cartItem.productType == 'giftcard') {
        if (cartItem.type == 'physical') {
          extraPrice = cartItem.extraPrice!;
        }

        giftcardAmount = cartItem.price - extraPrice;
        giftcardFrom = cartItem.fromName!;
        giftcardMessage = cartItem.personalMessage!;
      }

      const slug = slugify(cartItem.playlistName, {
        lower: true,
        strict: true,
      });

      const playlistCreate = await deps.prisma.playlist.create({
        data: {
          playlistId: usePlaylistId,
          name: cartItem.playlistName,
          slug,
          image: cartItem.image,
          price: cartItem.price,
          numberOfTracks: cartItem.numberOfTracks,
          type: cartItem.productType,
          serviceType: cartItem.serviceType || 'spotify',
          giftcardAmount,
          giftcardFrom,
          giftcardMessage,
          design: cartItem.design || null,
        },
      });
      playlistDatabaseId = playlistCreate.id;
    } else {
      playlistDatabaseId = playlist.id;

      let doResetCache = false;
      if (!playlist.featured && resetCache) {
        doResetCache = true;
      }

      await deps.prisma.playlist.update({
        where: {
          id: playlistDatabaseId,
        },
        data: {
          price: cartItem.price,
          numberOfTracks: cartItem.numberOfTracks,
          name: cartItem.playlistName,
          serviceType: cartItem.serviceType || playlist.serviceType || 'spotify',
          resetCache: doResetCache,
        },
      });
    }

    playlistDatabaseIds.push(playlistDatabaseId);
  }

  return playlistDatabaseIds;
}

export async function getPlaylist(deps: DataDeps, playlistId: string): Promise<any> {
  const playlist: any[] = await deps.prisma.$queryRaw`
      SELECT      *, (SELECT COUNT(1) FROM playlist_has_tracks WHERE playlist_has_tracks.playlistId = playlists.id) as numberOfTracks
      FROM        playlists
      WHERE       playlists.playlistId = ${playlistId}`;
  return playlist[0];
}

export async function getPlaylistsByPaymentId(
  deps: DataDeps,
  paymentId: string,
  playlistId: string | null = null
): Promise<any[]> {
  let query = `
    SELECT
      playlists.id,
      playlists.playlistId,
      playlists.name,
      playlists.type AS productType,
      playlists.serviceType,
      playlists.giftcardAmount,
      playlists.giftcardFrom,
      playlists.giftcardMessage,
      payment_has_playlist.id AS paymentHasPlaylistId,
      payment_has_playlist.price,
      payment_has_playlist.priceWithoutVAT,
      payment_has_playlist.priceVAT,
      payment_has_playlist.amount,
      payment_has_playlist.emoji,
      payment_has_playlist.background,
      payment_has_playlist.logo,
      payment_has_playlist.selectedFont,
      payment_has_playlist.selectedFontSize,
      payment_has_playlist.doubleSided,
      payment_has_playlist.eco,
      payment_has_playlist.qrColor,
      payment_has_playlist.qrBackgroundColor,
      payment_has_playlist.hideCircle,
      payment_has_playlist.qrBackgroundType,
      payment_has_playlist.subType,
      payment_has_playlist.backgroundFrontType,
      payment_has_playlist.backgroundFrontColor,
      payment_has_playlist.useFrontGradient,
      payment_has_playlist.gradientFrontColor,
      payment_has_playlist.gradientFrontDegrees,
      payment_has_playlist.gradientFrontPosition,
      payment_has_playlist.backgroundBackType,
      payment_has_playlist.backgroundBack,
      payment_has_playlist.backgroundBackColor,
      payment_has_playlist.fontColor,
      payment_has_playlist.useGradient,
      payment_has_playlist.gradientBackgroundColor,
      payment_has_playlist.gradientDegrees,
      payment_has_playlist.gradientPosition,
      payment_has_playlist.frontOpacity,
      payment_has_playlist.backOpacity,
      payment_has_playlist.printerType,
      payment_has_playlist.gamesEnabled,
      payment_has_playlist.boxEnabled,
      payment_has_playlist.boxQuantity,
      payment_has_playlist.boxPrice,
      payment_has_playlist.boxFilename,
      payment_has_playlist.boxFrontBackgroundType,
      payment_has_playlist.boxFrontBackground,
      payment_has_playlist.boxFrontBackgroundColor,
      payment_has_playlist.boxFrontUseFrontGradient,
      payment_has_playlist.boxFrontGradientColor,
      payment_has_playlist.boxFrontGradientDegrees,
      payment_has_playlist.boxFrontGradientPosition,
      payment_has_playlist.boxFrontLogo,
      payment_has_playlist.boxFrontLogoScale,
      payment_has_playlist.boxFrontLogoPositionX,
      payment_has_playlist.boxFrontLogoPositionY,
      payment_has_playlist.boxFrontEmoji,
      payment_has_playlist.boxBackBackgroundType,
      payment_has_playlist.boxBackBackground,
      payment_has_playlist.boxBackBackgroundColor,
      payment_has_playlist.boxBackFontColor,
      payment_has_playlist.boxBackUseGradient,
      payment_has_playlist.boxBackGradientColor,
      payment_has_playlist.boxBackGradientDegrees,
      payment_has_playlist.boxBackGradientPosition,
      payment_has_playlist.boxBackOpacity,
      payment_has_playlist.boxBackText,
      playlists.numberOfTracks,
      payment_has_playlist.numberOfTracks AS paymentHasPlaylistNumberOfTracks,
      playlists.featured,
      payment_has_playlist.type AS orderType
    FROM
      payment_has_playlist
    INNER JOIN
      playlists ON payment_has_playlist.playlistId = playlists.id
    INNER JOIN
      payments ON payment_has_playlist.paymentId = payments.id
    WHERE
      payments.paymentId = ?`;

  const params: any[] = [paymentId];

  if (playlistId) {
    query += ` AND playlists.playlistId = ?`;
    params.push(playlistId);
  }

  const playlists = await deps.prisma.$queryRawUnsafe<any[]>(
    query,
    ...params
  );

  return playlists;
}

export async function getPlaylistBySlug(
  deps: DataDeps,
  slug: string
): Promise<{ id: number; playlistId: string } | null> {
  const playlist = await deps.prisma.playlist.findFirst({
    where: { slug },
    select: { id: true, playlistId: true },
  });
  return playlist;
}

export async function updatePaymentHasPlaylist(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  eco: boolean,
  doubleSided: boolean,
  printerType?: string,
  template?: string | null
): Promise<{ success: boolean; error?: string }> {
  try {
    const updateData: any = {
      eco: eco,
      doubleSided: doubleSided,
    };

    if (printerType !== undefined) {
      updateData.printerType = printerType;
    }

    // Get the paymentHasPlaylist to find the related playlistId
    const paymentHasPlaylist = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: { playlistId: true }
    });

    if (!paymentHasPlaylist) {
      return { success: false, error: 'PaymentHasPlaylist not found' };
    }

    // Update PaymentHasPlaylist (eco, doubleSided, printerType)
    await deps.prisma.paymentHasPlaylist.update({
      where: { id: paymentHasPlaylistId },
      data: updateData,
    });

    // Update Playlist template if provided
    if (template !== undefined) {
      await deps.prisma.playlist.update({
        where: { id: paymentHasPlaylist.playlistId },
        data: { template: template }
      });
    }

    deps.logger.log(
      color.blue.bold(
        `Updated playlist data for ${color.white.bold(paymentHasPlaylistId)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating PaymentHasPlaylist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function updatePlaylistTrackCount(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  numberOfTracks: number
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get the paymentHasPlaylist to find the related playlistId
    const paymentHasPlaylist = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: { playlistId: true }
    });

    if (!paymentHasPlaylist) {
      return { success: false, error: 'PaymentHasPlaylist not found' };
    }

    // Update both tables in a transaction
    await deps.prisma.$transaction([
      deps.prisma.paymentHasPlaylist.update({
        where: { id: paymentHasPlaylistId },
        data: { numberOfTracks },
      }),
      deps.prisma.playlist.update({
        where: { id: paymentHasPlaylist.playlistId },
        data: { numberOfTracks },
      }),
    ]);

    deps.logger.log(
      color.blue.bold(
        `Updated track count to ${color.white.bold(numberOfTracks)} for paymentHasPlaylist ${color.white.bold(paymentHasPlaylistId)} and playlist ${color.white.bold(paymentHasPlaylist.playlistId)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating track count for PaymentHasPlaylist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function deletePlaylistFromOrder(
  deps: DataDeps,
  paymentHasPlaylistId: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const paymentHasPlaylist = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: { paymentId: true, playlistId: true },
    });

    if (!paymentHasPlaylist) {
      return { success: false, error: 'PaymentHasPlaylist not found' };
    }

    // Count how many playlists this payment has
    const playlistCount = await deps.prisma.paymentHasPlaylist.count({
      where: { paymentId: paymentHasPlaylist.paymentId },
    });

    if (playlistCount <= 1) {
      return { success: false, error: 'Cannot delete the last playlist from an order' };
    }

    await deps.prisma.paymentHasPlaylist.delete({
      where: { id: paymentHasPlaylistId },
    });

    deps.logger.log(
      color.red.bold(
        `Deleted paymentHasPlaylist ${color.white.bold(paymentHasPlaylistId)} from payment ${color.white.bold(paymentHasPlaylist.paymentId)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error deleting PaymentHasPlaylist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function updatePlaylistAmount(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  amount: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const paymentHasPlaylist = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
    });

    if (!paymentHasPlaylist) {
      return { success: false, error: 'PaymentHasPlaylist not found' };
    }

    await deps.prisma.paymentHasPlaylist.update({
      where: { id: paymentHasPlaylistId },
      data: { amount },
    });

    deps.logger.log(
      color.blue.bold(
        `Updated amount to ${color.white.bold(amount)} for paymentHasPlaylist ${color.white.bold(paymentHasPlaylistId)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating amount for PaymentHasPlaylist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function updateGamesEnabled(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  gamesEnabled: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const php = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: { id: true },
    });

    if (!php) {
      return { success: false, error: 'Playlist not found' };
    }

    await deps.prisma.paymentHasPlaylist.update({
      where: { id: paymentHasPlaylistId },
      data: { gamesEnabled },
    });

    deps.logger.log(
      color.blue.bold(
        `Updated gamesEnabled for playlist ${color.white.bold(
          paymentHasPlaylistId
        )} to ${color.white.bold(gamesEnabled)}`
      )
    );

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating gamesEnabled for playlist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function resetJudgedStatus(
  deps: DataDeps,
  paymentHasPlaylistId: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const php = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: { id: true, paymentId: true },
    });

    if (!php) {
      return { success: false, error: 'PaymentHasPlaylist not found' };
    }

    // Update both payment_has_playlist.userConfirmedPrinting and payment.userAgreedToPrinting to 0
    await deps.prisma.$transaction([
      deps.prisma.paymentHasPlaylist.update({
        where: { id: paymentHasPlaylistId },
        data: { userConfirmedPrinting: false },
      }),
      deps.prisma.payment.update({
        where: { id: php.paymentId },
        data: { userAgreedToPrinting: false },
      }),
    ]);

    deps.logger.log(
      color.blue.bold(
        `Reset judged status for paymentHasPlaylist ${color.white.bold(
          paymentHasPlaylistId
        )} and payment ${color.white.bold(php.paymentId)}`
      )
    );

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error resetting judged status for paymentHasPlaylist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function updatePlaylistBlocked(
  deps: DataDeps,
  playlistId: number,
  blocked: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const playlist = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: playlistId },
      select: { id: true },
    });

    if (!playlist) {
      return { success: false, error: 'Playlist not found' };
    }

    await deps.prisma.paymentHasPlaylist.update({
      where: { id: playlistId },
      data: { blocked },
    });

    deps.logger.log(
      color.blue.bold(
        `Updated blocked status for playlist ${color.white.bold(
          playlistId
        )} to ${color.white.bold(blocked)}`
      )
    );

    // Update Redis cache (regardless of main/primary status)
    if (blocked) {
      deps.blockedPlaylists.add(playlistId);
    } else {
      deps.blockedPlaylists.delete(playlistId);
    }

    const blockedIds = Array.from(deps.blockedPlaylists).map(String);

    // Only update cache if there are blocked playlists, otherwise delete the key
    if (blockedIds.length > 0) {
      await deps.cache.setArray(BLOCKED_PLAYLISTS_CACHE_KEY, blockedIds);
      deps.logger.log(
        color.green.bold('Updated blocked playlists in Redis cache')
      );
    } else {
      await deps.cache.del(BLOCKED_PLAYLISTS_CACHE_KEY);
      deps.logger.log(
        color.green.bold('Cleared blocked playlists from Redis cache (no blocked playlists)')
      );
    }

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating blocked status for playlist ${color.white.bold(
          playlistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function loadBlocked(deps: DataDeps): Promise<void> {
  try {
    // Query all blocked PaymentHasPlaylist records
    const blockedRecords = await deps.prisma.paymentHasPlaylist.findMany({
      where: {
        blocked: true,
      },
      select: {
        id: true,
      },
    });

    // Clear existing set and populate with blocked IDs
    deps.blockedPlaylists.clear();
    for (const record of blockedRecords) {
      deps.blockedPlaylists.add(record.id);
    }

    // If main/primary server, store in Redis cache and log
    const isMainServer = await deps.utils.isMainServer();
    const cluster = await import('cluster');
    if (
      cluster.default.isPrimary &&
      (isMainServer || process.env['ENVIRONMENT'] === 'development')
    ) {
      deps.logger.log(
        color.blue.bold(
          `Loaded ${color.white.bold(
            deps.blockedPlaylists.size
          )} blocked playlists`
        )
      );

      const blockedIds = Array.from(deps.blockedPlaylists).map(String);

      // Only store in cache if there are blocked playlists
      if (blockedIds.length > 0) {
        await deps.cache.setArray(BLOCKED_PLAYLISTS_CACHE_KEY, blockedIds);
        deps.logger.log(
          color.green.bold(
            `Stored ${color.white.bold(
              blockedIds.length
            )} blocked playlists in Redis cache`
          )
        );
      } else {
        // Clear cache if no blocked playlists
        await deps.cache.del(BLOCKED_PLAYLISTS_CACHE_KEY);
      }
    }
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error loading blocked playlists: ${error.message}`)
    );
  }
}

export async function loadBlockedFromCache(deps: DataDeps): Promise<void> {
  try {
    const blockedIds = await deps.cache.getArray(BLOCKED_PLAYLISTS_CACHE_KEY);

    // Only update if we got data from cache
    if (blockedIds && blockedIds.length > 0) {
      deps.blockedPlaylists.clear();
      for (const id of blockedIds) {
        deps.blockedPlaylists.add(parseInt(id, 10));
      }
    } else {
      // If cache is empty, load directly from database (race condition on startup)
      await loadBlocked(deps);
      return; // loadBlocked sets the initialized flag
    }
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error loading blocked playlists from cache: ${error.message}`
      )
    );
  }
}
