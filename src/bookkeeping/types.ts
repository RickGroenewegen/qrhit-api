export interface BookkeepingContact {
  id: string | number;
  company_name?: string;
  customer_id?: string;
}

export interface BookkeepingContactInput {
  company_name?: string;
  firstname?: string;
  lastname?: string;
  address1?: string;
  address2?: string;
  zipcode?: string;
  city?: string;
  country?: string;
  phone?: string;
  send_invoices_to_email?: string;
  send_estimates_to_email?: string;
  customer_id?: string;
  chamber_of_commerce?: string;
  vat_number?: string;
}

export interface BookkeepingLineItem {
  description: string;
  amount: string;
  price: string;
  tax_rate_id?: string;
  ledger_account_id?: string;
}

export interface BookkeepingInvoice {
  id: string | number;
  invoice_id?: string;
  url?: string;
  total_price_excl_tax?: string;
  total_price_incl_tax?: string;
}

export interface ConnectionStatus {
  connected: boolean;
  reason?: string;
}

export interface BookkeepingProvider {
  readonly name: string;

  isConnected(): Promise<boolean>;
  getStatus(): Promise<ConnectionStatus>;

  /** Find a contact by our internal stable customer key, or create one. */
  findOrCreateContact(
    customerKey: string,
    payload: BookkeepingContactInput
  ): Promise<BookkeepingContact>;

  /** Look up an existing contact by its company name (case-insensitive). */
  findContactByCompanyName(name: string): Promise<BookkeepingContact | null>;

  /**
   * Find an existing sales-invoice VAT rate for (percentage, country).
   * Returns undefined if no matching rate exists. MoneyBird's tax_rates
   * endpoint is read-only via the API, so callers must surface missing
   * rates to the admin instead of creating on the fly.
   */
  findTaxRateId(args: {
    percentage: number;
    countryCode?: string;
  }): Promise<string | undefined>;

  /**
   * Find a ledger account ("grootboekrekening") id by its numeric code
   * (e.g. "8010"). Returns undefined when no active account matches.
   */
  findLedgerAccountIdByCode(code: string): Promise<string | undefined>;

  /** Create a sales invoice with the given line items. */
  createInvoice(args: {
    contactId: string | number;
    reference: string;
    invoiceDate: string;
    items: BookkeepingLineItem[];
  }): Promise<BookkeepingInvoice>;

  /** Download the PDF for a sales invoice as a Buffer. */
  downloadInvoicePdf(invoiceId: string | number): Promise<Buffer>;

  /** Look up a sales invoice by its `reference` field; returns null if none. */
  findInvoiceByReference(
    reference: string
  ): Promise<BookkeepingInvoice | null>;

  /** Move a draft sales invoice to a finalized state (assigns a number). */
  finalizeInvoice(invoiceId: string | number): Promise<BookkeepingInvoice | null>;
}
