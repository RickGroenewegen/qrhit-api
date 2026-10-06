/**
 * Shipping for branded SK2 boxes printed by Schneiders, who ship with DHL.
 *
 * Within the Netherlands shipping is included in the box price; abroad it is
 * an extra the Schneider calculator estimates here (and the admin can force).
 * It travels as an ordinary one-off extra with `key: 'shipping'`, so the
 * quotation, the price snapshot and the MoneyBird invoice carry it like the
 * cutting die. Schneiders bills it to us, so it is a cost passed through and
 * part of the printer cost as well as the client price.
 *
 * Everything here is an estimate: Schneiders' own DHL rates are unknown.
 */
import { normalizeCountryIso } from './services/vat';
import { round2 } from './listPricing';

/** Outer carton ("omdoos", "Umkarton") a size of box is shipped in. */
export interface CartonSpec {
  boxesPerCarton: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  /** Weight of the empty carton. */
  tareKg: number;
}

const CARTON_40x30x15 = { lengthCm: 40, widthCm: 30, heightCm: 15, tareKg: 0.4 };
const CARTON_31x22x15_5 = { lengthCm: 31, widthCm: 22, heightCm: 15.5, tareKg: 0.25 };

/** Per card count, Rick's numbers from Schneiders (2026-10-06). */
export const CARTON_SPECS: Record<number, CartonSpec> = {
  192: { boxesPerCarton: 18, ...CARTON_40x30x15 },
  // 144 is a hidden size nobody has shipped yet: assumed to pack like 192.
  144: { boxesPerCarton: 18, ...CARTON_40x30x15 },
  96: { boxesPerCarton: 36, ...CARTON_40x30x15 },
  48: { boxesPerCarton: 106, ...CARTON_31x22x15_5 },
};

/**
 * Weight of one filled box. Only the 192 box was weighed (≈ 0.26 kg); the
 * others are estimates from one card of 56x56 mm on 350 g/m² board (≈ 1.1 g)
 * times the cards, plus the box itself.
 */
export const BOX_WEIGHT_KG: Record<number, number> = {
  192: 0.26,
  144: 0.21,
  96: 0.15,
  48: 0.07,
};

/** Euro pallet, 120x80, loaded to 165 cm on top of its own 15 cm. */
export const EURO_PALLET = {
  lengthCm: 120,
  widthCm: 80,
  maxLoadHeightCm: 165,
  tareKg: 25,
  maxGrossKg: 750,
} as const;

export interface ParcelRate {
  /** Upper bound of the gross weight class, inclusive. */
  maxKg: number;
  price: number;
}

/*
 * Rates in EUR excl. VAT. Source: the InTime Delivery tariff list 2026
 * ("DHL Europa"), list prices including the fuel surcharge, per parcel by
 * gross weight. Belgium is on the DHL NL&BE "Pakket" tariff, which has other
 * weight classes. Schneiders' own DHL rates are unknown, so these are an
 * estimate; force the price in the calculator once the real one is known.
 */
const EUROPE_CLASSES_KG = [2, 5, 15, 31.5] as const;
const europe = (...prices: [number, number, number, number]): ParcelRate[] =>
  EUROPE_CLASSES_KG.map((maxKg, i) => ({ maxKg, price: prices[i]! }));

const SK_SI_HR = europe(17.12, 19.12, 24.55, 31.29);
const BALTICS = europe(26.82, 30.78, 41.45, 53.27);

export const PARCEL_RATES: Record<string, ParcelRate[]> = {
  BE: [
    { maxKg: 10, price: 9.4 },
    { maxKg: 15, price: 10.48 },
    { maxKg: 20, price: 13.72 },
    { maxKg: 31.5, price: 24.42 },
  ],
  DE: europe(9.7, 10.5, 11.23, 13.1),
  AT: europe(13.28, 15.74, 19.98, 28.0),
  LU: europe(10.65, 11.55, 12.35, 14.37),
  FR: europe(12.89, 15.28, 19.39, 27.17),
  IT: europe(15.88, 18.25, 22.75, 29.55),
  PL: europe(13.61, 16.04, 20.57, 28.44),
  CZ: europe(14.11, 16.26, 21.41, 28.47),
  ES: europe(21.05, 23.44, 27.54, 35.3),
  PT: europe(22.65, 25.09, 29.17, 36.89),
  DK: europe(25.01, 28.66, 35.29, 43.61),
  SE: europe(25.95, 29.67, 36.52, 45.32),
  FI: europe(27.74, 31.9, 46.29, 61.26),
  HU: europe(17.51, 19.56, 25.11, 32.01),
  SK: SK_SI_HR,
  SI: SK_SI_HR,
  HR: SK_SI_HR,
  IE: europe(17.17, 19.74, 24.63, 32.01),
  GR: europe(20.85, 23.27, 30.12, 38.49),
  BG: europe(20.28, 22.69, 29.35, 37.51),
  RO: europe(18.46, 21.2, 26.81, 35.55),
  EE: BALTICS,
  LV: BALTICS,
  LT: BALTICS,
};

