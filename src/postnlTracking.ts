import axios from 'axios';

/**
 * Parcel status from PostNL's public track & trace.
 *
 * Print&Bind ships on its own PostNL contract, so PostNL's Shippingstatus API
 * (our key, see postnl.ts) cannot see these parcels. The page behind every
 * tracking link reads this JSON endpoint instead, which needs no account: the
 * barcode, the destination country and the recipient's postcode are the key
 * (a wrong postcode answers with no parcel). It replaced TrackingMore, which
 * did the same lookup for us.
 */

const ENDPOINT = 'https://jouw.postnl.nl/track-and-trace/api/trackAndTrace';

// Observation code for "Shipment expected, but not yet arrived or processed at
// PostNL": the label exists, the parcel has not been scanned.
const PRE_ANNOUNCED = 'A01';

/**
 * TrackingMore's vocabulary, kept because the admin tracking page and the
 * chat read these values from payments.shippingStatus.
 */
export type ParcelStatus =
  | 'inforeceived'
  | 'transit'
  | 'pickup'
  | 'delivered'
  | 'exception';

export interface ParcelTracking {
  status: ParcelStatus;
  message: string | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
}

/** Spaces and dashes out: PostNL ignores both, and the dash separates the key. */
export function normalisePostalCode(postalCode: string): string {
  let value = postalCode;
  try {
    value = decodeURIComponent(postalCode);
  } catch {
    // Not URL-encoded
  }
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

/**
 * One parcel ("collo") of the endpoint's answer, mapped onto our fields.
 *
 * - `observations` are newest first and never contain the delivery itself:
 *   that is `deliveryDate` with `isDelivered`.
 * - Picked up is the first real scan, so not the pre-announcement.
 * - `internationalStatus` is deliberately unused: it still says
 *   `ReceivedByPostNl` for a domestic parcel that has been delivered.
 */
export function parseCollo(collo: any): ParcelTracking {
  const observations: any[] = Array.isArray(collo?.observations)
    ? collo.observations
    : [];
  const scans = observations.filter(
    (o) => o?.observationCode !== PRE_ANNOUNCED && o?.observationDate
  );
  const firstScan = scans[scans.length - 1];
  const delivered = collo?.isDelivered === true;

  let status: ParcelStatus;
  if (delivered) {
    status = 'delivered';
  } else if (collo?.isReturnShipment || collo?.expectedReturnDate) {
    status = 'exception';
  } else if (collo?.isAtRetailLocation && !collo?.isPickedUpAtRetailLocation) {
    status = 'pickup';
  } else if (scans.length === 0) {
    status = 'inforeceived';
  } else {
    status = 'transit';
  }

  const message =
    (delivered ? collo?.statusPhase?.message : observations[0]?.description) ||
    collo?.statusPhase?.message ||
    null;

  return {
    status,
    message: typeof message === 'string' ? message.trim() : null,
    pickedUpAt: firstScan ? new Date(firstScan.observationDate) : null,
    deliveredAt:
      delivered && collo?.deliveryDate ? new Date(collo.deliveryDate) : null,
  };
}

class PostNLTracking {
  private static instance: PostNLTracking;

  public static getInstance(): PostNLTracking {
    if (!PostNLTracking.instance) {
      PostNLTracking.instance = new PostNLTracking();
    }
    return PostNLTracking.instance;
  }

  /**
   * Status of one parcel, or null when PostNL does not know this
   * barcode/country/postcode combination. Throws when PostNL does not answer
   * with its JSON (down, or a bot wall in front of it).
   */
  public async fetchStatus(
    barcode: string,
    country: string,
    postalCode: string
  ): Promise<ParcelTracking | null> {
    const key = [
      barcode.trim().toUpperCase(),
      country.trim().toUpperCase(),
      normalisePostalCode(postalCode),
    ]
      .map(encodeURIComponent)
      .join('-');

    const { data } = await axios.get(`${ENDPOINT}/${key}`, {
      params: { language: 'en' },
      headers: { Accept: 'application/json' },
      timeout: 15000,
    });

    if (!data || typeof data !== 'object' || typeof data.colli !== 'object') {
      throw new Error('PostNL track & trace answered without parcel data');
    }

    const collo =
      data.colli[barcode.trim().toUpperCase()] ??
      Object.values(data.colli)[0];
    return collo ? parseCollo(collo) : null;
  }
}

export default PostNLTracking;
