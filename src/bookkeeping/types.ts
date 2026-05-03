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
