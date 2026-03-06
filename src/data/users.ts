import { color } from 'console-log-colors';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import PrintEnBind from '../printers/printenbind';
import { DataDeps } from './types';

export const euCountryCodes: string[] = [
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czech Republic
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
];

export async function storeUser(deps: DataDeps, userParams: any): Promise<number> {
  let userDatabaseId: number = 0;

  // Check if the user exists. If not, create it
  const user = await deps.prisma.user.findUnique({
    where: {
      email: userParams.email,
    },
  });

  if (!user) {
    // create the user
    const hash = crypto.randomBytes(8).toString('hex').slice(0, 16);

    const userCreate = await deps.prisma.user.create({
      data: {
        userId: userParams.userId,
        email: userParams.email,
        displayName: userParams.displayName,
        locale: userParams.locale,
        hash: hash,
        sync: true,
      },
    });
    userDatabaseId = userCreate.id;
  } else {
    // Update the display name. Since they might have been created with a temporary name in the newsletter
    await deps.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        displayName: userParams.displayName,
      },
    });
    userDatabaseId = user.id;
  }
  return userDatabaseId;
}

export async function getUser(deps: DataDeps, id: number): Promise<any> {
  const user = await deps.prisma.user.findUnique({
    where: {
      id,
    },
  });
  return user;
}

export async function getUserByUserId(deps: DataDeps, userId: string): Promise<any> {
  const user = await deps.prisma.user.findUnique({
    where: {
      userId,
    },
  });
  return user;
}

export async function getPayment(deps: DataDeps, paymentId: string, playlistId: string): Promise<any> {
  const paymentDetails: any[] = await deps.prisma.$queryRaw`
      SELECT      payments.id,
                  payments.orderId,
                  payments.createdAt,
                  payments.fullname,
                  payments.email,
                  payments.address,
                  payments.housenumber,
                  payments.city,
                  payments.zipcode,
                  payments.countryCode,
                  payments.status,
                  payments.differentInvoiceAddress,
                  payments.invoiceAddress,
                  payments.invoiceHousenumber,
                  payments.invoiceCity,
                  payments.invoiceZipcode,
                  payments.invoiceCountrycode,
                  users.hash AS userHash,
                  CASE
                    WHEN EXISTS (
                      SELECT 1
                      FROM payment_has_playlist
                      WHERE payment_has_playlist.paymentId = payments.id
                      AND payment_has_playlist.type = 'physical'
                    ) THEN 'physical'
                    ELSE 'digital'
                  END AS orderType
      FROM        payments
      LEFT JOIN   users ON payments.userId = users.id
      WHERE       payments.paymentId = ${paymentId}`;

  const connectedPlaylists: any[] = await deps.prisma.$queryRaw`
      SELECT      playlists.id,
                  playlists.playlistId,
                  playlists.numberOfTracks,
                  payment_has_playlist.amount,
                  payment_has_playlist.type,
                  payment_has_playlist.subType,
                  payment_has_playlist.gamesEnabled,
                  playlists.name AS playlistName,
                  playlists.type AS productType,
                  playlists.giftcardAmount,
                  playlists.featured
      FROM        payment_has_playlist
      INNER JOIN  playlists ON payment_has_playlist.playlistId = playlists.id
      WHERE       payment_has_playlist.paymentId = ${paymentDetails[0].id}`;

  return {
    payment: paymentDetails[0],
    playlists: connectedPlaylists,
    userHash: paymentDetails[0]?.userHash || null,
  };
}

export async function verifyPayment(deps: DataDeps, paymentId: string) {
  // Get all the playlist IDs (The real spotify one) for the checked payments
  const playlists = await deps.prisma.$queryRaw<any[]>`
    SELECT pl.playlistId, p.userId
    FROM payments p
    JOIN payment_has_playlist php ON php.paymentId = p.id
    JOIN playlists pl ON pl.id = php.playlistId
    WHERE p.paymentId = ${paymentId}
  `;

  // Loop through all the playlist IDs and verify them
  for (const playlist of playlists) {
    await deps.openai.verifyList(playlist.userId, playlist.playlistId);
  }
}

