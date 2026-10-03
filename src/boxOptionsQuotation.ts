import crypto from 'crypto';
import fs from 'fs/promises';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import Translation from './translation';
import Logger from './logger';
import PDF from './pdf';
import { quotationVatContext, normalizeCountryIso } from './services/vat';
import {
  BoxOption,
  priceBoxOptions,
} from './services/boxOptionsPricing';

/**
 * One quotation that offers the QRSong! Box in all three sizes (48, 96 and
 * 192 cards) side by side for one quantity; the client ticks the one they
 * want. Stored like any quotation (company_quotations, the PDF archived under
 * PRIVATE_DIR/quotation), with variant 'schneider-options' and the three
 * priced options in `payload`. The Lambda renders it from
 * GET /vibe/quotation-options/:quotationNumber?sig=..., which reads the stored
 * row, so a re-render always prints the prices that were quoted.
 */

export const BOX_OPTIONS_VARIANT = 'schneider-options';

const logger = new Logger();
const translation = new Translation();

/** The option the quotation row's single total stands for. */
const HEADLINE_CARDS = 96;

export function quotationSignature(quotationNumber: string): string {
  return crypto
    .createHmac('sha256', process.env['JWT_SECRET'] || 'qrsong')
    .update(`quotation-options:${quotationNumber}`)
    .digest('hex')
    .slice(0, 32);
}

export function verifyQuotationSignature(quotationNumber: string, sig: unknown): boolean {
  if (typeof sig !== 'string' || sig.length !== 32) return false;
  const expected = Buffer.from(quotationSignature(quotationNumber));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export interface BoxOptionsPayload {
  options: BoxOption[];
  contactUserId: number | null;
  isReseller: boolean;
  quoteRequestId: number | null;
}

export function parseBoxOptionsPayload(payload: string | null | undefined): BoxOptionsPayload | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed?.options) ? parsed : null;
  } catch {
    return null;
  }
}

export function quotationOptionsSummary(quotation: any) {
  const payload = parseBoxOptionsPayload(quotation?.payload);
  return {
    id: quotation.id,
    quotationNumber: quotation.quotationNumber,
    quantity: quotation.quantity,
    createdAt: quotation.createdAt,
    options: (payload?.options ?? []).map((o) => ({
      cards: o.cards,
      pricePerBox: o.pricePerBox,
      total: o.total,
    })),
  };
}

export async function createBoxOptionsQuotation(params: {
  companyId: number;
  quantity: number;
  contactUserId?: number | null;
  listId?: number | null;
  isReseller?: boolean;
  createdBy?: string | null;
  quoteRequestId?: number | null;
}): Promise<{ quotation: any; options: BoxOption[]; pdf: Buffer; filename: string }> {
  const prisma = PrismaInstance.getInstance();
  const company = await prisma.company.findUnique({ where: { id: params.companyId } });
  if (!company) throw new Error('Company not found');

  const options = await priceBoxOptions(params.quantity, { isReseller: !!params.isReseller });

  let contactUserId: number | null = null;
  if (params.contactUserId) {
    const contact = await prisma.user.findFirst({
      where: { id: params.contactUserId, companyId: company.id },
      select: { id: true },
    });
    contactUserId = contact?.id ?? null;
  }

  let listId: number | null = null;
  let listName: string | null = null;
  if (params.listId) {
    const list = await prisma.companyList.findUnique({
      where: { id: params.listId },
      select: { id: true, companyId: true, name: true },
    });
    if (list && list.companyId === company.id) {
      listId = list.id;
      listName = list.name;
    }
  }

  const locale = translation.resolveBusinessLocale(company.locale);
  const headline = options.find((o) => o.cards === HEADLINE_CARDS) ?? options[0];
  const quotationNumber = `QRS${Date.now().toString().slice(-8)}`;
  const payload: BoxOptionsPayload = {
    options,
    contactUserId,
    isReseller: !!params.isReseller,
    quoteRequestId: params.quoteRequestId ?? null,
  };

  const quotation = await prisma.quotation.create({
    data: {
      quotationNumber,
      companyId: company.id,
      listId,
      listName,
      userEmail: params.createdBy ?? null,
      variant: BOX_OPTIONS_VARIANT,
      quantity: params.quantity,
      numberOfCards: null,
      totalAmount: headline.total,
      clientPaysTotal: headline.total,
      ourProfit: headline.ourProfit,
      isReseller: !!params.isReseller,
      locale,
      payload: JSON.stringify(payload),
    },
  });

  const quotationDir = `${process.env['PRIVATE_DIR']}/quotation`;
  const filePath = `${quotationDir}/${quotationNumber}.pdf`;
  const baseUrl = process.env['API_URI'] || 'http://localhost:3004';
  const htmlUrl = `${baseUrl}/vibe/quotation-options/${quotationNumber}?sig=${quotationSignature(quotationNumber)}`;

  try {
    await fs.mkdir(quotationDir, { recursive: true });
    logger.log(
      color.blue.bold('Generating three-size quotation ') +
        white.bold(quotationNumber) +
        color.blue.bold(' for ') +
        white.bold(company.name)
    );
    await new PDF().generateFromUrl(htmlUrl, filePath, {
      format: 'a4',
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
    });
  } catch (error) {
    // No PDF, no quotation: the row would point at a file that is not there.
    await prisma.quotation.delete({ where: { id: quotation.id } }).catch(() => undefined);
    throw error;
  }

  const pdf = await fs.readFile(filePath);
  const quotationT = await translation.getBusinessTranslator(locale, 'quotation');
  const filename = `${quotationT('fileName')}_${company.name.replace(/[^a-zA-Z0-9]/g, '_')}_${quotationNumber}.pdf`;
  return { quotation, options, pdf, filename };
}

