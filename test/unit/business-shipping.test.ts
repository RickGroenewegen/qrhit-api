import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CARTON_SPECS,
  PARCEL_RATES,
  cartonsPerEuroPallet,
  estimateBusinessShipping,
  parcelPrice,
  parseForcedShippingPrice,
  shippingExtraKeyVars,
  shippingLineText,
} from '../../src/businessShipping';

const estimate = (
  cardCount: number,
  quantity: number,
  country?: string | null,
  forceShippingPrice?: number | string | null
) => estimateBusinessShipping({ cardCount, quantity, country, forceShippingPrice })!;

describe('estimateBusinessShipping', () => {
  it('600 boxes of 192 to Germany: 34 cartons on one pallet, which beats parcels', () => {
    expect(estimate(192, 600, 'DE')).toEqual({
      country: 'DE',
      included: false,
      cartons: 34, // 33 full cartons of 18 and one of 6
      boxesPerCarton: 18,
      cartonWeightKg: 5.08, // 18 x 0.26 + 0.4
      totalWeightKg: 169.6, // 33 x 5.08 + (6 x 0.26 + 0.4)
      pallets: 1,
      cartonsPerPallet: 88, // 8 per layer x 11 layers, 472 kg gross
      parcelTotal: 380.29, // 33 x 11.23 (up to 15 kg) + 9.70 (up to 2 kg)
      palletTotal: 200,
      mode: 'pallet',
      estimate: 200,
      forced: false,
      price: 200,
    });
  });

  it('20 boxes of 192 to Germany: two parcels, the partial one at its own weight', () => {
    const s = estimate(192, 20, 'DE');
    expect(s.cartons).toBe(2);
    expect(s.pallets).toBe(1);
    expect(s.parcelTotal).toBe(20.93); // 11.23 + 9.70
    expect(s.palletTotal).toBe(200);
    expect(s.mode).toBe('parcel');
    expect(s.estimate).toBe(20.93);
    expect(s.price).toBe(20.93);
  });

  it('a large order to Germany takes several pallets', () => {
    const s = estimate(192, 2000, 'DE');
    expect(s.cartons).toBe(112); // 111 x 18 + 2
    expect(s.pallets).toBe(2);
    expect(s.palletTotal).toBe(400);
    expect(s.parcelTotal).toBe(1256.23); // 111 x 11.23 + 9.70
    expect(s).toMatchObject({ mode: 'pallet', estimate: 400 });
  });

  it('the Netherlands is included in the box price', () => {
    for (const country of ['NL', 'nl', 'Nederland', 'the Netherlands', null, undefined, '  ']) {
      expect(estimate(192, 600, country)).toMatchObject({
        country: 'NL',
        included: true,
        cartons: 34,
        pallets: 1,
        parcelTotal: null,
        palletTotal: null,
        mode: 'included',
        estimate: 0,
        forced: false,
        price: 0,
      });
    }
  });

  it('a country without rates has no estimate', () => {
    expect(estimate(192, 600, 'CH')).toMatchObject({
      country: 'CH',
      included: false,
      cartons: 34,
      parcelTotal: null,
      palletTotal: null,
      mode: 'unknown',
      estimate: null,
      price: 0,
    });
    // Unrecognizable text is not the Netherlands either.
    expect(estimate(192, 600, 'Atlantis')).toMatchObject({
      country: null,
      included: false,
      mode: 'unknown',
      estimate: null,
      price: 0,
    });
  });

  it('accepts lowercase codes and country names', () => {
    expect(estimate(192, 20, 'de').country).toBe('DE');
    expect(estimate(192, 20, 'Duitsland').country).toBe('DE');
    expect(estimate(192, 20, 'Germany').estimate).toBe(20.93);
  });

  it('48 cards: 106 boxes in a 31x22x15.5 carton, pallets capped by weight', () => {
    const s = estimate(48, 1000, 'DE');
    expect(s.boxesPerCarton).toBe(106);
    expect(s.cartons).toBe(10); // 9 x 106 + 46
    expect(s.cartonWeightKg).toBe(7.67); // 106 x 0.07 + 0.25
    // 10 per layer x 10 layers would be 792 kg gross: 94 cartons stay under 750.
    expect(s.cartonsPerPallet).toBe(94);
    expect(s.parcelTotal).toBe(111.57); // 9 x 11.23 + 10.50 (46 boxes, 3.47 kg)
    expect(s.mode).toBe('parcel');
  });

  it('96 and 144 cards use the 40x30x15 carton (144 assumed like 192)', () => {
    expect(estimate(96, 100, 'DE')).toMatchObject({
      boxesPerCarton: 36,
      cartons: 3,
      cartonWeightKg: 5.8,
    });
    expect(estimate(144, 100, 'DE')).toMatchObject({
      boxesPerCarton: 18,
      cartons: 6,
      cartonWeightKg: 4.18,
    });
  });

  it('Belgium has its own weight classes', () => {
    // Every carton is under 10 kg: 9.40 each.
    expect(estimate(192, 600, 'BE')).toMatchObject({
      parcelTotal: 319.6,
      palletTotal: null,
      mode: 'parcel',
      estimate: 319.6,
    });
    expect(parcelPrice(PARCEL_RATES['BE']!, 10)).toBe(9.4);
    expect(parcelPrice(PARCEL_RATES['BE']!, 10.01)).toBe(10.48);
    expect(parcelPrice(PARCEL_RATES['BE']!, 20)).toBe(13.72);
    expect(parcelPrice(PARCEL_RATES['BE']!, 31.5)).toBe(24.42);
    expect(parcelPrice(PARCEL_RATES['BE']!, 31.6)).toBeNull();
  });

  it('the Europe classes run up to 2, 5, 15 and 31.5 kg', () => {
    const de = PARCEL_RATES['DE']!;
    expect([2, 2.01, 5, 5.01, 15, 15.01, 31.5].map((kg) => parcelPrice(de, kg))).toEqual([
      9.7, 10.5, 10.5, 11.23, 11.23, 13.1, 13.1,
    ]);
    expect(parcelPrice(de, 32)).toBeNull();
    // Shared tables.
    expect(PARCEL_RATES['SI']).toEqual(PARCEL_RATES['SK']);
    expect(PARCEL_RATES['LT']).toEqual(PARCEL_RATES['EE']);
  });

  it('a forced price wins over the estimate; 0 is free, blank or negative is not forced', () => {
    expect(estimate(192, 600, 'DE', 350)).toMatchObject({ estimate: 200, forced: true, price: 350 });
    expect(estimate(192, 600, 'DE', 0)).toMatchObject({ estimate: 200, forced: true, price: 0 });
    expect(estimate(192, 600, 'CH', 480)).toMatchObject({ estimate: null, forced: true, price: 480 });
    expect(estimate(192, 600, 'DE', null)).toMatchObject({ forced: false, price: 200 });
    expect(estimate(192, 600, 'DE', -5)).toMatchObject({ forced: false, price: 200 });
    expect(estimate(192, 600, 'DE', '')).toMatchObject({ forced: false, price: 200 });
    expect(parseForcedShippingPrice('75.5')).toBe(75.5);
    expect(parseForcedShippingPrice(12.345)).toBe(12.35);
    expect(parseForcedShippingPrice(Number.NaN)).toBeNull();
  });

  it('refuses card counts without a carton and invalid quantities', () => {
    expect(estimateBusinessShipping({ cardCount: 100, quantity: 10, country: 'DE' })).toBeNull();
    expect(estimateBusinessShipping({ cardCount: 192, quantity: 0, country: 'DE' })).toBeNull();
  });
});

