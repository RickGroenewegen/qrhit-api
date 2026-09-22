import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Bookkeeping from './bookkeeping';
import { BookkeepingInvoice } from './bookkeeping/types';
import { PaymentOption } from './listPricing';

/**
 * The MoneyBird invoices of a company list, one per payment option.
 *
 * They are recorded by id in `company_list_invoices` when created here, and
 * looked up by that id. Finding them by reference (the list name) could not
 * tell two companies' lists of the same name apart, lost an invoice when the
 * list was renamed or the company's language changed, and fell back to the
 * first search result; each of those offered a customer a second invoice.
 * The reference search is still the fallback for invoices from before the
 * table, restricted to the company's own contact and to exact references,
 * and whatever it finds is recorded so it is found by id from then on.
 */

export type ListInvoices = Record<PaymentOption, BookkeepingInvoice | null>;

export const PAYMENT_OPTIONS: readonly PaymentOption[] = [
  'full',
  'down',
  'remaining',
];

export interface ListInvoiceReferences {
  full: string;
  down: string;
  remaining: string;
  legacyDown: string;
  legacyRemaining: string;
}

const logger = new Logger();

function log(level: 'blue' | 'green' | 'yellow' | 'red', text: string, param?: string) {
  const c = color[level].bold;
  logger.log(
    c('[') + white.bold('list invoices') + c('] ') + c(text) +
      (param != null ? white.bold(param) : '')
  );
}

/** The MoneyBird contact of a company is stored under this customer id. */
export function companyCustomerKey(companyId: number): string {
  return `qrhit-${companyId}`;
}

/**
 * The existing invoice that rules out creating `option`, or null. A full
 * invoice rules out everything; a down or remaining payment rules out the
 * full invoice and a second one of itself.
 */
export function blockingInvoice(
  existing: ListInvoices,
  option: PaymentOption
): BookkeepingInvoice | null {
  if (option === 'full') {
    return existing.full || existing.down || existing.remaining;
  }
  return existing.full || existing[option];
}

/** An invoice's total excl. VAT as a number, or null when it has none. */
export function invoiceExclVat(invoice: BookkeepingInvoice | null): number | null {
  if (!invoice || invoice.total_price_excl_tax == null) return null;
  const n = Number(invoice.total_price_excl_tax);
  return Number.isFinite(n) ? n : null;
}

export async function recordListInvoice(
  listId: number,
  option: PaymentOption,
  invoice: BookkeepingInvoice
): Promise<void> {
  if (invoice?.id == null) return;
  const data = {
    provider: Bookkeeping.getInstance().providerName(),
    externalId: String(invoice.id),
    invoiceNumber: invoice.invoice_id ?? null,
    reference: invoice.reference ?? null,
    totalExclVat: invoiceExclVat(invoice),
  };
  try {
    await (PrismaInstance.getInstance() as any).companyListInvoice.upsert({
      where: {
        companyListId_paymentOption: { companyListId: listId, paymentOption: option },
      },
      create: { companyListId: listId, paymentOption: option, ...data },
      update: data,
    });
  } catch (error: any) {
    // The invoice exists in MoneyBird either way; the reference fallback
    // still finds it while it is unrecorded.
    log('red', 'could not record invoice ', `list=${listId} ${option} id=${invoice.id}: ${error?.message || error}`);
  }
}

/**
 * Every invoice of the list that still exists in MoneyBird. Throws when
 * MoneyBird cannot be asked: the answer decides whether an admin may bill,
 * so an outage must not read as "nothing invoiced yet".
 */
export async function findListInvoices(args: {
  listId: number;
  companyId: number;
  references: ListInvoiceReferences;
}): Promise<ListInvoices> {
  const { listId, companyId, references } = args;
  const prisma = PrismaInstance.getInstance() as any;
  const bookkeeping = Bookkeeping.getInstance();
  const found: ListInvoices = { full: null, down: null, remaining: null };

  let rows: { id: number; paymentOption: string; externalId: string }[] = [];
  try {
    rows = await prisma.companyListInvoice.findMany({
      where: { companyListId: listId },
    });
  } catch (error: any) {
    // Until `prisma db push` has created the table the references are all
    // there is.
    log('yellow', 'recorded invoices unavailable, using references: ', error?.message || String(error));
  }

  for (const row of rows) {
    const option = row.paymentOption as PaymentOption;
    if (!PAYMENT_OPTIONS.includes(option)) continue;
    const invoice = await bookkeeping.getInvoice(row.externalId);
    if (invoice) {
      found[option] = invoice;
      continue;
    }
    // Deleted in MoneyBird: forget it, so that payment can be invoiced again.
    log('yellow', 'recorded invoice no longer exists, forgetting it: ', `list=${listId} ${option} id=${row.externalId}`);
    await prisma.companyListInvoice
      .delete({ where: { id: row.id } })
      .catch(() => undefined);
  }

  const missing = PAYMENT_OPTIONS.filter((o) => !found[o]);
  if (missing.length === 0) return found;

  // Every invoice created here went to this contact, so a company without
  // one has no invoices to find.
  const contact = await bookkeeping.findContactByCustomerKey(
    companyCustomerKey(companyId),
    { strict: true }
  );
  if (!contact?.id) return found;

  const candidates: Record<PaymentOption, string[]> = {
    full: [references.full],
    down: [references.down, references.legacyDown],
    remaining: [references.remaining, references.legacyRemaining],
  };
  await Promise.all(
    missing.map(async (option) => {
      for (const reference of candidates[option]) {
        const invoice = await bookkeeping.findInvoiceByReference(reference, {
          contactId: contact.id,
          strict: true,
        });
        if (invoice) {
          found[option] = invoice;
          await recordListInvoice(listId, option, invoice);
          return;
        }
      }
    })
  );
  return found;
}
