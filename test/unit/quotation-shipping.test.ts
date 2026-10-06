import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { estimateBusinessShipping, shippingExtraKeyVars, shippingLineText } from '../../src/businessShipping';

/**
 * Renders src/views/tromp_quotation.ejs straight through EJS with what the
 * quotation route hands it for a Schneider list shipped abroad: the shipping
 * extra gets its own description and carton details instead of "one-off
 * cost", and counts in the subtotal.
 */

const TEMPLATE = path.resolve('src/views/tromp_quotation.ejs');
const ROOT = process.env['APP_ROOT']!;

const bundle = (file: string, prefix: string): Record<string, string> => {
  const raw = JSON.parse(readFileSync(path.join(ROOT, 'locales', file), 'utf-8'));
  return Object.fromEntries(
    Object.entries(raw as Record<string, string>)
      .filter(([k]) => k.startsWith(`${prefix}.`))
      .map(([k, v]) => [k.slice(prefix.length + 1), v])
  );
};
const translator = (locale: string, prefix: string) => {
  const strings = { ...bundle('business/en.json', prefix), ...bundle(`business/${locale}.json`, prefix) };
  return (key: string, vars?: Record<string, any>) =>
    (strings[key] ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (m: string, n: string) =>
      vars?.[n] != null ? String(vars[n]) : m
    );
};

function render(locale: 'nl' | 'de' | 'en', country: string, quantity = 600): string {
  const intlTag = { nl: 'nl-NL', de: 'de-DE', en: 'en-GB' }[locale];
  const t = translator(locale, 'quotation');
  const tExtra = translator(locale, 'extras');
  const countryNames = bundle(`${locale}.json`, 'countries');
  const shipping = estimateBusinessShipping({ cardCount: 192, quantity, country })!;
  const extras = [
    { key: 'cuttingDieBox', keyVars: { compartments: 4 }, name: 'Stansmes 4-vaks doosje', price: 375 },
    ...(shipping.price > 0
      ? [{ key: 'shipping', keyVars: shippingExtraKeyVars(shipping), name: 'Verzending', price: shipping.price }]
      : []),
  ];
  const template = readFileSync(TEMPLATE, 'utf-8');
  return ejs.render(
    template,
    {
      locale,
      t,
      tExtra,
      company: { name: 'Medienwerft GmbH', countrycode: 'DE' },
      calculation: { cardCount: 192, quantity, manualDiscountPercent: 0 },
      calculationResult: {
        quantity,
        pricePerSet: 7.5,
        extras,
        customAppFee: 0,
        votingPortalFee: 0,
      },
      quotationNumber: 'Q-2026-900',
      validUntil: new Date('2026-11-05'),
      formatCurrency: (v: number) =>
        new Intl.NumberFormat(intlTag, { style: 'currency', currency: 'EUR' }).format(v),
      formatDate: (d: Date) => d.toLocaleDateString(intlTag),
      formatEuro: (v: number) => v.toLocaleString(intlTag, { minimumFractionDigits: 2 }),
      baseUrl: 'http://localhost:3004',
      isReseller: false,
      profitMargins: null,
      calculatedPrices: null,
      productDescription: 'QRSong! Box - 192',
      productDetails: '',
      productType: 'schneider',
      license: null,
      vatContext: { region: 'eu', rate: 0, reverseCharge: true },
      companyCountryName: countryNames['DE'],
      describeShipping: (keyVars: Record<string, any>) =>
        shippingLineText(tExtra, keyVars, countryNames),
    },
    { filename: TEMPLATE }
  );
}

const rowOf = (html: string, text: string) => {
  const at = html.indexOf(text);
  expect(at, `"${text}" in the quotation`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<tr>', at), html.indexOf('</tr>', at));
};

describe('tromp_quotation.ejs shipping line', () => {
  it('German: "Versand nach Deutschland", the cartons on the pallet, in the subtotal', () => {
    const html = render('de', 'DE');
    const row = rowOf(html, 'Versand nach Deutschland');
    expect(row).toContain('34 Umkartons auf 1 Palette');
    expect(row).not.toContain('Einmalige Kosten');
    expect(row).toMatch(/200,00\s*€/);
    // The cutting die is still a one-off.
    expect(rowOf(html, 'Stanzform, 4-Fach-Schachtel')).toContain('Einmalige Kosten');
    // 600 x 7.50 + 375 + 200
    expect(html).toMatch(/5\.075,00\s*€/);
  });

  it('Dutch and English name the cartons in their own words', () => {
    const nl = rowOf(render('nl', 'DE'), 'Verzending naar Duitsland');
    expect(nl).toContain('34 omdozen op 1 pallet');
    expect(nl).not.toContain('Eenmalige kosten');

    const en = rowOf(render('en', 'DE', 20), 'Shipping to Germany');
    expect(en).toContain('2 outer cartons');
    expect(en).not.toContain('pallet');
  });

  it('no shipping line within the Netherlands', () => {
    const html = render('nl', 'NL');
    expect(html).not.toContain('Verzending');
    expect(html).toMatch(/€\s*4\.875,00/); // 600 x 7.50 + 375
  });
});
