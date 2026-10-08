import crypto from 'crypto';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import Business from './business';
import Utils from './utils';
import Mail from './mail';
import PushoverClient from './pushover';
import Translation from './translation';
import Logger from './logger';
import {
  BRAND_KIT_EXTENSIONS,
  IncomingFile,
  isAllowedExtension,
  saveCompanyFile,
  toFileDto,
} from './companyFiles';
import { MIN_BUSINESS_BOXES } from './services/boxPricing';

/**
 * Quote requests from the /business form: the visitor leaves their details,
 * website and brand kit and is promised a box design and a quotation within
 * 24 hours. A request lives on the lead's company; boxd (skill-box-designer)
 * lists the open ones, starts one (status in_progress), uploads the designs
 * (design_ready), and the admin mails design and quotation from the
 * company's Assets tab (sent). The quotations are made per box size with
 * qquote. The three-size quotation the API used to make for a request
 * (POST /business/quote-requests/:id/quotation) was removed on 2026-10-06 at
 * Rick's request; `quotationId` still points at the ones made before.
 */

export const QUOTE_REQUEST_STATUSES = [
  'open',
  'in_progress',
  'design_ready',
  'sent',
  'closed',
] as const;

export const BRAND_KIT_MAX_FILES = 5;
export const BRAND_KIT_MAX_BYTES = 20 * 1024 * 1024;

export type QuoteRequestErrorCode =
  | 'missing_fields'
  | 'quantity_min'
  | 'captcha'
  | 'spam'
  | 'file_type'
  | 'file_size'
  | 'too_many_files'
  | 'not_found'
  | 'invalid_status';

export class QuoteRequestError extends Error {
  constructor(
    public code: QuoteRequestErrorCode,
    message: string,
    public statusCode = 400
  ) {
    super(message);
  }
}

export interface QuoteRequestForm {
  fullname?: string;
  company?: string;
  email?: string;
  phone?: string;
  website?: string;
  brandKitUrl?: string;
  quantity?: string | number;
  message?: string;
  locale?: string;
  captchaToken?: string;
  honeypot?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const logger = new Logger();

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** A link the visitor typed, with https:// added when they left it out; null when it is not a web address. */
export function normalizeUrl(value: unknown, max: number): string | null {
  const raw = text(value, max);
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString().slice(0, max);
  } catch {
    return null;
  }
}

export interface ValidQuoteRequest {
  fullname: string;
  company: string;
  email: string;
  phone: string | null;
  website: string | null;
  brandKitUrl: string | null;
  quantity: number;
  message: string | null;
  locale: string;
}

/** Field and file checks, before anything is stored. */
export function validateQuoteRequest(
  form: QuoteRequestForm,
  files: IncomingFile[],
  isValidLocale: (locale: string) => boolean
): ValidQuoteRequest {
  const fullname = text(form.fullname, 190);
  const company = text(form.company, 190);
  const email = text(form.email, 190).toLowerCase();
  if (!fullname || !company || !email || !EMAIL_PATTERN.test(email)) {
    throw new QuoteRequestError('missing_fields', 'Name, company and a valid e-mail are required');
  }
  const quantity = Number(form.quantity);
  if (!Number.isInteger(quantity) || quantity < MIN_BUSINESS_BOXES) {
    throw new QuoteRequestError('quantity_min', `The minimum is ${MIN_BUSINESS_BOXES} boxes`);
  }
  if (files.length > BRAND_KIT_MAX_FILES) {
    throw new QuoteRequestError('too_many_files', `At most ${BRAND_KIT_MAX_FILES} files`);
  }
  for (const file of files) {
    if (!isAllowedExtension(file.originalName, BRAND_KIT_EXTENSIONS)) {
      throw new QuoteRequestError('file_type', `Not an accepted file type: ${file.originalName}`);
    }
    if (file.buffer.length > BRAND_KIT_MAX_BYTES) {
      throw new QuoteRequestError('file_size', `Larger than 20 MB: ${file.originalName}`);
    }
  }
  const locale = text(form.locale, 5);
  return {
    fullname,
    company,
    email,
    phone: text(form.phone, 50) || null,
    website: normalizeUrl(form.website, 500),
    brandKitUrl: normalizeUrl(form.brandKitUrl, 1000),
    quantity,
    message: text(form.message, 5000) || null,
    locale: locale && isValidLocale(locale) ? locale : 'nl',
  };
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 44) || 'lead'
  );
}

export class QuoteRequests {
  private static instance: QuoteRequests;
  private prisma = PrismaInstance.getInstance();
  private utils = new Utils();
  private translation = new Translation();
  private pushover = new PushoverClient();

  public static getInstance(): QuoteRequests {
    if (!QuoteRequests.instance) QuoteRequests.instance = new QuoteRequests();
    return QuoteRequests.instance;
  }

