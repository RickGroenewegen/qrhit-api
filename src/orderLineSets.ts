import fs from 'fs/promises';
import PrismaInstance from './prisma';
import PrintEnBind from './printers/printenbind';
import { round2 } from './listPricing';

/**
 * Change the number of sets of one physical order line after payment (the qrsong toolkit's `order sets`; first:
 * Esther Brauhardt, 100009410, 2026-11-10, who wanted a second set of "Rock the Dancefloor" once her order was on
 * hold). The checkout's payment-address step does the same with its + and − before payment; this is that, after.
 *
 * A set is one `payment_has_playlist_item` row with its own printer PDF: Print&Bind gets one article per row
 * (printers/printenbindV2.ts createOrder). So raising `amount` adds rows; their PDFs are made by the printer pass's
 * own rebuild (Generator.rebuildStalePrinterPdfs → makeMissingSetPdfs), from the stored tracks and the current
 * design, without Spotify and without a mail. Lowering it deletes the rows above the new amount.
 *
 * Money: an added set costs today's list price for the line's card count (the price the checkout would show,
 * PrintEnBind.getOrderType), a removed set gives back what was paid per set (line price / amount). The difference
 * goes onto the line (price and its VAT split at the order's tax rate) and onto the payment's totals, like an
 * upgrade booked on its order (Mollie.bookUpgradeOnPayment); profit gets the ex-VAT share, provisional until the
 * printer's price of the new order books its cost. Shipping, discounts and fees stay. The customer pays the
 * difference separately (a payment link): this books it on the order so the invoice and the reports show it, and
 * the cached invoice PDF is deleted so the next download shows the new amount.
 *
 * Only on printer hold and not at the printer, so nothing sends the order while it changes; not for a line with
 * gift boxes (their insert PDF is made for boxQuantity × amount), a line given as a gift, or an express order.
 * Without `apply` it only answers what would change.
 */

export class LineSetsError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export const MAX_SETS = 10;

export interface SetsState {
  orderId: string;
  status: string;
  printerHold: boolean;
  sentToPrinter: boolean;
  printApiOrderId: string;
  fast: boolean;
  type: string;
  printerType: string;
  amount: number;
  boxEnabled: boolean;
  boxQuantity: number;
  gifted: boolean;
}

/** Why the sets of this line cannot become `amount`, or null when they can. */
export function setsRefusal(line: SetsState, amount: number): string | null {
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_SETS) return `amount must be a whole number from 1 to ${MAX_SETS}`;
  if (line.status !== 'paid') return `order ${line.orderId} is not paid (${line.status})`;
  if (line.type !== 'physical') return `this line is ${line.type}: only printed cards come in sets`;
  if (line.printerType !== 'printnbind') return `this line prints at ${line.printerType}: sets are for Print&Bind lines only`;
  if (line.sentToPrinter || line.printApiOrderId) {
    return `order ${line.orderId} is at the printer (${line.printApiOrderId || 'sent'}): cancel it at Print&Bind and run printer-reset first`;
  }
  if (!line.printerHold) return `put order ${line.orderId} on printer hold first, so nothing sends it while its sets change`;
  if (line.boxEnabled || line.boxQuantity > 0) return 'this line has gift boxes: their insert is made per set, change it by hand';
  if (line.gifted) return 'this line was given as a gift: its owner is someone else than the buyer';
  if (line.fast) return `order ${line.orderId} is an express order: its price has a surcharge per set, change it by hand`;
  if (amount === line.amount) return `the line already has ${amount} set${amount === 1 ? '' : 's'}`;
  return null;
}

export interface SetsPricing {
  /** Gross per set this change is priced at: today's list price up, the paid price per set down. */
  perSet: number;
  deltaGross: number;
  deltaExVat: number;
  deltaVat: number;
  line: { price: number; priceWithoutVAT: number; priceVAT: number; printApiPrice: number };
}

