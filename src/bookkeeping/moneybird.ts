import axios from 'axios';
import Logger from '../logger';
import { color } from 'console-log-colors';
import {
  BookkeepingContact,
  BookkeepingContactInput,
  BookkeepingInvoice,
  BookkeepingLineItem,
  BookkeepingProvider,
  ConnectionStatus,
} from './types';

const MONEYBIRD_BASE = 'https://moneybird.com';
const API_BASE = `${MONEYBIRD_BASE}/api/v2`;

interface InvoiceLineItem {
  description: string;
  amount: string;
  price: string;
  tax_rate_id?: string;
}

class Moneybird implements BookkeepingProvider {
  public readonly name = 'moneybird';
  private static instance: Moneybird;
  private logger = new Logger();
  private cachedAdministrationId: string | null = null;
  private cachedTaxRateId: string | undefined = undefined;

  // Hardcoded "QRSong!" huisstijl — fetched once from
  // GET /document_styles.json and pinned here.
  private readonly qrsongDocumentStyleId = '483050618946061479';
  private readonly qrsongIdentityId = '483052548427613969';

  public static getInstance(): Moneybird {
    if (!Moneybird.instance) Moneybird.instance = new Moneybird();
    return Moneybird.instance;
  }

  private get apiKey(): string {
    return process.env['MONEYBIRD_API_KEY'] || '';
  }

  private get configuredAdministrationId(): string {
    return process.env['MONEYBIRD_ADMINISTRATION_ID'] || '';
  }

  private prefix(level: 'blue' | 'green' | 'yellow' | 'red'): string {
    const c = color[level].bold;
    return c('[') + color.white.bold('moneybird') + c('] ');
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

  public async isConnected(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await this.getAdministrationId();
      return true;
    } catch {
      return false;
    }
  }

  public async getStatus(): Promise<ConnectionStatus> {
    if (!this.apiKey) {
      this.warn('MONEYBIRD_API_KEY is not set in the environment');
      return {
        connected: false,
        reason: 'MONEYBIRD_API_KEY is not set in the environment',
      };
    }
    try {
      const adminId = await this.getAdministrationId();
      this.success('connected — administration ', String(adminId));
      return { connected: true };
    } catch (err: any) {
      const reason = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err?.message || 'Unknown error';
      this.error('status check failed: ', reason);
      return { connected: false, reason };
    }
  }

  /**
   * Resolve and cache the administration id used for /api/v2/{id}/... calls.
   * Prefer MONEYBIRD_ADMINISTRATION_ID if set, otherwise fetch the first
   * administration tied to the API key.
   */
  private async getAdministrationId(): Promise<string> {
    if (this.cachedAdministrationId) return this.cachedAdministrationId;
    if (this.configuredAdministrationId) {
      this.cachedAdministrationId = this.configuredAdministrationId;
      this.info(
        'using configured administration id ',
        this.cachedAdministrationId
      );
      return this.cachedAdministrationId;
    }
    this.info('discovering administration id from /administrations.json');
    const response = await axios.get(`${API_BASE}/administrations.json`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!Array.isArray(response.data) || response.data.length === 0) {
      throw new Error('No administrations available for this API key');
    }
    const adminId = String(response.data[0].id);
    this.cachedAdministrationId = adminId;
    this.success(
      'discovered administration id ',
      `${adminId} (${response.data[0].name || ''})`
    );
    return adminId;
  }

