/**
 * Unit tests for src/postnl.ts — shipment-label request building.
 *
 * PostNL talks to its API via global fetch; test/setup.ts blocks any
 * non-localhost fetch, so we replace globalThis.fetch with a vi.fn for
 * the duration of this file and assert the exact request bodies.
 * Label PDFs in the mocked responses are real (tiny) PDFs generated with
 * pdf-lib because the code merges them with PDFDocument.load().
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import PostNL from '../../../src/postnl';

const fetchMock = vi.fn();
let realFetch: typeof globalThis.fetch;
let postnl: PostNL;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as any;

  // The constructor caches apiKey/apiUrl, and getSenderAddress reads the
  // sender env per call — pin everything deterministically, then reset the
  // singleton so the constructor re-reads the env.
  process.env['POSTNL_API_KEY'] = 'pnl-key';
  process.env['POSTNL_API_URL'] = 'https://postnl.test';
  process.env['POSTNL_CUSTOMER_CODE'] = 'QRSC';
  process.env['POSTNL_CUSTOMER_NUMBER'] = '99887766';
  process.env['POSTNL_SENDER_COMPANY'] = 'QRSong BV';
  process.env['POSTNL_SENDER_STREET'] = 'Zendstraat';
  process.env['POSTNL_SENDER_HOUSENR'] = '12';
  process.env['POSTNL_SENDER_HOUSENR_EXT'] = 'B';
  process.env['POSTNL_SENDER_ZIPCODE'] = '1234AB';
  process.env['POSTNL_SENDER_CITY'] = 'Amsterdam';
  process.env['POSTNL_SENDER_COUNTRYCODE'] = 'NL';
  (PostNL as any).instance = undefined;
  postnl = PostNL.getInstance();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  fetchMock.mockReset();
});

function makeCompany(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    name: 'ACME BV',
    contact: 'Jane Doe',
    address: 'Mainstreet',
    housenumber: '7',
    city: 'Utrecht',
    zipcode: '3511AA',
    countrycode: 'NL',
    contactemail: 'jane@acme.test',
    ...overrides,
  };
}

async function labelBase64(): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  return Buffer.from(await doc.save()).toString('base64');
}

function okResponse(shipmentLabels: string[][]) {
  return {
    ok: true,
    json: async () => ({
      ResponseShipments: shipmentLabels.map((labels) => ({
        Labels: labels.map((Content) => ({ Content })),
      })),
    }),
  };
}

describe('createShipmentLabels', () => {
  it('rejects an empty company list without calling the API', async () => {
    expect(await postnl.createShipmentLabels([])).toEqual({
      success: false,
      error: 'No companies provided',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('collects missing-field validation errors (blank strings count as missing) and never hits the API', async () => {
    const result = await postnl.createShipmentLabels([
      makeCompany({ id: 10, name: 'Bad Co', address: '', contact: '   ' }) as any,
      makeCompany({ id: 11, name: 'Good Co' }) as any,
      makeCompany({ id: 12, name: 'Worse Co', zipcode: '', countrycode: '' }) as any,
    ]);

    expect(result).toEqual({
      success: false,
      errors: [
        { companyId: 10, companyName: 'Bad Co', missingFields: ['address', 'contact name'] },
        { companyId: 12, companyName: 'Worse Co', missingFields: ['zipcode', 'country code'] },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the exact PostNL shipment request (customer, sender, receiver, contacts, product codes)', async () => {
    fetchMock.mockResolvedValue(okResponse([[await labelBase64()]]));

    const result = await postnl.createShipmentLabels([
      makeCompany() as any,
      makeCompany({
        id: 2,
        name: 'Beta GmbH',
        contact: 'Hans',
        countrycode: 'DE',
        contactemail: '',
        productCode: '4944',
      }) as any,
    ]);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://postnl.test/v1/shipment');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      apikey: 'pnl-key',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(init.body);
    expect(body.Customer).toEqual({
      CustomerCode: 'QRSC',
      CustomerNumber: '99887766',
      Address: {
        AddressType: '02',
        CompanyName: 'QRSong BV',
        Street: 'Zendstraat',
        HouseNr: '12',
        HouseNrExt: 'B',
        Zipcode: '1234AB',
        City: 'Amsterdam',
        Countrycode: 'NL',
      },
    });
    expect(body.Message.MessageID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(body.Message.MessageTimeStamp).toMatch(
      /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/
    );
    expect(body.Message.Printertype).toBe('GraphicFile|PDF');

    expect(body.Shipments).toEqual([
      {
        Addresses: [
          {
            AddressType: '01',
            CompanyName: 'ACME BV',
            FirstName: 'Jane Doe',
            Street: 'Mainstreet',
            HouseNr: '7',
            Zipcode: '3511AA',
            City: 'Utrecht',
            Countrycode: 'NL',
          },
        ],
        Contacts: [{ ContactType: '01', Email: 'jane@acme.test' }],
        Dimension: { Weight: 1000 },
        ProductCodeDelivery: '2928', // default product code
      },
      {
        Addresses: [
          {
            AddressType: '01',
            CompanyName: 'Beta GmbH',
            FirstName: 'Hans',
            Street: 'Mainstreet',
            HouseNr: '7',
            Zipcode: '3511AA',
            City: 'Utrecht',
            Countrycode: 'DE',
          },
        ],
        Contacts: [{ ContactType: '01', Email: '' }],
        Dimension: { Weight: 1000 },
        ProductCodeDelivery: '4944', // explicit override
      },
    ]);
  });

  it('batches companies into groups of 4 per API request', async () => {
    const label = await labelBase64();
    fetchMock.mockResolvedValue(okResponse([[label]]));

    const companies = Array.from({ length: 5 }, (_, i) =>
      makeCompany({ id: i + 1, name: `Co ${i + 1}` })
    );
    const result = await postnl.createShipmentLabels(companies as any);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.Shipments).toHaveLength(4);
    expect(secondBody.Shipments).toHaveLength(1);
  });

  it('returns the API error body when PostNL responds non-ok', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'kapot',
    });

    expect(await postnl.createShipmentLabels([makeCompany() as any])).toEqual({
      success: false,
      error: 'PostNL API error: 500 - kapot',
    });
  });

  it('fails when the response contains no labels', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ResponseShipments: [{ Labels: [] }] }),
    });

    expect(await postnl.createShipmentLabels([makeCompany() as any])).toEqual({
      success: false,
      error: 'No labels were generated by PostNL',
    });
  });

  it('merges all label PDFs (across shipments) into a single PDF buffer', async () => {
    fetchMock.mockResolvedValue(
      okResponse([[await labelBase64()], [await labelBase64(), await labelBase64()]])
    );

    const result = await postnl.createShipmentLabels([
      makeCompany() as any,
      makeCompany({ id: 2 }) as any,
    ]);

    expect(result.success).toBe(true);
    const merged = await PDFDocument.load(result.pdfBuffer!);
    expect(merged.getPageCount()).toBe(3);
  });

  it('turns thrown errors into a { success: false, error } result', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    expect(await postnl.createShipmentLabels([makeCompany() as any])).toEqual({
      success: false,
      error: 'socket hang up',
    });
  });
});