/** What the line and the payment get when `from` sets become `to`. */
export function setsPricing(input: {
  from: number;
  to: number;
  listPricePerSet: number;
  linePrice: number;
  printApiPrice: number;
  taxRate: number;
}): SetsPricing {
  const { from, to, taxRate } = input;
  const paidPerSet = from > 0 ? input.linePrice / from : 0;
  const perSet = round2(to > from ? input.listPricePerSet : paidPerSet);
  const deltaGross = round2(perSet * (to - from));
  const deltaExVat = round2(deltaGross / (1 + taxRate / 100));
  const price = round2(input.linePrice + deltaGross);
  const priceWithoutVAT = round2(price / (1 + taxRate / 100));
  return {
    perSet,
    deltaGross,
    deltaExVat,
    deltaVat: round2(deltaGross - deltaExVat),
    line: {
      price,
      priceWithoutVAT,
      priceVAT: round2(price - priceWithoutVAT),
      printApiPrice: from > 0 ? round2((input.printApiPrice / from) * to) : input.printApiPrice,
    },
  };
}

const PAYMENT_TOTALS = [
  'totalPrice',
  'totalPriceWithoutTax',
  'productPriceWithoutTax',
  'productVATPrice',
  'totalVATPrice',
  'profit',
] as const;

/** The payment's totals after a change of `pricing`. */
export function paymentTotalsAfter(payment: Record<(typeof PAYMENT_TOTALS)[number], number>, pricing: SetsPricing) {
  const plus = { totalPrice: pricing.deltaGross, totalPriceWithoutTax: pricing.deltaExVat, productPriceWithoutTax: pricing.deltaExVat };
  return {
    totalPrice: round2(payment.totalPrice + plus.totalPrice),
    totalPriceWithoutTax: round2(payment.totalPriceWithoutTax + plus.totalPriceWithoutTax),
    productPriceWithoutTax: round2(payment.productPriceWithoutTax + plus.productPriceWithoutTax),
    productVATPrice: round2(payment.productVATPrice + pricing.deltaVat),
    totalVATPrice: round2(payment.totalVATPrice + pricing.deltaVat),
    profit: round2(payment.profit + pricing.deltaExVat),
  };
}

type MakeSetPdfs = (paymentId: string) => Promise<any>;