  /** The public form: checks, lead (company, user, list), request, brand kit, notifications. */
  public async createFromForm(
    form: QuoteRequestForm,
    files: IncomingFile[],
    clientIp: string
  ): Promise<{ requestId: number; companyId: number }> {
    const valid = validateQuoteRequest(form, files, (l) => this.translation.isValidLocale(l));

    const { isHuman } = await this.utils.verifyRecaptcha(form.captchaToken || '');
    if (!isHuman) throw new QuoteRequestError('captcha', 'reCAPTCHA verification failed');

    const spam = this.utils.isSpam({
      name: valid.fullname,
      email: valid.email,
      message: [valid.company, valid.message].filter(Boolean).join('\n'),
      honeypot: form.honeypot,
    });
    if (spam.isSpam) {
      logger.log(
        color.yellow.bold(
          `Spam detected in quote request from ${white.bold(valid.email)} (IP: ${white.bold(clientIp)}): ${white(spam.reason || 'Unknown')}`
        )
      );
      throw new QuoteRequestError('spam', 'Message detected as spam');
    }

    const business = Business.getInstance();
    const company = await this.leadCompany(valid);
    const user = await business.upsertLeadUser({
      email: valid.email,
      fullname: valid.fullname,
      phone: valid.phone ?? undefined,
      companyId: company.id,
      locale: valid.locale,
      password: crypto.randomBytes(16).toString('hex'),
    });
    const listId = await this.leadList(company, valid.quantity);

    const request = await this.prisma.companyQuoteRequest.create({
      data: {
        companyId: company.id,
        listId,
        userId: user?.id ?? null,
        quantity: valid.quantity,
        website: valid.website,
        brandKitUrl: valid.brandKitUrl,
        message: valid.message,
        locale: valid.locale,
      },
    });

    const saved: string[] = [];
    for (const file of files) {
      await saveCompanyFile(company.id, file, {
        category: 'brand',
        source: 'client',
        quoteRequestId: request.id,
        note: 'Brand kit from the /business form',
      });
      saved.push(file.originalName);
    }

    await this.prisma.companyEvent
      .create({
        data: {
          companyId: company.id,
          type: 'quote_request',
          content: `Quote request #${request.id}: ${valid.quantity} boxes, design + quotation within 24 hours${
            saved.length ? `, ${saved.length} brand kit file(s)` : ''
          }`,
        },
      })
      .catch(() => undefined);

    await this.notify(valid, request.id, company.id, saved, clientIp);
    return { requestId: request.id, companyId: company.id };
  }

  /**
   * The company the request belongs to. A returning contact (their e-mail is
   * the company's contact or one of its users) adds the request to their own
   * company; anyone else with a name that is taken gets a new lead company
   * "Name (2)", so a stranger can never put files into a customer's record.
   */
  private async leadCompany(valid: ValidQuoteRequest): Promise<any> {
    const existing = await this.prisma.company.findFirst({
      where: { name: { equals: valid.company } },
    });
    if (existing) {
      const isContact =
        (existing.contactemail || '').trim().toLowerCase() === valid.email ||
        (await this.prisma.user.count({
          where: { email: valid.email, companyId: existing.id },
        })) > 0;
      if (isContact) return existing;
    }

    let name = valid.company;
    for (let n = 2; existing && n < 100; n++) {
      name = `${valid.company} (${n})`;
      const taken = await this.prisma.company.findFirst({ where: { name: { equals: name } } });
      if (!taken) break;
    }

    const result = await Business.getInstance().createCompany({
      name,
      onlyForAdmin: true,
      contact: valid.fullname,
      contactemail: valid.email,
      contactphone: valid.phone ?? undefined,
      locale: valid.locale,
      message: valid.message ?? undefined,
    });
    if (!result.success) {
      throw new Error(result.error || 'Failed to create the lead company');
    }
    return result.data.company;
  }

  /** A list for the order, so quotation and invoice have one. Never fails the request. */
  private async leadList(company: any, quantity: number): Promise<number | null> {
    try {
      const base = slugify(company.name);
      let slug = base;
      for (let n = 2; n < 100; n++) {
        const taken = await this.prisma.companyList.findFirst({ where: { slug } });
        if (!taken) break;
        slug = `${base}-${n}`;
      }
      const result = await Business.getInstance().createCompanyList(company.id, {
        name: company.name,
        slug,
        numberOfCards: 200,
        numberOfTracks: 5,
      });
      if (!result.success) {
        logger.log(color.yellow.bold(`Quote request list not created: ${white.bold(result.error)}`));
        return null;
      }
      const listId = result.data?.list?.id ?? null;
      if (listId) {
        await this.prisma.companyList.update({
          where: { id: listId },
          data: {
            numberOfBoxes: quantity,
            designResponsibility: 'qrsong',
            minimumNumberOfTracks: 5,
          },
        });
      }
      return listId;
    } catch (error) {
      logger.log(color.yellow.bold(`Quote request list not created: ${white.bold(String(error))}`));
      return null;
    }
  }

