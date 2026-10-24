import { Prisma, PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';

/**
 * Who holds an order line (a "set"). Normally the order's buyer,
 * `payments.userId`; once a gift voucher for the line is redeemed, the
 * recipient, `payment_has_playlist.ownerUserId` (src/gift.ts). The order
 * itself (invoice, ledger, order mails) stays the buyer's either way.
 *
 * Every check of "may this user touch this set" goes through here, so a
 * redeemed gift moves downloads, corrections, designs, games and app designs
 * in one go. test/unit/line-owner-single-source.test.ts fails on a new check
 * that reads payments.userId directly.
 */

export interface LineOwnerFields {
  ownerUserId: number | null;
  payment: { userId: number };
}

export function lineOwnerId(line: LineOwnerFields): number {
  return line.ownerUserId ?? line.payment.userId;
}

export function ownsLine(line: LineOwnerFields, userId: number): boolean {
  return lineOwnerId(line) === userId;
}

/** True when the line has changed hands (a redeemed gift). */
export function isGiftedLine(line: { ownerUserId: number | null }): boolean {
  return line.ownerUserId !== null;
}

/** Prisma filter for the lines a user holds. */
export function ownedLinesWhere(
  userId: number
): Prisma.PaymentHasPlaylistWhereInput {
  return {
    OR: [{ ownerUserId: userId }, { ownerUserId: null, payment: { userId } }],
  };
}

/**
 * The owner's user id in raw SQL, for `JOIN users u ON u.id = ${lineOwnerSql()}`.
 * The aliases are the query's own names for payment_has_playlist and payments.
 */
export function lineOwnerSql(php = 'php', pay = 'pm'): Prisma.Sql {
  if (!/^\w+$/.test(php) || !/^\w+$/.test(pay)) {
    throw new Error('lineOwnerSql: invalid alias');
  }
  return Prisma.raw(`COALESCE(${php}.ownerUserId, ${pay}.userId)`);
}

export interface OwnedLine {
  /** payment_has_playlist.id */
  id: number;
  paymentDbId: number;
  /** The Mollie id (payments.paymentId) */
  paymentId: string;
  playlistDbId: number;
  playlistId: string;
  type: string;
  subType: string | null;
  ownerUserId: number | null;
  /** The buyer: payments.userId */
  buyerId: number;
  owner: {
    id: number;
    hash: string;
    email: string;
    displayName: string;
    locale: string | null;
  };
  /** The line has changed hands (a redeemed gift) */
  gifted: boolean;
}

function toOwnedLine(row: any): OwnedLine {
  return {
    id: Number(row.id),
    paymentDbId: Number(row.paymentDbId),
    paymentId: row.paymentId,
    playlistDbId: Number(row.playlistDbId),
    playlistId: row.playlistId,
    type: row.type,
    subType: row.subType ?? null,
    ownerUserId: row.ownerUserId === null ? null : Number(row.ownerUserId),
    buyerId: Number(row.buyerId),
    owner: {
      id: Number(row.ownerId),
      hash: row.ownerHash,
      email: row.ownerEmail,
      displayName: row.ownerName,
      locale: row.ownerLocale ?? null,
    },
    gifted: row.ownerUserId !== null,
  };
}

const OWNED_LINE_COLUMNS = Prisma.sql`
  php.id, php.type, php.subType, php.ownerUserId,
  pm.id AS paymentDbId, pm.paymentId, pm.userId AS buyerId,
  pl.id AS playlistDbId, pl.playlistId,
  u.id AS ownerId, u.hash AS ownerHash, u.email AS ownerEmail,
  u.displayName AS ownerName, u.locale AS ownerLocale`;

/**
 * The paid line a mailed link points at: the order's Mollie id, the
 * playlist's streaming id and the hash of whoever holds the line now. A
 * giver's links stop working once the gift is redeemed, and the recipient's
 * work. `type` narrows it when an order holds the playlist twice (digital and
 * physical).
 */
export async function findLineByHash(
  paymentId: string,
  userHash: string,
  playlistId: string,
  options: {
    type?: string;
    subType?: string;
    db?: PrismaClient | Prisma.TransactionClient;
  } = {}
): Promise<OwnedLine | null> {
  const db = options.db ?? PrismaInstance.getInstance();
  const typeFilter = options.type
    ? Prisma.sql`AND php.type = ${options.type}`
    : Prisma.empty;
  const subTypeFilter = options.subType
    ? Prisma.sql`AND php.subType = ${options.subType}`
    : Prisma.empty;
  const rows: any[] = await db.$queryRaw`
    SELECT ${OWNED_LINE_COLUMNS}
    FROM payments pm
    INNER JOIN payment_has_playlist php ON php.paymentId = pm.id
    INNER JOIN playlists pl ON pl.id = php.playlistId
    INNER JOIN users u ON u.id = ${lineOwnerSql()}
    WHERE pm.paymentId = ${paymentId}
      AND pl.playlistId = ${playlistId}
      AND u.hash = ${userHash}
      AND pm.status = 'paid'
      ${typeFilter}
      ${subTypeFilter}
    ORDER BY php.id
    LIMIT 1`;
  return rows.length ? toOwnedLine(rows[0]) : null;
}

/** The line, when `userId` holds it (any payment status). */
export async function findOwnedLine(
  userId: number,
  paymentHasPlaylistId: number,
  db: PrismaClient | Prisma.TransactionClient = PrismaInstance.getInstance()
): Promise<OwnedLine | null> {
  const rows: any[] = await db.$queryRaw`
    SELECT ${OWNED_LINE_COLUMNS}
    FROM payment_has_playlist php
    INNER JOIN payments pm ON pm.id = php.paymentId
    INNER JOIN playlists pl ON pl.id = php.playlistId
    INNER JOIN users u ON u.id = ${lineOwnerSql()}
    WHERE php.id = ${paymentHasPlaylistId}
      AND u.id = ${userId}
    LIMIT 1`;
  return rows.length ? toOwnedLine(rows[0]) : null;
}

/** The line and its holder, whoever that is. */
export async function findLineWithOwner(
  paymentHasPlaylistId: number,
  db: PrismaClient | Prisma.TransactionClient = PrismaInstance.getInstance()
): Promise<OwnedLine | null> {
  const rows: any[] = await db.$queryRaw`
    SELECT ${OWNED_LINE_COLUMNS}
    FROM payment_has_playlist php
    INNER JOIN payments pm ON pm.id = php.paymentId
    INNER JOIN playlists pl ON pl.id = php.playlistId
    INNER JOIN users u ON u.id = ${lineOwnerSql()}
    WHERE php.id = ${paymentHasPlaylistId}
    LIMIT 1`;
  return rows.length ? toOwnedLine(rows[0]) : null;
}
