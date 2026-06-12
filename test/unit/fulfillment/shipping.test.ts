/**
 * Unit tests for src/shipping.ts.
 *
 * Module-boundary mocks:
 *  - axios                      → TrackingMore HTTP calls
 *  - cron                       → CronJob constructor recorded (no timers)
 *  - trackingmore-sdk-nodejs    → constructed in the Shipping constructor
 *  - ../../src/prisma           → in-memory prisma stub
 *  - ../../src/cache            → Map-less get/set spies
 *  - ../../src/utils            → isMainServer stub (no EC2 probe)
 *  - ../../src/sitesettings     → getSettings stub
 *  - ../../src/shippingconfig   → getAllConfigs stub
 * ExcelJS and the date math run for real.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

const prismaMock = vi.hoisted(() => ({
  payment: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  shippingCostNew: { findMany: vi.fn() },
}));
vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const cacheMock = vi.hoisted(() => ({
  get: vi.fn(async () => null as string | null),
  set: vi.fn(async () => {}),
}));
vi.mock('../../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

const isMainServer = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = isMainServer;
  },
}));

const getSettings = vi.hoisted(() => vi.fn());
vi.mock('../../../src/sitesettings', () => ({
  default: { getInstance: () => ({ getSettings }) },
}));

const getAllConfigs = vi.hoisted(() => vi.fn(async () => [] as any[]));
vi.mock('../../../src/shippingconfig', () => ({
  default: { getInstance: () => ({ getAllConfigs }) },
}));

const cronCalls = vi.hoisted(() => [] as any[][]);
vi.mock('cron', () => ({
  CronJob: class {
    constructor(...args: any[]) {
      cronCalls.push(args);
    }
  },
}));

const trackingMoreCtor = vi.hoisted(() => vi.fn());
vi.mock('trackingmore-sdk-nodejs', () => ({
  default: class {
    constructor(apiKey: string) {
      trackingMoreCtor(apiKey);
    }
  },
}));

vi.mock('axios');
import axios from 'axios';
import Shipping from '../../../src/shipping';

const axiosRequest = vi.mocked(axios.request);

process.env['TRACKINGMORE_API_KEY'] = 'tm-test-key';
const shipping = Shipping.getInstance();

const TM_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Tracking-Api-Key': 'tm-test-key',
};

beforeEach(() => {
  axiosRequest.mockReset();
  prismaMock.payment.findUnique.mockReset();
  prismaMock.payment.findMany.mockReset();
  prismaMock.payment.update.mockReset();
  prismaMock.payment.count.mockReset();
  prismaMock.shippingCostNew.findMany.mockReset();
  cacheMock.get.mockReset();
  cacheMock.get.mockResolvedValue(null);
  cacheMock.set.mockReset();
  getSettings.mockReset();
  getAllConfigs.mockReset();
  getAllConfigs.mockResolvedValue([]);
});

describe('cron gating', () => {
  it('constructs the hourly auto-starting cron job under ENVIRONMENT=test (gate is "anything but development")', async () => {
    // The constructor gate is `isMainServer || ENVIRONMENT != 'development'`:
    // with isMainServer=false and ENVIRONMENT=test the job IS created. The
    // mocked CronJob never ticks, so no timer/network actually runs here.
    expect(process.env['ENVIRONMENT']).toBe('test');
    await new Promise((r) => setImmediate(r));
    expect(cronCalls).toHaveLength(1);
    const [spec, onTick, onComplete, start] = cronCalls[0];
    expect(spec).toBe('0 * * * *');
    expect(typeof onTick).toBe('function');
    expect(onComplete).toBeNull();
    expect(start).toBe(true);
  });

  it('the cron tick runs updateAllShippingStatuses over Shipped payments with a tracking code', async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    const onTick = cronCalls[0][1];
    await onTick();
    expect(prismaMock.payment.findMany).toHaveBeenCalledWith({
      where: {
        printApiStatus: 'Shipped',
        shippingCode: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('createShipment', () => {
  it('throws when the payment does not exist', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(null);
    await expect(shipping.createShipment('missing')).rejects.toThrow(
      'Payment with ID missing not found'
    );
  });

  it('returns null without touching TrackingMore when shippingId already exists', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      paymentId: 'p1',
      shippingId: 'tm-existing',
    });
    expect(await shipping.createShipment('p1')).toBeNull();
    expect(axiosRequest).not.toHaveBeenCalled();
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
  });

  it('throws when there is no tracking link and on malformed tracking URLs', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce({
      paymentId: 'p1',
      shippingId: null,
      printApiTrackingLink: null,
    });
    await expect(shipping.createShipment('p1')).rejects.toThrow(
      'No tracking link found for payment p1'
    );

    prismaMock.payment.findUnique.mockResolvedValueOnce({
      paymentId: 'p1',
      shippingId: null,
      printApiTrackingLink: 'https://short',
    });
    await expect(shipping.createShipment('p1')).rejects.toThrow(
      'Invalid tracking URL format: https://short'
    );
  });

  it('parses code/country/postal from the PostNL link, registers with TrackingMore and stores the tracking id', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      paymentId: 'p1',
      shippingId: null,
      printApiTrackingLink:
        'https://jouw.postnl.nl/track-and-trace/3SQRS123/NL/1111AA',
    });
    prismaMock.payment.update
      .mockResolvedValueOnce({}) // shipping info update
      .mockResolvedValueOnce({ paymentId: 'p1', shippingId: 'tm-1' });
    axiosRequest.mockResolvedValue({
      data: { meta: { code: 200 }, data: { id: 'tm-1' } },
    } as any);

    const updated = await shipping.createShipment('p1');

    expect(prismaMock.payment.update).toHaveBeenNthCalledWith(1, {
      where: { paymentId: 'p1' },
      data: {
        shippingCode: '3SQRS123',
        shippingCountry: 'NL',
        shippingPostalCode: '1111AA',
      },
    });
    expect(axiosRequest).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.trackingmore.com/v4/trackings/create',
      headers: TM_HEADERS,
      data: {
        tracking_number: '3SQRS123',
        courier_code: 'postnl-3s',
        tracking_postal_code: '1111AA',
        tracking_destination_country: 'NL',
      },
    });
    expect(prismaMock.payment.update).toHaveBeenNthCalledWith(2, {
      where: { paymentId: 'p1' },
      data: { shippingId: 'tm-1' },
    });
    expect(updated).toEqual({ paymentId: 'p1', shippingId: 'tm-1' });
  });

  it('keeps the parsed shipping info but stores no shippingId when TrackingMore rejects the shipment', async () => {
    const payment = {
      paymentId: 'p1',
      shippingId: null,
      printApiTrackingLink:
        'https://jouw.postnl.nl/track-and-trace/3SQRS123/DE/80331',
    };
    prismaMock.payment.findUnique
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce({ ...payment, shippingCode: '3SQRS123' });
    prismaMock.payment.update.mockResolvedValue({});
    axiosRequest.mockResolvedValue({
      data: { meta: { code: 400 }, data: null },
    } as any);

    const result = await shipping.createShipment('p1');

    expect(prismaMock.payment.update).toHaveBeenCalledTimes(1); // only the info update
    expect(result).toEqual({ ...payment, shippingCode: '3SQRS123' });
  });
});

describe('createAllShipments', () => {
  it('returns an empty summary when nothing needs processing', async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    expect(await shipping.createAllShipments()).toEqual({
      processed: 0,
      successful: 0,
      failed: 0,
      errors: [],
    });
    const where = prismaMock.payment.findMany.mock.calls[0][0].where;
    expect(where.printApiStatus).toBe('Shipped');
    expect(where.shippingId).toBeNull();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it('processes each payment and aggregates successes and per-payment failures', async () => {
    const byId: Record<string, any> = {
      p1: {
        paymentId: 'p1',
        shippingId: null,
        printApiTrackingLink:
          'https://jouw.postnl.nl/track-and-trace/3S1/NL/1111AA',
      },
      p2: { paymentId: 'p2', shippingId: null, printApiTrackingLink: null },
    };
    prismaMock.payment.findMany.mockResolvedValue([byId['p1'], byId['p2']]);
    prismaMock.payment.findUnique.mockImplementation(
      async ({ where }: any) => byId[where.paymentId]
    );
    prismaMock.payment.update.mockResolvedValue({});
    axiosRequest.mockResolvedValue({
      data: { meta: { code: 200 }, data: { id: 'tm-9' } },
    } as any);

    const summary = await shipping.createAllShipments();

    expect(summary).toEqual({
      processed: 2,
      successful: 1,
      failed: 1,
      errors: ['Payment p2: No tracking link found for payment p2'],
    });
  });
});

describe('getTrackingInfo', () => {
  const TM_GET = {
    method: 'GET',
    url: 'https://api.trackingmore.com/v4/trackings/get',
    params: { tracking_numbers: '3SX', courier_code: 'postnl-3s' },
    headers: TM_HEADERS,
  };

  it('throws for unknown payments and payments without a tracking number', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);
    await expect(shipping.getTrackingInfo('nope')).rejects.toThrow(
      'Payment with ID nope not found'
    );

    prismaMock.payment.findUnique.mockResolvedValueOnce({
      paymentId: 'p1',
      shippingCode: null,
    });
    await expect(shipping.getTrackingInfo('p1')).rejects.toThrow(
      'Payment p1 has no tracking number'
    );
  });

  it('never overwrites an already-delivered payment (fetches info but skips the DB update)', async () => {
    const payment = {
      paymentId: 'p1',
      shippingCode: '3SX',
      shippingStatus: 'delivered',
    };
    prismaMock.payment.findUnique.mockResolvedValue(payment);
    axiosRequest.mockResolvedValue({ data: { meta: { code: 200 } } } as any);

    const { result, updatedPayment } = await shipping.getTrackingInfo('p1');

    expect(axiosRequest).toHaveBeenCalledWith(TM_GET);
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
    expect(updatedPayment).toBe(payment);
    expect(result).toEqual({ meta: { code: 200 } });
  });

  it('maps a first transit scan to status/message/pickup and records the change type', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      paymentId: 'p1',
      shippingCode: '3SX',
      shippingStatus: null,
      shippingMessage: null,
      shippingStartDateTime: null,
      shippingDeliveryDateTime: null,
    });
    prismaMock.payment.update.mockResolvedValue({ paymentId: 'p1' });
    axiosRequest.mockResolvedValue({
      data: {
        meta: { code: 200 },
        data: [
          {
            delivery_status: 'transit',
            origin_info: {
              trackinfo: [{ tracking_detail: 'On its way' }],
              milestone_date: { pickup_date: '2026-06-01T08:00:00Z' },
            },
          },
        ],
      },
    } as any);

    await shipping.getTrackingInfo('p1');

    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'p1' },
      data: {
        shippingStatus: 'transit',
        shippingMessage: 'On its way',
        shippingStartDateTime: new Date('2026-06-01T08:00:00Z'),
        shippingDeliveryDateTime: null,
        shippingLastTrackedAt: expect.any(Date),
        shippingLastChangeType: 'unknown → transit, picked up',
      },
    });
  });

  it('maps a delivery scan to a delivery datetime and a "… → delivered, delivered" change type', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      paymentId: 'p1',
      shippingCode: '3SX',
      shippingStatus: 'transit',
      shippingMessage: 'On its way',
      shippingStartDateTime: new Date('2026-06-01T08:00:00Z'),
      shippingDeliveryDateTime: null,
    });
    prismaMock.payment.update.mockResolvedValue({ paymentId: 'p1' });
    axiosRequest.mockResolvedValue({
      data: {
        meta: { code: 200 },
        data: [
          {
            delivery_status: 'delivered',
            origin_info: {
              trackinfo: [
                {
                  tracking_detail: 'Delivered at neighbours',
                  checkpoint_date: '2026-06-03T10:00:00Z',
                },
              ],
              milestone_date: { pickup_date: '2026-06-01T08:00:00Z' },
            },
          },
        ],
      },
    } as any);

    await shipping.getTrackingInfo('p1');

    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'p1' },
      data: {
        shippingStatus: 'delivered',
        shippingMessage: 'Delivered at neighbours',
        shippingStartDateTime: new Date('2026-06-01T08:00:00Z'),
        shippingDeliveryDateTime: new Date('2026-06-03T10:00:00Z'),
        shippingLastTrackedAt: expect.any(Date),
        shippingLastChangeType: 'transit → delivered, delivered',
      },
    });
  });

  it('does not bump shippingLastTrackedAt when nothing changed', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      paymentId: 'p1',
      shippingCode: '3SX',
      shippingStatus: 'transit',
      shippingMessage: 'On its way',
      shippingStartDateTime: new Date('2026-06-01T08:00:00Z'),
      shippingDeliveryDateTime: null,
    });
    prismaMock.payment.update.mockResolvedValue({ paymentId: 'p1' });
    axiosRequest.mockResolvedValue({
      data: {
        meta: { code: 200 },
        data: [
          {
            delivery_status: 'transit',
            origin_info: {
              trackinfo: [{ tracking_detail: 'On its way' }],
              milestone_date: { pickup_date: '2026-06-01T08:00:00Z' },
            },
          },
        ],
      },
    } as any);

    await shipping.getTrackingInfo('p1');

    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'p1' },
      data: {
        shippingStatus: 'transit',
        shippingMessage: 'On its way',
        shippingStartDateTime: new Date('2026-06-01T08:00:00Z'),
        shippingDeliveryDateTime: null,
      },
    });
  });

  it('returns the payment untouched when TrackingMore has no data for the number', async () => {
    const payment = {
      paymentId: 'p1',
      shippingCode: '3SX',
      shippingStatus: null,
    };
    prismaMock.payment.findUnique.mockResolvedValue(payment);
    axiosRequest.mockResolvedValue({
      data: { meta: { code: 200 }, data: [] },
    } as any);

    const { updatedPayment } = await shipping.getTrackingInfo('p1');

    expect(updatedPayment).toBe(payment);
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
  });
});

describe('updateAllShippingStatuses', () => {
  it('returns a zero summary when no shipped payments exist', async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    expect(await shipping.updateAllShippingStatuses()).toEqual({
      processed: 0,
      delivered: 0,
      failed: 0,
      errors: [],
    });
  });

  it('promotes delivered shipments to printApiStatus=Delivered and collects per-payment errors', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      { paymentId: 'pp1' },
      { paymentId: 'pp2' },
    ]);
    prismaMock.payment.update.mockResolvedValue({});
    const spy = vi
      .spyOn(shipping, 'getTrackingInfo')
      .mockImplementation(async (paymentId: string) => {
        if (paymentId === 'pp1') {
          return {
            result: {},
            updatedPayment: { paymentId: 'pp1', shippingStatus: 'delivered' },
          } as any;
        }
        throw new Error('TM down');
      });

    try {
      const summary = await shipping.updateAllShippingStatuses();

      expect(summary).toEqual({
        processed: 2,
        delivered: 1,
        failed: 1,
        errors: ['Payment pp2: TM down'],
      });
      expect(prismaMock.payment.update).toHaveBeenCalledWith({
        where: { paymentId: 'pp1' },
        data: { printApiStatus: 'Delivered' },
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('getTracking', () => {
  it('builds the Shipped (in-transit) query with ignore filter, search, country and pagination', async () => {
    const rows = [{ paymentId: 'a' }];
    prismaMock.payment.findMany.mockResolvedValue(rows);
    prismaMock.payment.count.mockResolvedValue(250);

    const result = await shipping.getTracking('Shipped', 2, 100, ' Jane ', ' NL ');

    const args = prismaMock.payment.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      printApiStatus: 'Shipped',
      createdAt: { gte: expect.any(Date) },
      shippingCode: { not: null },
      shippingIgnore: false,
      fullname: { contains: 'Jane' },
      countrycode: 'NL',
    });
    expect(args.orderBy).toEqual([
      { shippingLastTrackedAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ]);
    expect(args.skip).toBe(100);
    expect(args.take).toBe(100);

    expect(result).toEqual({
      data: rows,
      totalItems: 250,
      currentPage: 2,
      itemsPerPage: 100,
      totalPages: 3,
    });
  });

  it('the Delivered query has no ignore filter and sorts by delivery date', async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.payment.count.mockResolvedValue(0);

    await shipping.getTracking('Delivered');

    const args = prismaMock.payment.findMany.mock.calls[0][0];
    expect('shippingIgnore' in args.where).toBe(false);
    expect('fullname' in args.where).toBe(false);
    expect(args.orderBy).toEqual([
      { shippingDeliveryDateTime: 'desc' },
      { createdAt: 'desc' },
    ]);
    expect(args.skip).toBe(0);
    expect(args.take).toBe(100);
  });
});

describe('getAvailableCountryCodes', () => {
  it('returns the sorted distinct country codes', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      { countrycode: 'NL' },
      { countrycode: 'BE' },
      { countrycode: null },
      { countrycode: 'DE' },
    ]);

    expect(await shipping.getAvailableCountryCodes()).toEqual(['BE', 'DE', 'NL']);

    const args = prismaMock.payment.findMany.mock.calls[0][0];
    expect(args.where.printApiStatus).toEqual({ in: ['Shipped', 'Delivered'] });
    expect(args.distinct).toEqual(['countrycode']);
  });
});

describe('exportTrackingToExcel', () => {
  // Mirrors the dd-MM-yyyy HH:mm local-time formatting used by the export.
  const fmt = (date: Date): string => {
    const d = new Date(date);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  it('exports Delivered rows with pickup→delivery day counts (floored, 0 becomes 1)', async () => {
    const start = new Date('2026-06-01T10:00:00Z');
    const delivery = new Date('2026-06-04T22:00:00Z'); // 3.5 days → 3
    const tracked = new Date('2026-06-04T23:00:00Z');
    prismaMock.payment.findMany.mockResolvedValue([
      {
        printApiOrderId: 'PO1',
        fullname: 'Jane',
        shippingStartDateTime: start,
        shippingDeliveryDateTime: delivery,
        shippingLastTrackedAt: tracked,
        shippingLastChangeType: 'transit → delivered',
      },
      {
        printApiOrderId: null,
        fullname: null,
        shippingStartDateTime: start,
        shippingDeliveryDateTime: start, // same instant → 0 → 1
        shippingLastTrackedAt: null,
        shippingLastChangeType: null,
      },
    ]);

    const buffer = await shipping.exportTrackingToExcel('Delivered');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Delivered')!;

    expect(ws.getRow(1).getCell(1).value).toBe('Print API Order ID');
    expect(ws.getRow(1).getCell(5).value).toBe('Days');

    const row2 = ws.getRow(2);
    expect(row2.getCell(1).value).toBe('PO1');
    expect(row2.getCell(2).value).toBe('Jane');
    expect(row2.getCell(3).value).toBe(fmt(start));
    expect(row2.getCell(4).value).toBe(fmt(delivery));
    expect(row2.getCell(5).value).toBe(3);
    expect(row2.getCell(6).value).toBe(fmt(tracked));
    expect(row2.getCell(7).value).toBe('transit → delivered');

    const row3 = ws.getRow(3);
    expect(row3.getCell(1).value).toBe('-');
    expect(row3.getCell(2).value).toBe('-');
    expect(row3.getCell(5).value).toBe(1);
    expect(row3.getCell(6).value).toBe('-');
    expect(row3.getCell(7).value).toBe('-');
  });

  it('exports In Transit rows with days-since-pickup and excludes ignored shipments', async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      {
        printApiOrderId: 'PO2',
        fullname: 'Bob',
        shippingStartDateTime: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago → 0 → 1
        shippingDeliveryDateTime: null,
        shippingLastTrackedAt: null,
        shippingLastChangeType: null,
      },
    ]);

    const buffer = await shipping.exportTrackingToExcel('Shipped');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('In Transit')!;

    expect(ws.getRow(2).getCell(1).value).toBe('PO2');
    expect(ws.getRow(2).getCell(5).value).toBe(1);

    const where = prismaMock.payment.findMany.mock.calls[0][0].where;
    expect(where.shippingIgnore).toBe(false);
  });
});

describe('toggleIgnoreStatus', () => {
  it('updates shippingIgnore and returns the trimmed selection', async () => {
    const updated = { paymentId: 'p1', orderId: 'QR1', shippingIgnore: true };
    prismaMock.payment.update.mockResolvedValue(updated);

    expect(await shipping.toggleIgnoreStatus('p1', true)).toBe(updated);
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'p1' },
      data: { shippingIgnore: true },
      select: { paymentId: true, orderId: true, shippingIgnore: true },
    });
  });

  it('rethrows database errors', async () => {
    prismaMock.payment.update.mockRejectedValue(new Error('db gone'));
    await expect(shipping.toggleIgnoreStatus('p1', false)).rejects.toThrow('db gone');
  });
});

describe('getAverageDeliveryTimes', () => {
  it('returns the cached value without querying the database', async () => {
    cacheMock.get.mockResolvedValue(JSON.stringify([{ countryCode: 'XX' }]));
    expect(await shipping.getAverageDeliveryTimes()).toEqual([{ countryCode: 'XX' }]);
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled();
    expect(cacheMock.get).toHaveBeenCalledWith('average_delivery_times');
  });

  it('computes per-country average/stddev/range, applies config offsets and caches for 1h', async () => {
    const day = 24 * 60 * 60 * 1000;
    const start = new Date('2026-06-01T00:00:00Z');
    prismaMock.payment.findMany.mockResolvedValue([
      // NL: 2 and 4 days → avg 3, stddev 1
      {
        countrycode: 'NL',
        shippingStartDateTime: start,
        shippingDeliveryDateTime: new Date(start.getTime() + 2 * day),
      },
      {
        countrycode: 'NL',
        shippingStartDateTime: start,
        shippingDeliveryDateTime: new Date(start.getTime() + 4 * day),
      },
      // DE: 0.2 days → rounds to 0 → forced to 1
      {
        countrycode: 'DE',
        shippingStartDateTime: start,
        shippingDeliveryDateTime: new Date(start.getTime() + 0.2 * day),
      },
    ]);
    getAllConfigs.mockResolvedValue([
      { countryCode: 'nl', minDaysOffset: -1, maxDaysOffset: 2 },
    ]);

    const result = await shipping.getAverageDeliveryTimes();

    // Sorted by (pre-adjustment) averageDays ascending: DE (1) before NL (3).
    // NL unadjusted: avg 3, sd 1, min max(1,3)=3, max 3+1+1=5.
    //   NOTE: minDays = max(1, averageDays) — the lower bound equals the
    //   average rather than average - stddev; asserted as actual behavior.
    // NL adjusted by config: min max(1, 3-1)=2, max max(2, 5+2)=7,
    //   avg round((2+7)/2)=5 (Math.round rounds 4.5 up).
    expect(result).toEqual([
      {
        countryCode: 'DE',
        averageDays: 1,
        standardDeviation: 0,
        minDays: 1,
        maxDays: 2,
        orderCount: 1,
      },
      {
        countryCode: 'NL',
        averageDays: 5,
        standardDeviation: 1,
        minDays: 2,
        maxDays: 7,
        orderCount: 2,
      },
    ]);
    expect(cacheMock.set).toHaveBeenCalledWith(
      'average_delivery_times',
      JSON.stringify(result),
      3600
    );
  });
});

describe('getShippingInfoByCountry', () => {
  it('returns the cached payload when present', async () => {
    cacheMock.get.mockResolvedValue(
      JSON.stringify({ productionDays: 9, productionMessage: null, countries: [] })
    );
    expect(await shipping.getShippingInfoByCountry()).toEqual({
      productionDays: 9,
      productionMessage: null,
      countries: [],
    });
    expect(cacheMock.get).toHaveBeenCalledWith('shipping_info_by_country_v4');
    expect(prismaMock.shippingCostNew.findMany).not.toHaveBeenCalled();
  });

  it('combines delivery times with adjusted shipping costs and sorts NL/DE/BE first', async () => {
    getSettings.mockResolvedValue({ productionDays: 5, productionMessage: 'Busy' });
    prismaMock.shippingCostNew.findMany.mockResolvedValue([
      { country: 'NL', size: 1, cost: 5 },
      { country: 'NL', size: 2, cost: 6 },
      { country: 'ES', size: 1, cost: 9 },
      { country: 'DE', size: 1, cost: 7.5 },
      { country: 'AT', size: 1, cost: 8 },
    ]);
    const spy = vi
      .spyOn(shipping, 'getAverageDeliveryTimes')
      .mockResolvedValue([
        { countryCode: 'NL', averageDays: 3, standardDeviation: 1, minDays: 3, maxDays: 5, orderCount: 2 },
        { countryCode: 'DE', averageDays: 4, standardDeviation: 1, minDays: 4, maxDays: 6, orderCount: 1 },
      ]);

    try {
      const result = await shipping.getShippingInfoByCountry();

      expect(result.productionDays).toBe(5);
      expect(result.productionMessage).toBe('Busy');
      // NL pinned to 2.99, ES pinned to 3.90, all others cost - 1.
      // Countries with costs but no delivery data are appended with zeros.
      // Sort: priority NL, DE, BE, then alphabetical.
      expect(result.countries).toEqual([
        {
          countryCode: 'NL',
          averageDays: 3,
          minDays: 3,
          maxDays: 5,
          orderCount: 2,
          shippingCosts: [
            { size: 1, cost: 2.99 },
            { size: 2, cost: 2.99 },
          ],
        },
        {
          countryCode: 'DE',
          averageDays: 4,
          minDays: 4,
          maxDays: 6,
          orderCount: 1,
          shippingCosts: [{ size: 1, cost: 6.5 }],
        },
        {
          countryCode: 'AT',
          averageDays: 0,
          minDays: 0,
          maxDays: 0,
          orderCount: 0,
          shippingCosts: [{ size: 1, cost: 7 }],
        },
        {
          countryCode: 'ES',
          averageDays: 0,
          minDays: 0,
          maxDays: 0,
          orderCount: 0,
          shippingCosts: [{ size: 1, cost: 3.9 }],
        },
      ]);
      expect(cacheMock.set).toHaveBeenCalledWith(
        'shipping_info_by_country_v4',
        JSON.stringify(result),
        3600
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('defaults productionDays to 3 when settings are missing', async () => {
    getSettings.mockResolvedValue(null);
    prismaMock.shippingCostNew.findMany.mockResolvedValue([]);
    const spy = vi
      .spyOn(shipping, 'getAverageDeliveryTimes')
      .mockResolvedValue([]);
    try {
      const result = await shipping.getShippingInfoByCountry();
      expect(result).toEqual({
        productionDays: 3,
        productionMessage: null,
        countries: [],
      });
    } finally {
      spy.mockRestore();
    }
  });
});
