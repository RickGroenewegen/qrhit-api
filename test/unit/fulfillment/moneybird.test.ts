/**
 * Unit tests for src/bookkeeping/moneybird.ts.
 *
 * All HTTP goes through axios, which is mocked at the module boundary
 * (the global fetch blocker in test/setup.ts does not cover axios).
 * Every test gets a FRESH Moneybird instance (the singleton caches the
 * administration id, the 21% tax-rate id and ledger-account ids per
 * process, which would otherwise leak between tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios');
import axios from 'axios';
import Moneybird from '../../../src/bookkeeping/moneybird';

const axiosRequest = vi.mocked(axios.request);
const axiosGet = vi.mocked(axios.get);

const API = 'https://moneybird.com/api/v2';

function fresh(): Moneybird {
  (Moneybird as any).instance = undefined;
  return Moneybird.getInstance();
}

beforeEach(() => {
  process.env['MONEYBIRD_API_KEY'] = 'mb-key';
  process.env['MONEYBIRD_ADMINISTRATION_ID'] = 'admin1';
  axiosRequest.mockReset();
  axiosGet.mockReset();
});

describe('connection / administration id', () => {
  it('getStatus reports not connected when MONEYBIRD_API_KEY is missing', async () => {
    delete process.env['MONEYBIRD_API_KEY'];
    const mb = fresh();
    expect(await mb.getStatus()).toEqual({
      connected: false,
      reason: 'MONEYBIRD_API_KEY is not set in the environment',
    });
    expect(await mb.isConnected()).toBe(false);
    expect(axiosGet).not.toHaveBeenCalled();
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('uses the configured administration id without any discovery call', async () => {
    const mb = fresh();
    expect(await mb.getStatus()).toEqual({ connected: true });
    expect(await mb.isConnected()).toBe(true);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('discovers the administration id from /administrations.json and caches it', async () => {
    delete process.env['MONEYBIRD_ADMINISTRATION_ID'];
    axiosGet.mockResolvedValue({
      data: [{ id: 424242, name: 'QRSong' }],
    } as any);
    const mb = fresh();

    expect(await mb.getStatus()).toEqual({ connected: true });
    expect(axiosGet).toHaveBeenCalledWith(`${API}/administrations.json`, {
      headers: { Authorization: 'Bearer mb-key' },
    });

    // Cached: a second status check performs no further discovery.
    expect(await mb.getStatus()).toEqual({ connected: true });
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('reports not connected when the API key has no administrations', async () => {
    delete process.env['MONEYBIRD_ADMINISTRATION_ID'];
    axiosGet.mockResolvedValue({ data: [] } as any);
    const mb = fresh();
    expect(await mb.getStatus()).toEqual({
      connected: false,
      reason: 'No administrations available for this API key',
    });
  });

  it('authed requests throw when the API key is unset', async () => {
    const mb = fresh();
    delete process.env['MONEYBIRD_API_KEY'];
    await expect(
      mb.createContact({ company_name: 'ACME' } as any)
    ).rejects.toThrow('MONEYBIRD_API_KEY is not configured');
  });
});

describe('contacts', () => {
  it('findContactByCustomerId issues an authed GET with the customer id URL-encoded', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({ data: { id: 77, customer_id: 'cust 1' } } as any);

    const contact = await mb.findContactByCustomerId('cust 1');

    expect(contact).toEqual({ id: 77, customer_id: 'cust 1' });
    expect(axiosRequest).toHaveBeenCalledWith({
      url: `${API}/admin1/contacts/customer_id/cust%201.json`,
      method: 'GET',
      data: undefined,
      timeout: 15000,
      headers: {
        Authorization: 'Bearer mb-key',
        'Content-Type': 'application/json',
      },
    });
  });

  it('findContactByCustomerId returns null on 404 and on other errors', async () => {
    const mb = fresh();
    axiosRequest.mockRejectedValueOnce({ response: { status: 404 } });
    expect(await mb.findContactByCustomerId('missing')).toBeNull();

    axiosRequest.mockRejectedValueOnce({ response: { status: 500, data: { error: 'x' } } });
    expect(await mb.findContactByCustomerId('boom')).toBeNull();

    expect(await mb.findContactByCustomerId('')).toBeNull();
    expect(axiosRequest).toHaveBeenCalledTimes(2);
  });

  it('createContact POSTs the payload wrapped in { contact }', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({ data: { id: 88 } } as any);

    const payload = { company_name: 'ACME BV', customer_id: 'c-9' } as any;
    const created = await mb.createContact(payload);

    expect(created).toEqual({ id: 88 });
    expect(axiosRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: `${API}/admin1/contacts.json`,
        data: { contact: payload },
      })
    );
  });

  it('findOrCreateContact returns the existing contact without creating', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({ data: { id: 5 } } as any);

    const contact = await mb.findOrCreateContact('cust-5', {
      company_name: 'Existing BV',
    } as any);

    expect(contact).toEqual({ id: 5 });
    expect(axiosRequest).toHaveBeenCalledTimes(1);
    expect(axiosRequest.mock.calls[0][0]).toMatchObject({ method: 'GET' });
  });

  it('findOrCreateContact creates with the customer_id merged in when missing', async () => {
    const mb = fresh();
    axiosRequest
      .mockRejectedValueOnce({ response: { status: 404 } }) // lookup miss
      .mockResolvedValueOnce({ data: { id: 6 } } as any); // create

    const contact = await mb.findOrCreateContact('cust-6', {
      company_name: 'New BV',
      firstname: 'Jane',
    } as any);

    expect(contact).toEqual({ id: 6 });
    expect(axiosRequest.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      url: `${API}/admin1/contacts.json`,
      data: {
        contact: {
          company_name: 'New BV',
          firstname: 'Jane',
          customer_id: 'cust-6',
        },
      },
    });
  });

  it('findContactByCompanyName matches exact company_name case-insensitively', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 1, company_name: 'ACME Holding' },
        { id: 2, company_name: '  acme bv ' },
      ],
    } as any);

    const match = await mb.findContactByCompanyName('ACME BV');
    expect(match).toEqual({ id: 2, company_name: '  acme bv ' });
    expect(axiosRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${API}/admin1/contacts.json?query=ACME%20BV`,
      })
    );
  });

  it('findContactByCompanyName returns null on no exact match, non-array data and empty name', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValueOnce({
      data: [{ id: 1, company_name: 'Other' }],
    } as any);
    expect(await mb.findContactByCompanyName('ACME')).toBeNull();

    axiosRequest.mockResolvedValueOnce({ data: { not: 'an array' } } as any);
    expect(await mb.findContactByCompanyName('ACME')).toBeNull();

    expect(await mb.findContactByCompanyName('')).toBeNull();
  });
});

describe('tax rates', () => {
  it('getTaxRates returns [] when the request fails or data is not an array', async () => {
    const mb = fresh();
    axiosRequest.mockRejectedValueOnce(new Error('down'));
    expect(await mb.getTaxRates()).toEqual([]);
    axiosRequest.mockResolvedValueOnce({ data: { nope: 1 } } as any);
    expect(await mb.getTaxRates()).toEqual([]);
  });

  it('getStandardVatRateId resolves the active 21% sales_invoice rate and caches it', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 901, percentage: '21.0', tax_rate_type: 'sales_invoice', active: false },
        { id: 902, percentage: '21.0', tax_rate_type: 'purchase_invoice', active: true },
        { id: 903, percentage: '21.0', tax_rate_type: 'sales_invoice', active: true },
        { id: 904, percentage: '9.0', tax_rate_type: 'sales_invoice', active: true },
      ],
    } as any);

    expect(await mb.getStandardVatRateId()).toBe('903');
    expect(await mb.getStandardVatRateId()).toBe('903');
    expect(axiosRequest).toHaveBeenCalledTimes(1); // cached after the hit
  });

  it('getStandardVatRateId returns undefined when no 21% rate exists — and (actual behavior) the miss is NOT cached', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({ data: [] } as any);

    expect(await mb.getStandardVatRateId()).toBeUndefined();
    expect(await mb.getStandardVatRateId()).toBeUndefined();
    // The `cachedTaxRateId !== undefined` guard means a miss re-fetches
    // tax_rates.json on every call (inefficiency, not a correctness bug).
    expect(axiosRequest).toHaveBeenCalledTimes(2);
  });

  it('findTaxRateId matches exact percentage + country from the structured country field', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 1, percentage: '21.0', country: 'NL', tax_rate_type: 'sales_invoice', active: true },
        { id: 2, percentage: '19.0', country: 'DE', tax_rate_type: 'sales_invoice', active: true },
      ],
    } as any);

    expect(await mb.findTaxRateId({ percentage: 19, countryCode: 'de' })).toBe('2');
  });

  it('findTaxRateId pulls a 2-letter country code out of the rate name as fallback', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 3, percentage: '0.0', name: 'VAT 0% CA (sales)', tax_rate_type: 'verkoop_export', active: true },
      ],
    } as any);

    expect(await mb.findTaxRateId({ percentage: 0, countryCode: 'CA' })).toBe('3');
  });

  it('findTaxRateId excludes purchase-like rates and refuses a country-less fallback for non-zero foreign rates', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 9, percentage: '21.0', country: 'DE', tax_rate_type: 'purchase_invoice', active: true },
        { id: 5, percentage: '21.0', country: '', name: 'BTW 21%', tax_rate_type: 'sales_invoice', active: true },
      ],
    } as any);

    // DE 21% only exists as a purchase rate; the country-less 21% must NOT
    // be used for a foreign country (would book NL VAT on a German order).
    expect(await mb.findTaxRateId({ percentage: 21, countryCode: 'DE' })).toBeUndefined();
  });

  it('findTaxRateId falls back to the generic country-less 0% rate for any country', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 7, percentage: '0.0', country: '', name: 'BTW 0%', tax_rate_type: 'sales_invoice', active: true },
      ],
    } as any);

    expect(await mb.findTaxRateId({ percentage: 0, countryCode: 'DE' })).toBe('7');
  });

  it('findTaxRateId allows the country-less fallback for NL and for empty country', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 5, percentage: '21.0', country: '', name: 'BTW 21%', tax_rate_type: 'sales_invoice', active: true },
      ],
    } as any);

    expect(await mb.findTaxRateId({ percentage: 21, countryCode: 'NL' })).toBe('5');
    expect(await mb.findTaxRateId({ percentage: 21 })).toBe('5');
  });
});

describe('ledger accounts', () => {
  it('resolves a ledger account id by code and caches hits AND misses per code', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 1111, account_id: '8010', name: 'Omzet QRSong - particulier' },
        { id: 2222, account_id: '8020', name: 'Omzet QRSong - zakelijk' },
      ],
    } as any);

    expect(await mb.findLedgerAccountIdByCode('8010')).toBe('1111');
    expect(await mb.findLedgerAccountIdByCode('8010')).toBe('1111');
    expect(axiosRequest).toHaveBeenCalledTimes(1); // hit cached

    expect(await mb.findLedgerAccountIdByCode('9999')).toBeUndefined();
    expect(await mb.findLedgerAccountIdByCode('9999')).toBeUndefined();
    expect(axiosRequest).toHaveBeenCalledTimes(2); // miss cached too

    expect(await mb.findLedgerAccountIdByCode('')).toBeUndefined();
    expect(axiosRequest).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when fetching ledger accounts fails', async () => {
    const mb = fresh();
    axiosRequest.mockRejectedValue({ response: { status: 500, data: { e: 1 } } });
    expect(await mb.findLedgerAccountIdByCode('8010')).toBeUndefined();
  });
});

describe('sales invoices', () => {
  it('createInvoice builds the exact sales_invoice payload with fallback tax rate, ledger ids and pinned style/identity', async () => {
    const mb = fresh();
    axiosRequest.mockImplementation(async (cfg: any) => {
      if (cfg.url.endsWith('/tax_rates.json')) {
        return {
          data: [
            { id: 'tr21', percentage: '21.0', tax_rate_type: 'sales_invoice', active: true },
          ],
        } as any;
      }
      if (cfg.method === 'POST' && cfg.url.endsWith('/sales_invoices.json')) {
        return {
          data: { id: 555, invoice_id: '2026-0001', total_price_incl_tax: '60.50' },
        } as any;
      }
      throw new Error(`unexpected request ${cfg.method} ${cfg.url}`);
    });

    const invoice = await mb.createInvoice({
      contactId: 'c1',
      reference: 'QR123456',
      invoiceDate: '2026-06-01',
      items: [
        // No tax_rate_id → falls back to the resolved 21% rate.
        { description: 'QR cards', amount: '2', price: '25.00', ledger_account_id: 'led1' },
        // Explicit tax_rate_id wins over the fallback.
        { description: 'Shipping', amount: '1', price: '4.13', tax_rate_id: 'tr0' },
      ] as any,
    });

    const postCall = axiosRequest.mock.calls.find(
      (c: any[]) => c[0].method === 'POST'
    )![0] as any;
    expect(postCall.url).toBe(`${API}/admin1/sales_invoices.json`);
    expect(postCall.timeout).toBe(15000);
    expect(postCall.headers).toEqual({
      Authorization: 'Bearer mb-key',
      'Content-Type': 'application/json',
    });
    expect(postCall.data).toEqual({
      sales_invoice: {
        contact_id: 'c1',
        reference: 'QR123456',
        invoice_date: '2026-06-01',
        document_style_id: '483050618946061479',
        identity_id: '483052548427613969',
        details_attributes: [
          {
            description: 'QR cards',
            amount: '2',
            price: '25.00',
            tax_rate_id: 'tr21',
            ledger_account_id: 'led1',
          },
          {
            description: 'Shipping',
            amount: '1',
            price: '4.13',
            tax_rate_id: 'tr0',
          },
        ],
      },
    });

    // The customer-facing url is replaced by the in-app admin url.
    expect(invoice).toEqual({
      id: 555,
      invoice_id: '2026-0001',
      total_price_incl_tax: '60.50',
      url: 'https://moneybird.com/admin1/sales_invoices/555',
    });
  });

  it('createInvoice omits tax_rate_id entirely when neither line nor fallback provides one', async () => {
    const mb = fresh();
    axiosRequest.mockImplementation(async (cfg: any) => {
      if (cfg.url.endsWith('/tax_rates.json')) return { data: [] } as any;
      return { data: { id: 1 } } as any;
    });

    await mb.createInvoice({
      contactId: 2,
      reference: 'R',
      invoiceDate: '2026-06-01',
      items: [{ description: 'Cards', amount: '1', price: '10.00' }] as any,
    });

    const postCall = axiosRequest.mock.calls.find(
      (c: any[]) => c[0].method === 'POST'
    )![0] as any;
    const line = postCall.data.sales_invoice.details_attributes[0];
    expect(line).toEqual({ description: 'Cards', amount: '1', price: '10.00' });
    expect('tax_rate_id' in line).toBe(false);
    expect('ledger_account_id' in line).toBe(false);
  });

  it('finalizeInvoice PATCHes send_invoice with delivery_method Manual and rewrites the url', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: { id: 555, invoice_id: '2026-0001' },
    } as any);

    const finalized = await mb.finalizeInvoice(555);

    expect(axiosRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        url: `${API}/admin1/sales_invoices/555/send_invoice`,
        data: { sales_invoice_sending: { delivery_method: 'Manual' } },
      })
    );
    expect(finalized).toEqual({
      id: 555,
      invoice_id: '2026-0001',
      url: 'https://moneybird.com/admin1/sales_invoices/555',
    });
  });

  it('finalizeInvoice returns null on API errors', async () => {
    const mb = fresh();
    axiosRequest.mockRejectedValue({ response: { status: 422 }, message: 'nope' });
    expect(await mb.finalizeInvoice(1)).toBeNull();
  });

  it('findInvoiceByReference encodes the filter, prefers the exact reference match and rewrites the url', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValue({
      data: [
        { id: 1, reference: 'QR1-extra' },
        { id: 2, reference: 'QR1' },
      ],
    } as any);

    const invoice = await mb.findInvoiceByReference('QR1');

    expect(axiosRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: `${API}/admin1/sales_invoices.json?filter=reference%3AQR1`,
      })
    );
    expect(invoice).toEqual({
      id: 2,
      reference: 'QR1',
      url: 'https://moneybird.com/admin1/sales_invoices/2',
    });
  });

  it('findInvoiceByReference returns null for empty results, 404s and empty reference', async () => {
    const mb = fresh();
    axiosRequest.mockResolvedValueOnce({ data: [] } as any);
    expect(await mb.findInvoiceByReference('QRX')).toBeNull();

    axiosRequest.mockRejectedValueOnce({ response: { status: 404 } });
    expect(await mb.findInvoiceByReference('QRX')).toBeNull();

    expect(await mb.findInvoiceByReference('')).toBeNull();
  });

  it('downloadInvoicePdf requests an arraybuffer with PDF accept header and returns a Buffer', async () => {
    const mb = fresh();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    axiosRequest.mockResolvedValue({ data: bytes.buffer } as any);

    const buf = await mb.downloadInvoicePdf(555);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(axiosRequest).toHaveBeenCalledWith({
      url: `${API}/admin1/sales_invoices/555/download_pdf`,
      method: 'GET',
      responseType: 'arraybuffer',
      headers: {
        Authorization: 'Bearer mb-key',
        Accept: 'application/pdf',
      },
    });
  });

  it('downloadInvoicePdf throws without API key and rethrows API errors', async () => {
    const mb = fresh();
    delete process.env['MONEYBIRD_API_KEY'];
    await expect(mb.downloadInvoicePdf(1)).rejects.toThrow(
      'MONEYBIRD_API_KEY is not configured'
    );

    process.env['MONEYBIRD_API_KEY'] = 'mb-key';
    axiosRequest.mockRejectedValue({ response: { status: 404 }, message: 'gone' });
    await expect(mb.downloadInvoicePdf(1)).rejects.toMatchObject({ message: 'gone' });
  });
});