  private async notify(
    valid: ValidQuoteRequest,
    requestId: number,
    companyId: number,
    files: string[],
    clientIp: string
  ): Promise<void> {
    const dashboardUrl = `${process.env['FRONTEND_URI']}/en/dashboard/companies/${companyId}/assets`;
    try {
      await Mail.getInstance().sendBusinessLeadNotification({
        company: valid.company,
        fullname: valid.fullname,
        email: valid.email,
        phone: valid.phone,
        message: valid.message,
        locale: valid.locale,
        quote: {
          requestId,
          quantity: valid.quantity,
          website: valid.website,
          brandKitUrl: valid.brandKitUrl,
          files,
          dashboardUrl,
        },
      });
    } catch (error) {
      logger.log(color.red.bold(`Quote request mail failed: ${error}`));
    }
    try {
      const lines = [
        `Company: ${valid.company}`,
        `Contact: ${valid.fullname} <${valid.email}>`,
        `Boxes: ${valid.quantity}`,
      ];
      if (valid.website) lines.push(`Website: ${valid.website}`);
      if (files.length || valid.brandKitUrl) {
        lines.push(`Brand kit: ${[...files, valid.brandKitUrl].filter(Boolean).join(', ')}`);
      }
      await this.pushover.sendMessage(
        {
          title: 'New quote request (24 h)',
          message: lines.join('\n'),
          sound: 'incoming',
        },
        clientIp,
        true
      );
    } catch (error) {
      logger.log(color.red.bold(`Quote request Pushover failed: ${error}`));
    }
  }

  public async list(statuses: string[]): Promise<any[]> {
    const wanted = statuses.filter((s) => (QUOTE_REQUEST_STATUSES as readonly string[]).includes(s));
    const rows = await this.prisma.companyQuoteRequest.findMany({
      where: wanted.length ? { status: { in: wanted } } : {},
      include: { Company: true, CompanyFile: true },
      orderBy: { createdAt: 'asc' },
    });
    return this.toDtos(rows);
  }

  public async listForCompany(companyId: number): Promise<any[]> {
    const rows = await this.prisma.companyQuoteRequest.findMany({
      where: { companyId },
      include: { Company: true, CompanyFile: true },
      orderBy: { createdAt: 'desc' },
    });
    return this.toDtos(rows);
  }

  public async get(id: number): Promise<any | null> {
    const row = await this.prisma.companyQuoteRequest.findUnique({
      where: { id },
      include: { Company: true, CompanyFile: true },
    });
    return row ? (await this.toDtos([row]))[0] : null;
  }

  /** Moves a request along; the first time it reaches a stage, that moment is kept. */
  public async updateStatus(id: number, status: string): Promise<any> {
    if (!(QUOTE_REQUEST_STATUSES as readonly string[]).includes(status)) {
      throw new QuoteRequestError('invalid_status', `Status must be one of ${QUOTE_REQUEST_STATUSES.join(', ')}`);
    }
    const row = await this.prisma.companyQuoteRequest.findUnique({ where: { id } });
    if (!row) throw new QuoteRequestError('not_found', 'Quote request not found', 404);
    const now = new Date();
    const data: any = { status };
    if (status === 'in_progress' && !row.startedAt) data.startedAt = now;
    if (status === 'design_ready' && !row.designReadyAt) data.designReadyAt = now;
    if (status === 'sent' && !row.sentAt) data.sentAt = now;
    await this.prisma.companyQuoteRequest.update({ where: { id }, data });
    return this.get(id);
  }

  private async toDtos(rows: any[]): Promise<any[]> {
    const quotationIds = rows.map((r) => r.quotationId).filter((v): v is number => !!v);
    const userIds = rows.map((r) => r.userId).filter((v): v is number => !!v);
    const [quotations, users] = await Promise.all([
      quotationIds.length
        ? this.prisma.quotation.findMany({
            where: { id: { in: quotationIds } },
            select: { id: true, quotationNumber: true, createdAt: true },
          })
        : Promise.resolve([]),
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, displayName: true, email: true },
          })
        : Promise.resolve([]),
    ]);
    const quotationById = new Map<number, any>(quotations.map((q: any) => [q.id, q]));
    const userById = new Map<number, any>(users.map((u: any) => [u.id, u]));

    return rows.map((r) => {
      const user = r.userId ? userById.get(r.userId) : null;
      const company = r.Company;
      return {
        id: r.id,
        companyId: r.companyId,
        listId: r.listId,
        status: r.status,
        quantity: r.quantity,
        website: r.website,
        brandKitUrl: r.brandKitUrl,
        message: r.message,
        locale: r.locale,
        quotationId: r.quotationId,
        quotation: r.quotationId ? quotationById.get(r.quotationId) ?? null : null,
        startedAt: r.startedAt,
        designReadyAt: r.designReadyAt,
        sentAt: r.sentAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        files: (r.CompanyFile ?? []).map(toFileDto),
        company: company
          ? {
              id: company.id,
              name: company.name,
              contact: company.contact,
              contactemail: company.contactemail,
              contactphone: company.contactphone,
              locale: company.locale,
            }
          : null,
        contact: user
          ? { userId: user.id, fullname: user.displayName, email: user.email }
          : null,
      };
    });
  }
}

export default QuoteRequests;