export async function changeLineSets(
  lineId: number,
  input: { amount: number; apply: boolean },
  makeSetPdfs: MakeSetPdfs,
  listPrice: (numberOfTracks: number, playlistId: string, subType: 'sheets' | 'none') => Promise<number> = async (
    numberOfTracks,
    playlistId,
    subType
  ) => (await PrintEnBind.getInstance().getOrderType(numberOfTracks, false, 'cards', playlistId, subType)).amount
) {
  if (!Number.isInteger(lineId) || lineId <= 0) throw new LineSetsError('invalid line id');
  const prisma = PrismaInstance.getInstance();
  const line = await prisma.paymentHasPlaylist.findUnique({
    where: { id: lineId },
    include: {
      playlist: { select: { name: true, playlistId: true } },
      payment: true,
    },
  });
  if (!line) throw new LineSetsError(`no order line ${lineId}`, 404);
  const payment = line.payment;
  const amount = Number(input.amount);

  const refusal = setsRefusal(
    {
      orderId: String(payment.orderId),
      status: payment.status,
      printerHold: !!payment.printerHold,
      sentToPrinter: !!payment.sentToPrinter,
      printApiOrderId: payment.printApiOrderId || '',
      fast: !!payment.fast,
      type: line.type,
      printerType: line.printerType,
      amount: line.amount,
      boxEnabled: !!line.boxEnabled,
      boxQuantity: line.boxQuantity,
      gifted: line.ownerUserId != null && line.ownerUserId !== payment.userId,
    },
    amount
  );
  if (refusal) throw new LineSetsError(refusal, /must be|already has/.test(refusal) ? 400 : 409);
  if (payment.taxRate == null) throw new LineSetsError(`order ${payment.orderId} has no tax rate`, 409);

  const subType = line.subType === 'sheets' ? 'sheets' : 'none';
  const pricing = setsPricing({
    from: line.amount,
    to: amount,
    listPricePerSet: amount > line.amount ? await listPrice(line.numberOfTracks, line.playlist.playlistId, subType) : 0,
    linePrice: line.price,
    printApiPrice: line.printApiPrice,
    taxRate: payment.taxRate,
  });
  if (amount > line.amount && !(pricing.perSet > 0)) throw new LineSetsError('no list price for this line', 502);

  const totalsBefore = Object.fromEntries(PAYMENT_TOTALS.map((k) => [k, payment[k]])) as Record<(typeof PAYMENT_TOTALS)[number], number>;
  const totalsAfter = paymentTotalsAfter(totalsBefore, pricing);
  const items = await prisma.paymentHasPlaylistItem.findMany({
    where: { paymentHasPlaylistId: lineId },
    orderBy: { index: 'asc' },
    select: { id: true, index: true, filename: true },
  });
  const notes: string[] = [];
  if (payment.discount > 0 || payment.volumeDiscount > 0 || payment.discountPercentAmount > 0) {
    notes.push(`the order had a discount (€${round2(payment.discount + payment.volumeDiscount + payment.discountPercentAmount)}); the change is at the set price without it`);
  }
  if (!items.length) notes.push('the line has no set rows yet (its cards were never generated)');
  const summary = {
    orderId: payment.orderId,
    paymentId: payment.paymentId,
    lineId,
    name: line.playlist.name,
    numberOfTracks: line.numberOfTracks,
    sets: { from: line.amount, to: amount },
    taxRate: payment.taxRate,
    price: {
      perSet: pricing.perSet,
      basis: amount > line.amount ? 'list price per set today' : 'paid per set',
      difference: pricing.deltaGross,
      differenceWithoutVAT: pricing.deltaExVat,
      differenceVAT: pricing.deltaVat,
    },
    line: {
      before: { amount: line.amount, price: line.price, priceWithoutVAT: line.priceWithoutVAT, priceVAT: line.priceVAT, printApiPrice: line.printApiPrice },
      after: { amount, ...pricing.line },
    },
    payment: { before: totalsBefore, after: totalsAfter },
    setRows: items.map((item) => ({ index: item.index, hasPdf: !!item.filename })),
    notes,
  };
  if (!input.apply) return { ...summary, applied: false };

  const increment = Object.fromEntries(
    PAYMENT_TOTALS.map((k) => [k, { increment: round2(totalsAfter[k] - totalsBefore[k]) }])
  );
  await prisma.$transaction(async (tx) => {
    // Guards: nobody changed the amount or sent the order since the check above
    const changed = await tx.paymentHasPlaylist.updateMany({
      where: { id: lineId, amount: line.amount },
      data: { amount, ...pricing.line },
    });
    if (changed.count !== 1) throw new LineSetsError(`line ${lineId} changed meanwhile: run it again`, 409);
    const paid = await tx.payment.updateMany({
      where: { id: payment.id, printerHold: true, sentToPrinter: false, printApiOrderId: payment.printApiOrderId },
      data: increment,
    });
    if (paid.count !== 1) throw new LineSetsError(`order ${payment.orderId} changed meanwhile: run it again`, 409);
    if (items.length && amount > line.amount) {
      await tx.paymentHasPlaylistItem.createMany({
        data: Array.from({ length: amount - line.amount }, (_, i) => ({ paymentHasPlaylistId: lineId, index: line.amount + i + 1 })),
        skipDuplicates: true,
      });
    }
    if (amount < line.amount) {
      await tx.paymentHasPlaylistItem.deleteMany({ where: { paymentHasPlaylistId: lineId, index: { gt: amount } } });
    }
  });

  // The invoice PDF is cached on first download; without it the next one is made from the new figures
  await fs.unlink(`${process.env['PRIVATE_DIR']}/invoice/${payment.paymentId}.pdf`).catch(() => undefined);

  // The change is booked; a PDF that fails here is made again by `rebuild-printer-pdfs` or the send itself
  let made: any = null;
  if (items.length && amount > line.amount) {
    try {
      made = await makeSetPdfs(payment.paymentId);
    } catch (error: any) {
      notes.push(`the new set's PDF failed (${error?.message ?? error}): run rebuild-printer-pdfs`);
    }
  }
  const rows = await prisma.paymentHasPlaylistItem.findMany({
    where: { paymentHasPlaylistId: lineId },
    orderBy: { index: 'asc' },
    select: { index: true, filename: true },
  });
  return {
    ...summary,
    applied: true,
    setRows: rows.map((row) => ({ index: row.index, filename: row.filename })),
    rebuild: made,
  };
}