export async function checkUnfinalizedPayments(deps: DataDeps): Promise<string[]> {
  const unfinalizedPayments = await deps.prisma.payment.findMany({
    where: {
      finalized: false,
      status: 'paid',
    },
    select: {
      id: true,
      paymentId: true,
    },
  });

  const checkedPaymentIds: string[] = [];

  for (const payment of unfinalizedPayments) {
    const allChecked = await areAllTracksManuallyChecked(
      deps,
      payment.paymentId
    );

    if (allChecked) {
      checkedPaymentIds.push(payment.paymentId);
      deps.logger.log(
        color.green.bold(
          `Payment ${color.white.bold(
            payment.paymentId
          )} has all tracks manually checked`
        )
      );
    }
  }

  // Get all the playlist IDs (The real spotify one) for the checked payments
  if (checkedPaymentIds.length > 0) {
    const playlistIds = await deps.prisma.$queryRaw<string[]>`
      SELECT pl.playlistId
      FROM payments p
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      WHERE p.paymentId IN (${Prisma.join(checkedPaymentIds)})
    `;

    // Clear cache for each playlist
    for (const playlistId of playlistIds) {
      await deps.cache.del('tracks_' + playlistId);
      await deps.cache.del('trackcount_' + playlistId);
    }
  }

  return checkedPaymentIds;
}

export async function areAllTracksManuallyChecked(
  deps: DataDeps,
  paymentId: string
): Promise<boolean> {
  const result = await deps.prisma.$queryRaw<[{ uncheckedCount: bigint }]>`
    SELECT COUNT(*) as uncheckedCount
    FROM payments p
    JOIN payment_has_playlist php ON php.paymentId = p.id
    JOIN playlists pl ON pl.id = php.playlistId
    JOIN playlist_has_tracks pht ON pht.playlistId = pl.id
    JOIN tracks t ON t.id = pht.trackId
    WHERE p.paymentId = ${paymentId}
    AND (t.manuallyChecked = false OR t.year = 0 OR (t.spotifyLink IS NULL AND t.spotifyLinkIgnore = false))
  `;

  deps.logger.log(
    color.blue.bold(
      `Payment ${color.white.bold(paymentId)} has ${color.white.bold(
        result[0].uncheckedCount
      )} unchecked tracks left`
    )
  );

  const uncheckedCount = Number(result[0].uncheckedCount);
  const allChecked = uncheckedCount === 0;

  return allChecked;
}

export async function getTaxRate(
  deps: DataDeps,
  countryCode: string,
  date: Date = new Date()
): Promise<number | null> {
  if (!euCountryCodes.includes(countryCode)) {
    return 0; // Default NL
  }

  const taxRates = await deps.prisma.taxRate.findMany({
    where: {
      OR: [
        {
          startDate: {
            lte: date,
          },
          endDate: {
            gte: date,
          },
        },
        {
          startDate: {
            lte: date,
          },
          endDate: null,
        },
        {
          startDate: null,
          endDate: {
            gte: date,
          },
        },
        {
          startDate: null,
          endDate: null,
        },
      ],
    },
    orderBy: {
      startDate: 'desc',
    },
  });

  if (taxRates.length === 0) {
    return null;
  }

  return taxRates[0].rate;
}

export async function updatePaymentPrinterHold(
  deps: DataDeps,
  paymentId: string,
  printerHold: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const payment = await deps.prisma.payment.findUnique({
      where: { paymentId },
      select: { id: true },
    });

    if (!payment) {
      return { success: false, error: 'Payment not found' };
    }

    await deps.prisma.payment.update({
      where: { paymentId },
      data: { printerHold },
    });

    deps.logger.log(
      color.blue.bold(
        `Updated printer hold for payment ${color.white.bold(
          paymentId
        )} to ${color.white.bold(printerHold)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating printer hold for payment ${color.white.bold(
          paymentId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}

export async function updatePaymentExpress(
  deps: DataDeps,
  paymentId: string,
  fast: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const payment = await deps.prisma.payment.findUnique({
      where: { paymentId },
      select: { id: true, printApiOrderId: true },
    });

    if (!payment) {
      return { success: false, error: 'Payment not found' };
    }

    await deps.prisma.payment.update({
      where: { paymentId },
      data: { fast },
    });

    // If there's a PrintEnBind order, update the production method
    if (payment.printApiOrderId && payment.printApiOrderId !== '') {
      const printenbind = PrintEnBind.getInstance();
      await printenbind.updateProductionMethod(
        payment.printApiOrderId,
        fast ? 'fast' : 'standard'
      );
    }

    deps.logger.log(
      color.blue.bold(
        `Updated express for payment ${color.white.bold(
          paymentId
        )} to ${color.white.bold(fast)}`
      )
    );
    return { success: true };
  } catch (error: any) {
    deps.logger.log(
      color.red.bold(
        `Error updating express for payment ${color.white.bold(
          paymentId
        )}: ${error.message}`
      )
    );
    return { success: false, error: error.message };
  }
}