describe('cartonsPerEuroPallet', () => {
  it('takes the better orientation per layer and stops at the weight cap', () => {
    // 40x30: 3x2 = 6 one way, 4x2 = 8 the other; 11 layers of 15 cm.
    expect(cartonsPerEuroPallet(CARTON_SPECS[192]!, 5.08)).toBe(88);
    expect(cartonsPerEuroPallet(CARTON_SPECS[192]!, 10)).toBe(72); // 725 kg / 10
  });
});

describe('shippingExtraKeyVars', () => {
  it('only counts pallets when it goes by pallet', () => {
    expect(shippingExtraKeyVars(estimate(192, 600, 'DE'))).toEqual({
      country: 'DE',
      cartons: 34,
      pallets: 1,
      mode: 'pallet',
    });
    expect(shippingExtraKeyVars(estimate(192, 20, 'DE')).pallets).toBe(0);
    expect(shippingExtraKeyVars(estimate(192, 600, 'CH', 400)).pallets).toBe(0);
  });
});

describe('shippingLineText', () => {
  // The real bundles: the business extras.* and the main countries.*.
  const root = process.env['APP_ROOT']!;
  const read = (file: string, prefix: string) => {
    const raw = JSON.parse(readFileSync(join(root, 'locales', file), 'utf-8'));
    return Object.fromEntries(
      Object.entries(raw as Record<string, string>)
        .filter(([k]) => k.startsWith(`${prefix}.`))
        .map(([k, v]) => [k.slice(prefix.length + 1), v])
    );
  };
  const textIn = (locale: string) => {
    const extras = { ...read('business/en.json', 'extras'), ...read(`business/${locale}.json`, 'extras') };
    const countries = read(`${locale}.json`, 'countries');
    const tExtra = (key: string, vars?: Record<string, any>) =>
      (extras[key] ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (m: string, n: string) =>
        vars?.[n] != null ? String(vars[n]) : m
      );
    return (keyVars: Record<string, any>) => shippingLineText(tExtra, keyVars, countries);
  };

  const pallet = { country: 'DE', cartons: 34, pallets: 1, mode: 'pallet' };

  it('names the country in the language of the document', () => {
    expect(textIn('de')(pallet)).toEqual({
      description: 'Versand nach Deutschland',
      details: '34 Umkartons auf 1 Palette',
    });
    expect(textIn('nl')(pallet)).toEqual({
      description: 'Verzending naar Duitsland',
      details: '34 omdozen op 1 pallet',
    });
    expect(textIn('en')(pallet)).toEqual({
      description: 'Shipping to Germany',
      details: '34 outer cartons on 1 pallet',
    });
  });

  it('singular and plural for cartons and pallets', () => {
    const de = textIn('de');
    expect(de({ country: 'DE', cartons: 2, pallets: 0 }).details).toBe('2 Umkartons');
    expect(de({ country: 'DE', cartons: 1, pallets: 0 }).details).toBe('1 Umkarton');
    expect(de({ country: 'DE', cartons: 112, pallets: 2 }).details).toBe('112 Umkartons auf 2 Paletten');
    expect(textIn('nl')({ country: 'DE', cartons: 1, pallets: 0 }).details).toBe('1 omdoos');
    expect(textIn('en')({ country: 'DE', cartons: 112, pallets: 2 }).details).toBe(
      '112 outer cartons on 2 pallets'
    );
  });

  it('uses the fixed phrase where a language needs an article', () => {
    expect(textIn('de')({ country: 'CH', cartons: 2 }).description).toBe('Versand in die Schweiz');
    expect(textIn('de')({ country: 'SK', cartons: 2 }).description).toBe('Versand in die Slowakei');
    expect(textIn('en')({ country: 'NL', cartons: 2 }).description).toBe(
      'Shipping within the Netherlands'
    );
    expect(textIn('nl')({ country: 'US', cartons: 2 }).description).toBe(
      'Verzending naar de Verenigde Staten'
    );
    // Lowercase codes from older snapshots resolve the same way.
    expect(textIn('de')({ country: 'at', cartons: 2 }).description).toBe('Versand nach Österreich');
  });

  it('falls back to the code, or a plain "Shipping", without a name', () => {
    expect(textIn('de')({ country: 'XX', cartons: 2 }).description).toBe('Versand nach XX');
    expect(textIn('nl')({ country: null, cartons: 0 })).toEqual({
      description: 'Verzending',
      details: '',
    });
  });
});