/** Everything box_options_quotation.ejs needs, read from the stored row. */
export async function boxOptionsQuotationView(quotationNumber: string): Promise<Record<string, any> | null> {
  const prisma = PrismaInstance.getInstance();
  const quotation = await prisma.quotation.findUnique({ where: { quotationNumber } });
  if (!quotation || quotation.variant !== BOX_OPTIONS_VARIANT) return null;
  const payload = parseBoxOptionsPayload(quotation.payload);
  const stored = await prisma.company.findUnique({ where: { id: quotation.companyId } });
  if (!payload || !stored) return null;

  // Addressed to the chosen contact, like the single-size quotation.
  const company: any = { ...stored };
  if (payload.contactUserId) {
    const contact = await prisma.user.findFirst({
      where: { id: payload.contactUserId, companyId: stored.id },
      select: { displayName: true, email: true, phone: true },
    });
    if (contact) {
      company.contact = contact.displayName || contact.email;
      company.contactemail = contact.email;
      company.contactphone = contact.phone || stored.contactphone || null;
    }
  }

  const locale = translation.resolveBusinessLocale(quotation.locale || company.locale);
  const intlTag = translation.getIntlTag(locale);
  const t = await translation.getBusinessTranslator(locale, 'quotation');
  const vatContext = quotationVatContext(company.countrycode);
  const countryNames = await translation.getTranslationsByPrefix(locale, 'countries');
  const iso = normalizeCountryIso(company.countrycode);
  const companyCountryName = (iso && countryNames?.[iso]) || company.countrycode || '';

  const options = payload.options.map((o) => {
    const vat = Math.round(o.total * (vatContext.rate / 100) * 100) / 100;
    return { ...o, vat, totalIncl: Math.round((o.total + vat) * 100) / 100 };
  });

  const created = new Date(quotation.createdAt);
  return {
    locale,
    t,
    company,
    companyCountryName,
    vatContext,
    quotationNumber,
    quantity: quotation.quantity,
    options,
    createdAt: created,
    validUntil: new Date(created.getTime() + 30 * 24 * 60 * 60 * 1000),
    baseUrl: process.env['API_URI'] || 'http://localhost:3004',
    formatDate: (date: Date) =>
      date.toLocaleDateString(intlTag, { year: 'numeric', month: 'long', day: 'numeric' }),
    formatCurrency: (value: number) =>
      new Intl.NumberFormat(intlTag, { style: 'currency', currency: 'EUR' }).format(value),
    formatNumber: (value: number) => value.toLocaleString(intlTag),
  };
}