  private async authedRequest<T = any>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pathSuffix: string,
    body?: any
  ): Promise<T> {
    if (!this.apiKey) {
      throw new Error('MONEYBIRD_API_KEY is not configured');
    }
    const adminId = await this.getAdministrationId();
    const url = `${API_BASE}/${adminId}/${pathSuffix.replace(/^\//, '')}`;
    this.info(`${method} `, url);
    try {
      const response = await axios.request<T>({
        url,
        method,
        data: body,
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const payload = err?.response?.data;
      this.error(
        `${method} ${pathSuffix} failed${status ? ' (' + status + ')' : ''}: `,
        payload ? JSON.stringify(payload) : err?.message
      );
      throw err;
    }
  }

  // --------- Contacts ---------

  public async findContactByCustomerId(
    customerId: string
  ): Promise<any | null> {
    if (!customerId) return null;
    try {
      const data = await this.authedRequest<any>(
        'GET',
        `contacts/customer_id/${encodeURIComponent(customerId)}.json`
      );
      this.info(
        'contact found for customer_id ',
        `${customerId} (id ${data?.id})`
      );
      return data;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) {
        this.info('no contact yet for customer_id ', customerId);
        return null;
      }
      return null;
    }
  }

  public async createContact(payload: BookkeepingContactInput): Promise<any> {
    this.info(
      'creating contact ',
      `${payload.company_name || payload.firstname || '?'} (customer_id=${payload.customer_id || '-'})`
    );
    const data = await this.authedRequest<any>('POST', 'contacts.json', {
      contact: payload,
    });
    this.success('contact created with id ', String(data?.id));
    return data;
  }

  public async findOrCreateContact(
    customerId: string,
    payload: BookkeepingContactInput
  ): Promise<BookkeepingContact> {
    const existing = await this.findContactByCustomerId(customerId);
    if (existing) return existing as BookkeepingContact;
    return (await this.createContact({
      ...payload,
      customer_id: customerId,
    })) as BookkeepingContact;
  }

  /**
   * Look up an existing contact by company name (case-insensitive). Uses
   * MoneyBird's `query` filter and then matches exact company_name from the
   * returned page.
   */
  public async findContactByCompanyName(
    name: string
  ): Promise<BookkeepingContact | null> {
    if (!name) return null;
    try {
      const data = await this.authedRequest<any[]>(
        'GET',
        `contacts.json?query=${encodeURIComponent(name)}`
      );
      if (!Array.isArray(data)) return null;
      const target = name.trim().toLowerCase();
      const match = data.find(
        (c) => (c?.company_name || '').trim().toLowerCase() === target
      );
      if (match) {
        this.info(
          'contact found by company name ',
          `"${name}" → id=${match.id}`
        );
        return match as BookkeepingContact;
      }
      this.info('no exact contact match for ', `"${name}"`);
      return null;
    } catch {
      return null;
    }
  }

  // --------- Tax rates ---------

  public async getTaxRates(): Promise<any[]> {
    try {
      const data = await this.authedRequest<any[]>('GET', 'tax_rates.json');
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /**
   * Find the standard 21% sales-invoice VAT rate. Cached per process.
   * Returns undefined to fall back to the administration default.
   */
  public async getStandardVatRateId(): Promise<string | undefined> {
    if (this.cachedTaxRateId !== undefined) return this.cachedTaxRateId;
    const rates = await this.getTaxRates();
    const candidates = rates.filter(
      (r) => r.tax_rate_type === 'sales_invoice' && r.active
    );
    const hi = candidates.find((r) => Number(r.percentage) === 21);
    this.cachedTaxRateId = hi?.id ? String(hi.id) : undefined;
    if (this.cachedTaxRateId) {
      this.info('resolved 21% sales VAT rate id ', this.cachedTaxRateId);
    } else {
      this.warn(
        '21% sales VAT rate not found — falling back to administration default'
      );
    }
    return this.cachedTaxRateId;
  }

  /**
   * Find a tax rate matching (percentage, country) usable on a sales
   * invoice. We exclude purchase / general-journal rates and accept any
   * remaining active rate — MoneyBird tags export 0% rates with types
   * other than `sales_invoice` (e.g. `eu_country_zero`, `verkoop_export`),
   * which the previous strict filter wrongly excluded.
   *
   * Match priority: exact (percentage + country) → percentage with empty
   * country (legacy NL default). MoneyBird's tax_rates endpoint is
   * read-only via the API, so missing rates must be created manually in
   * the MoneyBird UI.
   */
  public async findTaxRateId(args: {
    percentage: number;
    countryCode?: string;
  }): Promise<string | undefined> {
    const wantPct = Number(args.percentage) || 0;
    const wantCountry = (args.countryCode || '').toUpperCase();

    const rates = await this.getTaxRates();
    const isPurchaseLike = (t: string) =>
      typeof t === 'string' &&
      (t.startsWith('purchase') ||
        t.startsWith('inkoop') ||
        t === 'general_journal');
    const usable = rates.filter(
      (r) => !isPurchaseLike(r.tax_rate_type || '')
    );

    // Country can come from MoneyBird's `country` field, or — for rates the
    // user named manually — be embedded in the rate's `name` (e.g.
    // "VAT 0% CA (sales)"). Pull a 2-letter code out of the name as a
    // fallback when the structured field is missing.
    const countryFromName = (name: string): string => {
      const m = (name || '').toUpperCase().match(/\b[A-Z]{2}\b/);
      return m ? m[0] : '';
    };
    const rateCountry = (r: any): string =>
      (r.country || '').toUpperCase() || countryFromName(r.name || '');

    const exact = usable.find((r) => {
      const pct = Number(r.percentage);
      return pct === wantPct && rateCountry(r) === wantCountry;
    });
    if (exact?.id) {
      this.info(
        'tax rate found ',
        `id=${exact.id} ${wantPct}% country=${wantCountry || '-'} type=${exact.tax_rate_type || '-'} name="${exact.name || ''}"`
      );
      return String(exact.id);
    }

    // 0% is a single flat rate in this admin — any country falls back to
    // the country-less 0% rate. (For non-zero rates we keep the country
    // strict to avoid accidentally booking 21% on a German order.)
    if (wantPct === 0) {
      const zeroFallback = usable.find((r) => {
        const pct = Number(r.percentage);
        return pct === 0 && rateCountry(r) === '';
      });
      if (zeroFallback?.id) {
        this.info(
          'tax rate fallback ',
          `id=${zeroFallback.id} 0% generic (any country) type=${zeroFallback.tax_rate_type || '-'}`
        );
        return String(zeroFallback.id);
      }
    }

    // Fall back to a country-less rate of the same percentage — the legacy
    // pre-OSS setup where every rate is the NL default.
    const looseFallbackOk = wantCountry === '' || wantCountry === 'NL';
    if (looseFallbackOk) {
      const fallback = usable.find((r) => {
        const pct = Number(r.percentage);
        return pct === wantPct && rateCountry(r) === '';
      });
      if (fallback?.id) {
        this.info(
          'tax rate fallback ',
          `id=${fallback.id} ${wantPct}% (no country tag) type=${fallback.tax_rate_type || '-'}`
        );
        return String(fallback.id);
      }
    }

    const available = usable
      .filter((r) => Number(r.percentage) === wantPct)
      .map(
        (r) =>
          `${r.percentage}% country=${rateCountry(r) || '-'} type=${r.tax_rate_type || '-'} active=${r.active} id=${r.id} name="${r.name || ''}"`
      );
    this.warn(
      'tax rate not found ',
      `${wantPct}% country=${wantCountry || '-'} (candidates at this percentage: ${available.length ? available.join('; ') : 'none'})`
    );
    return undefined;
  }

  // --------- Sales invoices ---------

  public async createInvoice(args: {
    contactId: string | number;
    reference: string;
    invoiceDate: string;
    items: BookkeepingLineItem[];
  }): Promise<BookkeepingInvoice> {
    const fallbackTaxRateId = await this.getStandardVatRateId();
    const details_attributes: InvoiceLineItem[] = args.items.map((it) => {
      const lineRate = it.tax_rate_id || fallbackTaxRateId;
      return {
        description: it.description,
        amount: it.amount,
        price: it.price,
        ...(lineRate ? { tax_rate_id: lineRate } : {}),
      };
    });

    this.info(
      'creating sales invoice ',
      `ref=${args.reference} contact_id=${args.contactId} lines=${details_attributes.length}`
    );
    for (const it of details_attributes) {
      this.info(
        '  • ',
        `${it.description} — ${it.amount} × € ${it.price}`
      );
    }

    const data = (await this.authedRequest<any>('POST', 'sales_invoices.json', {
      sales_invoice: {
        contact_id: args.contactId,
        reference: args.reference,
        invoice_date: args.invoiceDate,
        document_style_id: this.qrsongDocumentStyleId,
        identity_id: this.qrsongIdentityId,
        details_attributes,
      },
    })) as BookkeepingInvoice;

    // The API's `url` field is a customer-facing preview link. Replace it with
    // the in-app admin URL so the dashboard's "Open in MoneyBird" button goes
    // straight to the editable invoice view.
    const adminId = await this.getAdministrationId();
    if (data?.id) {
      data.url = `${MONEYBIRD_BASE}/${adminId}/sales_invoices/${data.id}`;
    }

    this.success(
      'invoice created ',
      `id=${data?.id} number=${data?.invoice_id || '-'} total_incl=€ ${data?.total_price_incl_tax || '?'} url=${data?.url || '-'}`
    );
    return data;
  }

  /**
   * Finalize a draft (Concept) sales invoice — assigns a number and moves it
   * to "Open". Uses send_invoice with delivery_method 'Manual' so MoneyBird
   * does NOT email the customer; we just want the invoice out of draft state.
   */
  public async finalizeInvoice(
    invoiceId: string | number
  ): Promise<BookkeepingInvoice | null> {
    if (!this.apiKey) throw new Error('MONEYBIRD_API_KEY is not configured');
    try {
      const data = await this.authedRequest<any>(
        'PATCH',
        `sales_invoices/${invoiceId}/send_invoice`,
        {
          sales_invoice_sending: { delivery_method: 'Manual' },
        }
      );
      const adminId = await this.getAdministrationId();
      if (data?.id) {
        data.url = `${MONEYBIRD_BASE}/${adminId}/sales_invoices/${data.id}`;
      }
      this.success(
        'invoice finalized ',
        `id=${data?.id} number=${data?.invoice_id || '-'}`
      );
      return data as BookkeepingInvoice;
    } catch (err: any) {
      const status = err?.response?.status;
      this.error(
        `finalize invoice failed${status ? ' (' + status + ')' : ''}: `,
        err?.message
      );
      return null;
    }
  }

  public async findInvoiceByReference(
    reference: string
  ): Promise<BookkeepingInvoice | null> {
    if (!reference) return null;
    try {
      const filter = `reference:${reference}`;
      const data = await this.authedRequest<any[]>(
        'GET',
        `sales_invoices.json?filter=${encodeURIComponent(filter)}`
      );
      if (!Array.isArray(data) || data.length === 0) return null;
      const match = data.find((d) => d?.reference === reference) || data[0];
      const adminId = await this.getAdministrationId();
      if (match?.id) {
        match.url = `${MONEYBIRD_BASE}/${adminId}/sales_invoices/${match.id}`;
      }
      return match as BookkeepingInvoice;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) return null;
      this.error(
        `find invoice by reference failed${status ? ' (' + status + ')' : ''}: `,
        err?.message
      );
      return null;
    }
  }

  public async downloadInvoicePdf(
    invoiceId: string | number
  ): Promise<Buffer> {
    if (!this.apiKey) {
      throw new Error('MONEYBIRD_API_KEY is not configured');
    }
    const adminId = await this.getAdministrationId();
    const url = `${API_BASE}/${adminId}/sales_invoices/${invoiceId}/download_pdf`;
    this.info('GET ', url);
    try {
      const response = await axios.request<ArrayBuffer>({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/pdf',
        },
      });
      return Buffer.from(response.data);
    } catch (err: any) {
      const status = err?.response?.status;
      this.error(
        `GET sales invoice PDF failed${status ? ' (' + status + ')' : ''}: `,
        err?.message
      );
      throw err;
    }
  }
}

export default Moneybird;
