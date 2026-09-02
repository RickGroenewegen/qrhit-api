import { color } from 'console-log-colors';
import slugify from 'slugify';
import { CartItem } from '../interfaces/CartItem';
import { DataDeps } from './types';
import { PRINTER_TYPE } from '../config/constants';

export const BLOCKED_PLAYLISTS_CACHE_KEY = 'blocked_playlists_v1';
// Stored in the Redis set when nothing is blocked, so readers can tell
// "loaded, empty" apart from "key not written yet" (fresh Redis or a
// version-bump deploy, since cache keys are version-prefixed).
export const BLOCKED_PLAYLISTS_EMPTY_SENTINEL = '__none__';

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
      payment_has_playlist.qrLogo,
      payment_has_playlist.qrLogoScale,
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
      payment_has_playlist.theme,
      payment_has_playlist.themeName,
      payment_has_playlist.gamesEnabled,
      payment_has_playlist.allowDuplicates,
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
      payment_has_playlist.boxBackSelectedFont,
      payment_has_playlist.boxBackSelectedFontSize,
      payment_has_playlist.boxBackText,
      payment_has_playlist.boxFrontOpacity,
      payment_has_playlist.addHowToCard,
      payment_has_playlist.addHowToCardLocale,
      payment_has_playlist.howToCardImage,
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
  template?: string | null,
  theme?: string | null,
  themeName?: string | null,
  boxQuantity?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const updateData: any = {
      eco: eco,
      doubleSided: doubleSided,
    };

    if (printerType !== undefined) {
      updateData.printerType = printerType;
    }

    if (boxQuantity !== undefined) {
      updateData.boxQuantity = boxQuantity;
      updateData.boxEnabled = boxQuantity > 0;
    }

    if (theme !== undefined) {
      updateData.theme = theme;
    }

    if (themeName !== undefined) {
      updateData.themeName = themeName;
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

    // Reload the in-memory theme cache when theme data changed
    if (theme !== undefined || themeName !== undefined) {
      await deps.appTheme.reload();
    }

    deps.logger.log(
      color.blue.bold(
        `Updated playlist data for ${color.white.bold(
          paymentHasPlaylistId
        )} ${color.white.bold(
          JSON.stringify({ eco, doubleSided, printerType, template, theme, themeName, boxQuantity })
        )}`
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

export async function updatePlaylistDetails(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  numberOfTracks: number,
  appleStoreFront?: string | null
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

    const phpData: any = { numberOfTracks };
    if (appleStoreFront !== undefined) {
      phpData.appleStoreFront = appleStoreFront;
    }

    // Update both tables in a transaction
    await deps.prisma.$transaction([
      deps.prisma.paymentHasPlaylist.update({
        where: { id: paymentHasPlaylistId },
        data: phpData,
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

/** Admin-selectable product type, mapped to the underlying type/subType pair. */
export type ProductType = 'digital' | 'cards' | 'sheets';

const PRODUCT_TYPE_MAP: Record<
  ProductType,
  { type: string; subType: string; digital: boolean; orderTypeProduct: string }
> = {
  digital: { type: 'digital', subType: 'none', digital: true, orderTypeProduct: 'cards' },
  cards: { type: 'physical', subType: 'none', digital: false, orderTypeProduct: 'cards' },
  sheets: { type: 'physical', subType: 'sheets', digital: false, orderTypeProduct: 'sheets' },
};

/**
 * Changes the product type (digital / physical cards / physical sheets) of a
 * single order line item. Updates only the fields that depend on the type and
 * resets the now-stale printer/PDF state — prices are intentionally left
 * untouched. The caller is responsible for queueing PDF regeneration when
 * `changed` is true.
 */
export async function changePlaylistType(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  productType: ProductType
): Promise<{
  success: boolean;
  error?: string;
  paymentId?: string;
  changed?: boolean;
}> {
  try {
    const target = PRODUCT_TYPE_MAP[productType];
    if (!target) {
      return { success: false, error: `Invalid productType: ${productType}` };
    }

    const php = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: {
        id: true,
        paymentId: true,
        playlistId: true,
        type: true,
        subType: true,
        numberOfTracks: true,
        payment: { select: { paymentId: true } },
      },
    });

    if (!php) {
      return { success: false, error: 'PaymentHasPlaylist not found' };
    }

    const paymentIdString = php.payment.paymentId;

    // No-op: already the requested type.
    if (php.type === target.type && (php.subType || 'none') === target.subType) {
      return { success: true, paymentId: paymentIdString, changed: false };
    }

    // Unique constraint is @@unique([paymentId, playlistId, type, subType]) —
    // refuse if another line item for the same playlist already occupies it.
    const collision = await deps.prisma.paymentHasPlaylist.findFirst({
      where: {
        paymentId: php.paymentId,
        playlistId: php.playlistId,
        type: target.type,
        subType: target.subType,
        id: { not: paymentHasPlaylistId },
      },
      select: { id: true },
    });
    if (collision) {
      return {
        success: false,
        error: `This order already has a "${productType}" line item for the same playlist (#${collision.id}).`,
      };
    }

    // Re-look-up the OrderType categorization FK (no pricing involved). For
    // physical products fall back to the largest tier when the track count
    // exceeds every maxCards tier (mirrors Printer.getOrderType clamping).
    let orderType = await deps.prisma.orderType.findFirst({
      where: {
        type: target.orderTypeProduct,
        digital: target.digital,
        ...(target.digital ? {} : { maxCards: { gte: php.numberOfTracks } }),
      },
      orderBy: { maxCards: 'asc' },
      select: { id: true },
    });
    if (!orderType && !target.digital) {
      orderType = await deps.prisma.orderType.findFirst({
        where: { type: target.orderTypeProduct, digital: false },
        orderBy: { maxCards: 'desc' },
        select: { id: true },
      });
    }
    if (!orderType) {
      return {
        success: false,
        error: `No matching OrderType found for "${productType}" (${php.numberOfTracks} tracks).`,
      };
    }

    await deps.prisma.paymentHasPlaylist.update({
      where: { id: paymentHasPlaylistId },
      data: {
        type: target.type,
        subType: target.subType,
        orderTypeId: orderType.id,
        // Reset stale printer/PDF state — regeneration repopulates these.
        printApiUploaded: false,
        eligableForPrinter: false,
        eligableForPrinterAt: null,
        filename: null,
        filenameDigital: null,
      },
    });

    deps.logger.log(
      color.blue.bold(
        `Changed product type to ${color.white.bold(
          productType
        )} for paymentHasPlaylist ${color.white.bold(
          paymentHasPlaylistId
        )} (payment ${color.white.bold(paymentIdString)})`
      )
    );

    return { success: true, paymentId: paymentIdString, changed: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error changing product type for PaymentHasPlaylist ${color.white.bold(
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

export async function updateAllowDuplicates(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  allowDuplicates: boolean
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
      data: { allowDuplicates },
    });

    deps.logger.log(
      color.blue.bold(
        `Updated allowDuplicates for playlist ${color.white.bold(
          paymentHasPlaylistId
        )} to ${color.white.bold(allowDuplicates)}`
      )
    );

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating allowDuplicates for playlist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function updateAddHowToCard(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  addHowToCard: boolean,
  addHowToCardLocale?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const php = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: { id: true },
    });

    if (!php) {
      return { success: false, error: 'Playlist not found' };
    }

    const data: any = { addHowToCard };
    if (addHowToCardLocale !== undefined) {
      data.addHowToCardLocale = addHowToCardLocale;
    }

    await deps.prisma.paymentHasPlaylist.update({
      where: { id: paymentHasPlaylistId },
      data,
    });

    deps.logger.log(
      color.blue.bold(
        `Updated addHowToCard for playlist ${color.white.bold(
          paymentHasPlaylistId
        )} to ${color.white.bold(addHowToCard)}${addHowToCardLocale ? ` (locale: ${addHowToCardLocale})` : ''}`
      )
    );

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating addHowToCard for playlist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function updateHowToCardImage(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  howToCardImage: string | null
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
      data: { howToCardImage },
    });

    deps.logger.log(
      color.blue.bold(
        `Updated howToCardImage for playlist ${color.white.bold(
          paymentHasPlaylistId
        )} to ${color.white.bold(howToCardImage || '(cleared)')}`
      )
    );

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating howToCardImage for playlist ${color.white.bold(
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

export interface TrackOrderEntry {
  id: number;
  artist: string;
  name: string;
  year: number | null;
  order: number;
}

/**
 * Tracks of the playlist behind a paymentHasPlaylist, in playlist_has_tracks.order.
 */
export async function getPlaylistTrackOrder(
  deps: DataDeps,
  paymentHasPlaylistId: number
): Promise<{ success: boolean; error?: string; tracks?: TrackOrderEntry[] }> {
  try {
    const php = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: { playlistId: true },
    });

    if (!php) {
      return { success: false, error: 'PaymentHasPlaylist not found' };
    }

    const rows = await deps.prisma.playlistHasTrack.findMany({
      where: { playlistId: php.playlistId },
      // The composite key has no natural tiebreaker, so add trackId to keep the
      // order stable for playlists whose rows all still sit at the default 0.
      orderBy: [{ order: 'asc' }, { trackId: 'asc' }],
      select: {
        order: true,
        track: { select: { id: true, artist: true, name: true, year: true } },
      },
    });

    return {
      success: true,
      tracks: rows.map((row) => ({
        id: row.track.id,
        artist: row.track.artist,
        name: row.track.name,
        year: row.track.year,
        order: row.order,
      })),
    };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error loading track order for paymentHasPlaylist ${color.white.bold(
          paymentHasPlaylistId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

/**
 * Rewrites playlist_has_tracks.order to the given trackId sequence (0-based).
 * trackIds must be exactly the playlist's current tracks - a partial list would
 * silently leave the omitted rows on stale order values.
 *
 * Also flags the playlist as manually ordered, which stops regeneration from
 * rewriting the order back to the streaming service's (see storeTracks).
 */
export async function updatePlaylistTrackOrder(
  deps: DataDeps,
  paymentHasPlaylistId: number,
  trackIds: number[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const php = await deps.prisma.paymentHasPlaylist.findUnique({
      where: { id: paymentHasPlaylistId },
      select: { playlistId: true },
    });

    if (!php) {
      return { success: false, error: 'PaymentHasPlaylist not found' };
    }

    const existing = await deps.prisma.playlistHasTrack.findMany({
      where: { playlistId: php.playlistId },
      select: { trackId: true },
    });

    const existingIds = new Set(existing.map((row) => row.trackId));
    const submittedIds = new Set(trackIds);

    if (
      submittedIds.size !== trackIds.length ||
      submittedIds.size !== existingIds.size ||
      trackIds.some((id) => !existingIds.has(id))
    ) {
      return {
        success: false,
        error: 'Track list does not match the tracks on this playlist',
      };
    }

    await deps.prisma.$transaction([
      ...trackIds.map((trackId, index) =>
        deps.prisma.playlistHasTrack.update({
          where: {
            playlistId_trackId: { playlistId: php.playlistId, trackId },
          },
          data: { order: index },
        })
      ),
      deps.prisma.playlist.update({
        where: { id: php.playlistId },
        data: { manualTrackOrder: true },
      }),
    ]);

    deps.logger.log(
      color.blue.bold(
        `Updated track order for playlist ${color.white.bold(
          php.playlistId
        )} (${color.white.bold(trackIds.length)} tracks)`
      )
    );

    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating track order for paymentHasPlaylist ${color.white.bold(
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

    // Rebuild the set from the database and publish it, rather than
    // publishing this process's local set: a worker whose set is stale or
    // still uninitialized would otherwise overwrite the shared key (worst
    // case writing the empty sentinel while playlists are still blocked).
    const republished = await loadBlocked(deps);
    if (!republished) {
      return {
        success: false,
        error: 'Playlist updated but republishing the blocked list failed',
      };
    }
    deps.logger.log(
      color.green.bold('Updated blocked playlists in Redis cache')
    );

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

export async function loadBlocked(deps: DataDeps): Promise<boolean> {
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

    const blockedIds = Array.from(deps.blockedPlaylists).map(String);

    // Publish from whichever process loaded first so sibling workers (and
    // the hourly cache sync) never have to fall back to the database. The
    // publish is best-effort: a Redis-only outage must not discard a
    // successful DB load, or nothing could ever initialize the list.
    try {
      await deps.cache.setArray(
        BLOCKED_PLAYLISTS_CACHE_KEY,
        blockedIds.length > 0 ? blockedIds : [BLOCKED_PLAYLISTS_EMPTY_SENTINEL]
      );
    } catch (publishError: any) {
      deps.logger.log(
        color.red.bold(
          `Loaded blocked playlists but failed to publish to Redis: ${publishError.message}`
        )
      );
    }

    // Only log on the main/primary server
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

      if (blockedIds.length > 0) {
        deps.logger.log(
          color.green.bold(
            `Stored ${color.white.bold(
              blockedIds.length
            )} blocked playlists in Redis cache`
          )
        );
      }
    }

    return true;
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(`Error loading blocked playlists: ${error.message}`)
    );
    return false;
  }
}

export async function loadBlockedFromCache(deps: DataDeps): Promise<boolean> {
  try {
    const blockedIds = await deps.cache.getArray(BLOCKED_PLAYLISTS_CACHE_KEY);

    if (blockedIds && blockedIds.length > 0) {
      deps.blockedPlaylists.clear();
      for (const id of blockedIds) {
        if (id === BLOCKED_PLAYLISTS_EMPTY_SENTINEL) {
          continue;
        }
        deps.blockedPlaylists.add(parseInt(id, 10));
      }
      return true;
    }

    // Key absent (fresh Redis or version-bump deploy): load directly from
    // the database.
    return await loadBlocked(deps);
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error loading blocked playlists from cache: ${error.message}`
      )
    );
    // Redis is down but the database may be fine — fall back the same way
    // the key-absent path does. loadBlocked returns false if the DB is
    // also unreachable, preserving the retry chain.
    try {
      return await loadBlocked(deps);
    } catch {
      return false;
    }
  }
}

/** A single playlist entry in the MusicMatch export. */
export interface MusicMatchPlaylist {
  /** payment_has_playlist.id */
  i: number;
  /** playlist name */
  n: string;
  /** tracks */
  t: {
    /** track.id */
    i: number;
    /** Spotify track id */
    l: string;
    /** streaming service links, keyed by short service code */
    ln: Record<string, string>;
  }[];
}

/** The full MusicMatch export payload. */
export interface MusicMatchExport {
  h: true;
  /** generation time, unix seconds */
  t: number;
  /** playlists */
  p: MusicMatchPlaylist[];
}

/**
 * Builds the MusicMatch JSON export: every Spotify PaymentHasPlaylist whose
 * printerType is 'musicmatch', with its tracks and per-service links.
 */
export async function buildMusicMatchExport(
  deps: DataDeps
): Promise<MusicMatchExport> {
  const paymentPlaylists = await deps.prisma.paymentHasPlaylist.findMany({
    where: {
      printerType: PRINTER_TYPE.MUSICMATCH,
      playlist: { serviceType: 'spotify' },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      playlist: {
        select: {
          name: true,
          tracks: {
            orderBy: { order: 'asc' },
            select: {
              track: {
                select: {
                  id: true,
                  trackId: true,
                  spotifyLink: true,
                  youtubeMusicLink: true,
                  deezerLink: true,
                  appleMusicLink: true,
                  tidalLink: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const p: MusicMatchPlaylist[] = paymentPlaylists
    .map((php) => ({
      i: php.id,
      n: php.playlist.name,
      t: php.playlist.tracks
        .filter((pt) => pt.track && pt.track.trackId)
        .map((pt) => {
          const track = pt.track;
          const ln: Record<string, string> = {};
          if (track.spotifyLink) ln.sp = track.spotifyLink;
          if (track.appleMusicLink) ln.am = track.appleMusicLink;
          if (track.deezerLink) ln.dz = track.deezerLink;
          if (track.tidalLink) ln.td = track.tidalLink;
          if (track.youtubeMusicLink) ln.ym = track.youtubeMusicLink;
          return { i: track.id, l: track.trackId, ln };
        }),
    }))
    .filter((playlist) => playlist.t.length > 0);

  return {
    h: true,
    t: Math.floor(Date.now() / 1000),
    p,
  };
}
