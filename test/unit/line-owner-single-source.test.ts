import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Who a set belongs to is decided in one place, src/lineOwner.ts: the line's
 * own owner (`payment_has_playlist.ownerUserId`, set when a gift voucher is
 * redeemed, src/gift.ts) and else the buyer. A check against the order's
 * buyer locks the recipient of a gift out of their own set, or lets the giver
 * keep using it.
 *
 * - A hash check (`u.hash = ${...}`) must join its user through
 *   `lineOwnerSql()` in the lines above it.
 * - Every other buyer check (`p.userId = u.id`, `p.userId = ${...}`,
 *   `.payment.userId`, `payment: { userId`) is listed below with the reason
 *   it is the buyer's on purpose. A listed line that is gone fails too, so
 *   the list stays the real one.
 */
const SRC = path.resolve(__dirname, '../../src');
const SINGLE_SOURCE = path.join(SRC, 'lineOwner.ts');
const OWNER_JOIN_WINDOW = 20;

const BUYER_CHECKS: RegExp[] = [
  /\b(p|pm|pay|payments)\.userId\s*=\s*(u|users)\.id\b/,
  /\b(p|pm|pay)\.userId\s*=\s*\$\{/,
  /\.payment\??\.userId\b/,
  /payment:\s*\{\s*userId\b/,
];
const HASH_CHECK = /\bu\.hash\s*=\s*\$\{/;

const ALLOWED: Record<string, string> = {
  'appDesign.ts: payment: { userId: number; status: string };':
    'the type of a line handed to ownsLine()',
  'mail.ts: payment: { userId?: number | null; locale?: string | null },':
    'the type of the payment giftedLineHolder() reads the holder against',
  'auth.ts: OR: [{ ownerUserId: id }, { ownerUserId: { not: null }, payment: { userId: id } }],':
    'deleteUserById refuses a giver whose sets were given away',
  'data/tracks.ts: AND (${userId} > 0 AND p.userId = ${userId} OR ${userId} = 0)':
    'getTracks only picks a deck id for QR links; callers that render a line pass its id',
  'routes/cardTemplateRoutes.ts: tracks = (await data.getTracks(line.playlistId, line.payment.userId, line.id)).slice(0, count);':
    'admin preview of a line; the line id is passed, so the userId picks nothing',
  'routes/boxRoutes.ts: if (php.ownerUserId !== null || php.payment.userId !== user.id) {':
    'a gift box is booked on the order, invoiced to and shipped to the buyer: buyer only, never on a given set',
  'promotional.ts: JOIN users u ON p.userId = u.id':
    'the promotional link rewards whoever made the playlist and bought it',
  'data/users.ts: LEFT JOIN   users ON payments.userId = users.id':
    'the checkout progress page shows the buyer their order; /progress closes once a set was given',
  'gift.ts: lines.some((line) => line.payment.paymentId !== paymentId || line.payment.userId !== giverUserId)':
    'only the buyer of an order puts its sets on a voucher',
  'gift.ts: if (line.payment.userId !== giverId || line.payment.id !== Number(voucher.paymentId)) {':
    'the redeem checks the set is still on the giver\'s order',
  'gift.ts: data: { userId: line.payment.userId },':
    'returning a set to its buyer gives the app design row back to the buyer',
};

// Hash checks against the buyer on purpose, with the reason
const ALLOWED_HASH_CHECKS: Record<string, string> = {
  'promotional.ts: AND u.hash = ${userHash}': 'the promotional link is the buyer\'s, see above',
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('line owner single source', () => {
  const buyerChecks: string[] = [];
  const unjoinedHashChecks: string[] = [];

  for (const file of sourceFiles(SRC)) {
    if (file === SINGLE_SOURCE) continue;
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const text = line.trim();
      if (BUYER_CHECKS.some((pattern) => pattern.test(text))) {
        buyerChecks.push(`${relative}: ${text}`);
      }
      if (HASH_CHECK.test(text)) {
        const above = lines.slice(Math.max(0, index - OWNER_JOIN_WINDOW), index).join('\n');
        if (!above.includes('lineOwnerSql(') && !(`${relative}: ${text}` in ALLOWED_HASH_CHECKS)) {
          unjoinedHashChecks.push(`${relative}:${index + 1}: ${text}`);
        }
      }
    });
  }

  it('checks a hash only against the line owner', () => {
    expect(unjoinedHashChecks).toEqual([]);
  });

  it('checks the buyer only where the list says why', () => {
    const unlisted = [...new Set(buyerChecks)].filter((hit) => !(hit in ALLOWED));
    expect(unlisted).toEqual([]);
  });

  it('lists no buyer check that is gone', () => {
    const found = new Set(buyerChecks);
    const stale = Object.keys(ALLOWED).filter((entry) => !found.has(entry));
    expect(stale).toEqual([]);
  });
});