/**
 * Price per pallet. DE is Rick's figure for Medienwerft (2026-10-06); no
 * other pallet rate is known, so elsewhere only parcels are estimated.
 */
export const PALLET_RATES: Record<string, number> = {
  DE: 200,
};

/** Where shipping is included in the box price. */
export const HOME_COUNTRY = 'NL';

export type ShippingMode = 'included' | 'parcel' | 'pallet' | 'unknown';

export interface BusinessShipping {
  /** ISO 3166-1 alpha-2; 'NL' when none was given, null when unrecognizable. */
  country: string | null;
  /** Shipping to the Netherlands is part of the box price. */
  included: boolean;
  cartons: number;
  boxesPerCarton: number;
  /** Gross weight of one full carton. */
  cartonWeightKg: number;
  /** Gross weight of all cartons together (pallets not counted). */
  totalWeightKg: number;
  /** Pallets a pallet shipment would take, whichever mode is cheaper. */
  pallets: number | null;
  cartonsPerPallet: number | null;
  /** Sending every carton as a DHL parcel; null without a rate. */
  parcelTotal: number | null;
  /** Sending the cartons on pallets; null without a pallet rate. */
  palletTotal: number | null;
  mode: ShippingMode;
  /** 0 when included, null when no rate is known for the country. */
  estimate: number | null;
  /** True when forceShippingPrice set the price. */
  forced: boolean;
  /** What is charged, excl. VAT: the forced price, else the estimate, else 0. */
  price: number;
}

/** Cartons per pallet: the better of the two orientations per layer, capped by weight. */
export function cartonsPerEuroPallet(spec: CartonSpec, cartonWeightKg: number): number {
  const { lengthCm: L, widthCm: W, maxLoadHeightCm, tareKg, maxGrossKg } = EURO_PALLET;
  const perLayer = Math.max(
    Math.floor(L / spec.lengthCm) * Math.floor(W / spec.widthCm),
    Math.floor(L / spec.widthCm) * Math.floor(W / spec.lengthCm)
  );
  const layers = Math.floor(maxLoadHeightCm / spec.heightCm);
  const byWeight = Math.floor((maxGrossKg - tareKg) / cartonWeightKg);
  return Math.max(0, Math.min(perLayer * layers, byWeight));
}

/** DHL price for one parcel of this gross weight, or null when it fits no class. */
export function parcelPrice(rates: ParcelRate[], weightKg: number): number | null {
  const rate = rates.find((r) => weightKg <= r.maxKg);
  return rate ? rate.price : null;
}

/**
 * A forced shipping price: a finite number >= 0 (0 is explicitly free).
 * Null, undefined, blank strings and negatives mean "use the estimate".
 */
