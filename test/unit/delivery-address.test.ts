import { describe, it, expect } from 'vitest';
import {
  deliveryLines,
  effectiveDeliveryAddress,
  hasDeliveryAddress,
  pickDeliveryFields,
} from '../../src/deliveryAddress';

const company = {
  deliveryName: 'Sandra Kusters',
  deliveryAddress: 'Ambachtweg',
  deliveryHousenumber: '73',
  deliveryZipcode: '5731 AE',
  deliveryCity: 'Mierlo',
  deliveryCountrycode: 'NL',
  deliveryPhone: '040 20 60 100',
};

const listOwn = {
  useCompanyDeliveryAddress: false,
  deliveryName: 'Receptie Van Haren',
  deliveryAddress: 'Hoofdstraat',
  deliveryHousenumber: '1',
  deliveryZipcode: '1000 AA',
  deliveryCity: 'Antwerpen',
  deliveryCountrycode: 'be',
  deliveryPhone: null,
};

describe('deliveryAddress', () => {
  it('a list uses the company default unless switched off', () => {
    expect(effectiveDeliveryAddress(company, { useCompanyDeliveryAddress: true })).toEqual({
      source: 'company',
      name: 'Sandra Kusters',
      lines: ['Ambachtweg 73', '5731 AE Mierlo'],
      phone: '040 20 60 100',
    });
    // missing flag (older rows) counts as "use the company default"
    expect(effectiveDeliveryAddress(company, {})?.source).toBe('company');
    expect(effectiveDeliveryAddress(company, null)?.source).toBe('company');
  });

  it('a list with the toggle off uses its own address, country only outside NL', () => {
    expect(effectiveDeliveryAddress(company, listOwn)).toEqual({
      source: 'list',
      name: 'Receptie Van Haren',
      lines: ['Hoofdstraat 1', '1000 AA Antwerpen', 'BE'],
      phone: null,
    });
  });

  it('no address yet gives null instead of half an address', () => {
    expect(effectiveDeliveryAddress({ deliveryName: 'Sandra' }, {})).toBeNull();
    expect(effectiveDeliveryAddress(company, { useCompanyDeliveryAddress: false })).toBeNull();
    expect(hasDeliveryAddress({ deliveryAddress: ' ', deliveryCity: 'Mierlo' })).toBe(false);
  });

  it('address lines skip empty parts', () => {
    expect(deliveryLines({ deliveryAddress: 'Postbus 12', deliveryCity: 'Utrecht' })).toEqual(['Postbus 12', 'Utrecht']);
  });

  it('only delivery fields are picked from a body, trimmed, empty as null', () => {
    expect(
      pickDeliveryFields({ deliveryName: '  Sandra ', deliveryCity: '', deliveryCountrycode: 'nl', name: 'x', deliveryPhone: 12 })
    ).toEqual({ deliveryName: 'Sandra', deliveryCity: null, deliveryCountrycode: 'NL' });
  });
});
