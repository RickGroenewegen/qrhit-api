import Logger from './logger';
import { color } from 'console-log-colors';
import Moneybird from './bookkeeping/moneybird';
import {
  BookkeepingContact,
  BookkeepingContactInput,
  BookkeepingInvoice,
  BookkeepingLineItem,
  BookkeepingProvider,
  ConnectionStatus,
} from './bookkeeping/types';

/**
 * Bookkeeping is the single entry point for any accounting / invoicing
 * action (contacts, sales invoices, connection status). The actual
 * integration is handled by a pluggable provider — today MoneyBird, but
 * future providers (Exact, e-Boekhouden) only need to implement
 * BookkeepingProvider and be selected via BOOKKEEPING_PROVIDER.
 */
class Bookkeeping {
  private static instance: Bookkeeping;
  private provider: BookkeepingProvider;
  private logger = new Logger();

  private constructor() {
    const choice = (process.env['BOOKKEEPING_PROVIDER'] || 'moneybird').toLowerCase();
    switch (choice) {
      case 'moneybird':
      default:
        this.provider = Moneybird.getInstance();
        break;
    }
  }

  public static getInstance(): Bookkeeping {
    if (!Bookkeeping.instance) Bookkeeping.instance = new Bookkeeping();
    return Bookkeeping.instance;
  }

  // -------- Logging helpers (blue/green/yellow/red, params white.bold) --------

  private prefix(level: 'blue' | 'green' | 'yellow' | 'red'): string {
    const c = color[level].bold;
    return c('[') + color.white.bold('bookkeeping') + c('] ');
  }

  private emit(
    level: 'blue' | 'green' | 'yellow' | 'red',
    text: string,
    param?: string
  ): void {
    const c = color[level].bold;
    if (param != null) {
      this.logger.log(this.prefix(level) + c(text) + color.white.bold(param));
    } else {
      this.logger.log(this.prefix(level) + c(text));
    }
  }

  private info(text: string, param?: string): void {
    this.emit('blue', text, param);
  }
  private success(text: string, param?: string): void {
    this.emit('green', text, param);
  }
  private warn(text: string, param?: string): void {
    this.emit('yellow', text, param);
  }
  private error(text: string, param?: string): void {
    this.emit('red', text, param);
  }

  // -------- Public API --------

  public providerName(): string {
    return this.provider.name;
  }

  public isConnected(): Promise<boolean> {
    return this.provider.isConnected();
  }

  public async getStatus(): Promise<ConnectionStatus> {
    const status = await this.provider.getStatus();
    if (status.connected) {
      this.success('status: connected via ', this.provider.name);
    } else {
      this.warn(
        'status: disconnected ',
        `(${status.reason || 'unknown reason'})`
      );
    }
    return status;
  }

  public async findOrCreateContact(
    customerKey: string,
    payload: BookkeepingContactInput
  ): Promise<BookkeepingContact> {
    this.info(
      'upsert contact ',
      `${customerKey} (${payload.company_name || ''})`
    );
    try {
      const c = await this.provider.findOrCreateContact(customerKey, payload);
      this.success('contact ready ', `${customerKey} → id=${c.id}`);
      return c;
    } catch (err: any) {
      this.error(
        'contact upsert failed: ',
        err?.response?.data ? JSON.stringify(err.response.data) : err?.message
      );
      throw err;
    }
  }

  public async findContactByCompanyName(
    name: string
  ): Promise<BookkeepingContact | null> {
    return this.provider.findContactByCompanyName(name);
  }

  public async findTaxRateId(args: {
    percentage: number;
    countryCode?: string;
  }): Promise<string | undefined> {
    return this.provider.findTaxRateId(args);
  }

  public async findLedgerAccountIdByCode(
    code: string
  ): Promise<string | undefined> {
    return this.provider.findLedgerAccountIdByCode(code);
  }

  public async findInvoiceByReference(
    reference: string
  ): Promise<BookkeepingInvoice | null> {
    return this.provider.findInvoiceByReference(reference);
  }

  public async finalizeInvoice(
    invoiceId: string | number
  ): Promise<BookkeepingInvoice | null> {
    this.info('finalize invoice ', `id=${invoiceId}`);
    return this.provider.finalizeInvoice(invoiceId);
  }

  public async downloadInvoicePdf(
    invoiceId: string | number
  ): Promise<Buffer> {
    this.info('download invoice pdf ', `id=${invoiceId}`);
    try {
      const buf = await this.provider.downloadInvoicePdf(invoiceId);
      this.success('invoice pdf ready ', `id=${invoiceId} bytes=${buf.length}`);
      return buf;
    } catch (err: any) {
      this.error(
        'invoice pdf failed: ',
        err?.response?.data ? JSON.stringify(err.response.data) : err?.message
      );
      throw err;
    }
  }

  public async createInvoice(args: {
    contactId: string | number;
    reference: string;
    invoiceDate: string;
    items: BookkeepingLineItem[];
  }): Promise<BookkeepingInvoice> {
    this.info(
      'create invoice ',
      `ref="${args.reference}" contact_id=${args.contactId} lines=${args.items.length}`
    );
    try {
      const inv = await this.provider.createInvoice(args);
      this.success(
        'invoice ready ',
        `id=${inv.id} number=${inv.invoice_id || '-'}`
      );
      return inv;
    } catch (err: any) {
      this.error(
        'invoice creation failed: ',
        err?.response?.data ? JSON.stringify(err.response.data) : err?.message
      );
      throw err;
    }
  }
}

export default Bookkeeping;
