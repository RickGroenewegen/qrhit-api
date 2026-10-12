/**
 * Unit tests for src/postnlTracking.ts: PostNL's public track & trace,
 * mapped onto the payment's tracking fields.
 *
 * The parcels below are real answers of the endpoint (2026-10-12) for
 * Print&Bind shipments, cut down to the fields we read; recipient, sender and
 * address fields are left out. axios is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios');
import axios from 'axios';
import PostNLTracking, {
  normalisePostalCode,
  parseCollo,
} from '../../../src/postnlTracking';

const axiosGet = vi.mocked(axios.get);
const tracking = PostNLTracking.getInstance();

const PRE_ANNOUNCED_DE = {
  isDelivered: false,
  deliveryDate: null,
  statusPhase: {
    index: 0,
    message: 'Shipment expected, but not yet arrived or processed at PostNL',
  },
  isAtRetailLocation: false,
  isPickedUpAtRetailLocation: false,
  isReturnShipment: false,
  expectedReturnDate: null,
  networkPartnerName: 'Deutsche Post',
  observations: [],
};

// Missed at the door, left at a pick-up point, then collected
const DELIVERED_DE_VIA_PICKUP_POINT = {
  isDelivered: true,
  deliveryDate: '2026-10-07T16:29:00+02:00',
  statusPhase: {
    index: 4,
    message: 'Yes! Your shipment has been delivered to the recipient',
  },
  isAtRetailLocation: false,
  isPickedUpAtRetailLocation: false,
  isReturnShipment: false,
  expectedReturnDate: null,
  networkPartnerName: 'Deutsche Post',
  internationalStatus: { isForeignShipment: true, phase: 'DeliveredAtRecipient' },
  observations: [
    { observationDate: '2026-10-06T16:18:00+02:00', observationCode: 'X05', description: 'Shipment to be collected at pick-up location' },
    { observationDate: '2026-10-06T15:49:00+02:00', observationCode: 'Y10', description: 'We missed you; we’ll try again' },
    { observationDate: '2026-10-05T16:38:00+02:00', observationCode: 'Y62', description: 'Shipment is delayed due to transportation issues ' },
    { observationDate: '2026-10-05T08:43:00+02:00', observationCode: 'X08', description: "Your parcel's at a sorting centre in the destination country" },
    { observationDate: '2026-10-02T02:00:00+02:00', observationCode: 'X02', description: 'Yes! Your shipment has arrived in the destination country' },
    { observationDate: '2026-10-01T08:08:43.92+02:00', observationCode: 'Q12', description: 'Your parcel has crossed the border' },
    { observationDate: '2026-09-30T22:48:15.177+02:00', observationCode: 'J06', description: 'Shipment sorted in sorting centre' },
    { observationDate: '2026-09-30T22:47:55+02:00', observationCode: 'B01', description: 'Shipment received by PostNL' },
    { observationDate: '2026-09-30T22:46:55.579+02:00', observationCode: 'J06', description: 'Shipment sorted in sorting centre' },
    { observationDate: '2026-09-30T21:32:51.631+02:00', observationCode: 'A01', description: 'Shipment expected, but not yet arrived or processed at PostNL' },
  ],
};

// internationalStatus still says ReceivedByPostNl after delivery
const DELIVERED_NL_LETTERBOX = {
  isDelivered: true,
  deliveryDate: '2026-10-01T11:21:20+02:00',
  statusPhase: { index: 4, message: 'Shipment in letterbox' },
  isAtRetailLocation: false,
  isPickedUpAtRetailLocation: false,
  isReturnShipment: false,
  expectedReturnDate: null,
  networkPartnerName: null,
  internationalStatus: { isForeignShipment: false, phase: 'ReceivedByPostNl' },
  observations: [
    { observationDate: '2026-10-01T08:38:33+02:00', observationCode: 'J05', description: 'Driver is en route' },
    { observationDate: '2026-10-01T07:48:27+02:00', observationCode: 'J01', description: 'Shipment has been sorted' },
    { observationDate: '2026-09-30T22:42:53+02:00', observationCode: 'B01', description: 'Shipment received by PostNL' },
    { observationDate: '2026-09-30T17:09:57.117+02:00', observationCode: 'A01', description: 'Shipment expected, but not yet arrived or processed at PostNL' },
  ],
};

beforeEach(() => {
  axiosGet.mockReset();
});

describe('parseCollo', () => {
  it('a pre-announced parcel is inforeceived, not picked up', () => {
    expect(parseCollo(PRE_ANNOUNCED_DE)).toEqual({
      status: 'inforeceived',
      message: 'Shipment expected, but not yet arrived or processed at PostNL',
      pickedUpAt: null,
      deliveredAt: null,
    });
  });

  it('a delivered parcel abroad: picked up at the first real scan, delivered at deliveryDate', () => {
    expect(parseCollo(DELIVERED_DE_VIA_PICKUP_POINT)).toEqual({
      status: 'delivered',
      message: 'Yes! Your shipment has been delivered to the recipient',
      pickedUpAt: new Date('2026-09-30T22:46:55.579+02:00'),
      deliveredAt: new Date('2026-10-07T16:29:00+02:00'),
    });
  });

  it('a delivered domestic parcel is delivered whatever internationalStatus says', () => {
    expect(parseCollo(DELIVERED_NL_LETTERBOX)).toEqual({
      status: 'delivered',
      message: 'Shipment in letterbox',
      pickedUpAt: new Date('2026-09-30T22:42:53+02:00'),
      deliveredAt: new Date('2026-10-01T11:21:20+02:00'),
    });
  });

  it('in transit: transit with the newest scan as the message', () => {
    const inTransit = {
      ...DELIVERED_NL_LETTERBOX,
      isDelivered: false,
      deliveryDate: null,
      statusPhase: { index: 2, message: 'Shipment is being sorted' },
    };
    expect(parseCollo(inTransit)).toMatchObject({
      status: 'transit',
      message: 'Driver is en route',
      deliveredAt: null,
    });
  });

  it('waiting at a pick-up point is pickup, a return is exception', () => {
    const atPoint = {
      ...DELIVERED_DE_VIA_PICKUP_POINT,
      isDelivered: false,
      isAtRetailLocation: true,
    };
    expect(parseCollo(atPoint).status).toBe('pickup');
    expect(
      parseCollo({ ...atPoint, isPickedUpAtRetailLocation: true }).status
    ).toBe('transit');
    expect(parseCollo({ ...atPoint, isReturnShipment: true }).status).toBe(
      'exception'
    );
    expect(
      parseCollo({ ...atPoint, expectedReturnDate: '2026-10-20' }).status
    ).toBe('exception');
  });
});

describe('normalisePostalCode', () => {
  it('drops spaces and dashes, decodes and upper-cases', () => {
    expect(normalisePostalCode('1234 ab')).toBe('1234AB');
    expect(normalisePostalCode('1234%20AB')).toBe('1234AB');
    expect(normalisePostalCode('00-950')).toBe('00950');
    expect(normalisePostalCode('SW1A 1AA')).toBe('SW1A1AA');
    expect(normalisePostalCode('100%')).toBe('100%');
  });
});

describe('fetchStatus', () => {
  it('asks the public endpoint for barcode-country-postcode and maps the parcel', async () => {
    axiosGet.mockResolvedValue({
      data: { colli: { '3STEST0000001': DELIVERED_NL_LETTERBOX } },
    } as any);

    const result = await tracking.fetchStatus('3STEST0000001', 'nl', '1234 AB');

    expect(axiosGet).toHaveBeenCalledWith(
      'https://jouw.postnl.nl/track-and-trace/api/trackAndTrace/3STEST0000001-NL-1234AB',
      {
        params: { language: 'en' },
        headers: { Accept: 'application/json' },
        timeout: 15000,
      }
    );
    expect(result?.status).toBe('delivered');
  });

  it('is null when PostNL does not know the parcel', async () => {
    axiosGet.mockResolvedValue({
      data: { colli: {}, processed: '2026-10-12T10:48:48+02:00' },
    } as any);
    expect(await tracking.fetchStatus('3SX', 'DE', '99999')).toBeNull();
  });

  it('throws when the answer is not PostNL JSON (a bot wall, an HTML error page)', async () => {
    axiosGet.mockResolvedValue({ data: '<html>Access denied</html>' } as any);
    await expect(tracking.fetchStatus('3SX', 'DE', '82024')).rejects.toThrow(
      'PostNL track & trace answered without parcel data'
    );
  });
});