export function parseForcedShippingPrice(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

/**
 * Estimate shipping for `quantity` boxes of `cardCount` cards to `country`
 * (ISO code or name; absent means the Netherlands). The last carton may be
 * partial and is priced at its own weight. The mode is the cheaper of the
 * known options. Returns null for a card count without a carton spec or an
 * invalid quantity.
 */
export function estimateBusinessShipping(params: {
  cardCount: number;
  quantity: number;
  country?: string | null;
  forceShippingPrice?: number | string | null;
}): BusinessShipping | null {
  const spec = CARTON_SPECS[params.cardCount];
  const boxKg = BOX_WEIGHT_KG[params.cardCount];
  const quantity = Math.ceil(Number(params.quantity));
  if (!spec || boxKg === undefined || !Number.isFinite(quantity) || quantity < 1) {
    return null;
  }

  const rawCountry = typeof params.country === 'string' ? params.country.trim() : '';
  const country = rawCountry ? normalizeCountryIso(rawCountry) : HOME_COUNTRY;
  const included = country === HOME_COUNTRY;

  const { boxesPerCarton } = spec;
  const fullCartons = Math.floor(quantity / boxesPerCarton);
  const lastCartonBoxes = quantity - fullCartons * boxesPerCarton;
  const cartons = fullCartons + (lastCartonBoxes > 0 ? 1 : 0);
  const cartonWeightKg = round2(boxesPerCarton * boxKg + spec.tareKg);
  const lastCartonWeightKg =
    lastCartonBoxes > 0 ? round2(lastCartonBoxes * boxKg + spec.tareKg) : 0;
  const totalWeightKg = round2(fullCartons * cartonWeightKg + lastCartonWeightKg);

  const perPallet = cartonsPerEuroPallet(spec, cartonWeightKg);
  const cartonsPerPallet = perPallet > 0 ? perPallet : null;
  const pallets = cartonsPerPallet ? Math.ceil(cartons / cartonsPerPallet) : null;

  let parcelTotal: number | null = null;
  let palletTotal: number | null = null;
  if (!included && country) {
    const rates = PARCEL_RATES[country];
    if (rates) {
      const full = fullCartons > 0 ? parcelPrice(rates, cartonWeightKg) : 0;
      const last = lastCartonBoxes > 0 ? parcelPrice(rates, lastCartonWeightKg) : 0;
      if (full !== null && last !== null) {
        parcelTotal = round2(fullCartons * full + last);
      }
    }
    const palletRate = PALLET_RATES[country];
    if (palletRate !== undefined && pallets !== null) {
      palletTotal = round2(pallets * palletRate);
    }
  }

  let mode: ShippingMode;
  let estimate: number | null;
  if (included) {
    mode = 'included';
    estimate = 0;
  } else if (palletTotal !== null && (parcelTotal === null || palletTotal < parcelTotal)) {
    mode = 'pallet';
    estimate = palletTotal;
  } else if (parcelTotal !== null) {
    mode = 'parcel';
    estimate = parcelTotal;
  } else {
    mode = 'unknown';
    estimate = null;
  }

  const forcedPrice = parseForcedShippingPrice(params.forceShippingPrice);
  const forced = forcedPrice !== null;

  return {
    country,
    included,
    cartons,
    boxesPerCarton,
    cartonWeightKg,
    totalWeightKg,
    pallets,
    cartonsPerPallet,
    parcelTotal,
    palletTotal,
    mode,
    estimate,
    forced,
    price: forced ? forcedPrice : (estimate ?? 0),
  };
}

/** The `keyVars` of the shipping extra (see calculateSchneiderPricing). */
export function shippingExtraKeyVars(shipping: BusinessShipping): {
  country: string | null;
  cartons: number;
  pallets: number;
  mode: ShippingMode;
} {
  return {
    country: shipping.country,
    cartons: shipping.cartons,
    // The line says "on N pallets" only when it goes by pallet.
    pallets: shipping.mode === 'pallet' ? (shipping.pallets ?? 0) : 0,
    mode: shipping.mode,
  };
}

type Translate = (key: string, vars?: Record<string, any>) => string;

/**
 * The words for a shipping extra, from the business bundle's `extras.*`
 * (`tExtra`) and the main bundle's country names in the same language:
 * "Versand nach Deutschland" with "34 Umkartons auf 1 Palette".
 *
 * A country whose name takes an article or another preposition in one of the
 * three languages ("in die Schweiz", "the Netherlands") has its own
 * `extras.shippingTo.<ISO>` phrase; every other country uses
 * `extras.shipping` with its name.
 */
export function shippingLineText(
  tExtra: Translate,
  keyVars: Record<string, any> | null | undefined,
  countryNames: Record<string, string> | null | undefined
): { description: string; details: string } {
  const iso =
    typeof keyVars?.['country'] === 'string' ? keyVars['country'].trim().toUpperCase() : '';

  let description: string;
  const phraseKey = `shippingTo.${iso}`;
  const phrase = iso ? tExtra(phraseKey) : phraseKey;
  if (iso && phrase !== phraseKey) {
    description = phrase;
  } else if (iso) {
    description = tExtra('shipping', { countryName: countryNames?.[iso] || iso });
  } else {
    description = tExtra('shippingGeneric');
  }

  const cartons = Math.max(0, Math.floor(Number(keyVars?.['cartons']) || 0));
  const pallets = Math.max(0, Math.floor(Number(keyVars?.['pallets']) || 0));
  let details = '';
  if (cartons === 1) {
    details = tExtra('shippingCartonOne');
  } else if (cartons > 1 && pallets === 1) {
    details = tExtra('shippingCartonsOnePallet', { cartons });
  } else if (cartons > 1 && pallets > 1) {
    details = tExtra('shippingCartonsPallets', { cartons, pallets });
  } else if (cartons > 1) {
    details = tExtra('shippingCartons', { cartons });
  }

  return { description, details };
}
