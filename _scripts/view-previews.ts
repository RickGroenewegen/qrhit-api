/**
 * Renders the customer-facing EJS views (invoice, vouchers, technical
 * instructions, bingo sheets, onboarding page) with sample data so they can
 * be opened in a browser or screenshotted without a database or Lambda.
 *
 *   npx tsx _scripts/view-previews.ts [outDir]   (default: test/.tmp/view-previews)
 *
 * Asset URLs point at the local assets/ folder via file://, so the previews
 * show the real logo. Exits non-zero when any view fails to render.
 */
import ejs from 'ejs';
import fs from 'fs/promises';
import path from 'path';

const ROOT = path.resolve('.');
const VIEWS = path.join(ROOT, 'src/views');
const OUT = path.resolve(process.argv[2] || 'test/.tmp/view-previews');
const LOCAL = `file://${ROOT}`;

process.env['API_URI'] = LOCAL;
process.env['PRODUCT_NAME'] ??= 'QRSong!';
process.env['APP_DOMAIN'] ??= 'www.qrsong.io';
process.env['PRODUCT_POSTBOX'] ??= 'Postbus 1234';
process.env['PRODUCT_ADDRESS'] ??= 'Muziekplein 1';
process.env['PRODUCT_ZIPCODE'] ??= '1234 AB';
process.env['PRODUCT_CITY'] ??= 'Amsterdam';
process.env['PRODUCT_COUNTRY'] ??= 'NL';

const interpolate = (text: string, vars: Record<string, unknown> = {}) =>
  text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

async function main() {
  const en = JSON.parse(await fs.readFile('src/locales/en.json', 'utf8')) as Record<string, string>;
  const business = JSON.parse(await fs.readFile('src/locales/business/en.json', 'utf8')) as Record<string, string>;
  const byPrefix = (src: Record<string, string>, prefix: string) =>
    Object.fromEntries(
      Object.entries(src)
        .filter(([k]) => k.startsWith(prefix + '.'))
        .map(([k, v]) => [k.slice(prefix.length + 1), v])
    );
  const countries = byPrefix(en, 'countries');
  const money = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

  const playlists = [
    { name: 'Summer Hits 2026', amount: 2, price: 79.9, priceVAT: 13.87, productType: 'physical', boxEnabled: true, boxQuantity: 1, gamesEnabled: true },
    { name: 'Road Trip Classics', amount: 1, price: 39.95, priceVAT: 6.93, productType: 'physical', boxEnabled: false, boxQuantity: 0, gamesEnabled: false },
  ];
  const payment = {
    orderId: 'QR-2026-048213',
    createdAt: new Date('2026-09-01T10:30:00Z'),
    fullname: 'Rick Groenewegen',
    companyName: 'Acme Events BV',
    isBusinessOrder: true,
    vatId: 'NL123456789B01',
    address: 'Musicstraat',
    housenumber: '12a',
    zipcode: '1017 AB',
    city: 'Amsterdam',
    countrycode: 'NL',
    paymentMethod: 'ideal',
    taxRate: 21,
    taxRateShipping: 21,
    shipping: 6.95,
    shippingVATPrice: 1.21,
    shippingPriceWithoutTax: 5.74,
    boxFee: 9.95,
    gamesFee: 5,
    totalPrice: 141.75,
    totalVATPrice: 24.6,
    productPriceWithoutTax: 99.05,
    productVATPrice: 20.8,
    reverseCharge: false,
    DiscountCodedUses: [{ amount: 10 }],
  };

  const bingoTrack = (i: number) => ({
    bingoNumber: i,
    name: ['Bohemian Rhapsody', 'Dancing Queen', 'Billie Jean', 'Smells Like Teen Spirit', 'Rolling in the Deep', 'Blinding Lights'][i % 6],
    artist: ['Queen', 'ABBA', 'Michael Jackson', 'Nirvana', 'Adele', 'The Weeknd'][i % 6],
    year: 1975 + ((i * 7) % 48),
    qrUrl:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#fff"/><rect x="10" y="10" width="30" height="30" fill="#0b2c31"/><rect x="80" y="10" width="30" height="30" fill="#0b2c31"/><rect x="10" y="80" width="30" height="30" fill="#0b2c31"/><rect x="50" y="50" width="20" height="20" fill="#0b2c31"/></svg>'),
  });
  const grid = (round: number) =>
    Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 5 }, (_, c) => (r === 2 && c === 2 ? { isFreeSpace: true } : { track: bingoTrack(r * 5 + c + round) }))
    );

  const views: Record<string, Record<string, unknown>> = {
    invoice: {
      payment,
      playlists,
      translations: byPrefix(en, 'invoice'),
      countries,
      orderType: 'physical',
      dateFormatter: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
      moneyFormatter: money,
      euroFormatter: money,
      displayRate: 1,
      presentmentTotal: payment.totalPrice,
      invoiceCurrency: 'EUR',
      invoiceRate: 1,
    },
    voucher_digital: {
      translations: byPrefix(en, 'voucher'),
      discount: { amount: 25, code: 'GIFT-4X7P-QZ', message: 'Happy birthday! Turn your favourite playlist into a game night we can all play together.', from: 'Sanne & Tom' },
    },
    voucher_printer: {
      translations: byPrefix(en, 'voucher'),
      discount: { amount: 25, code: 'GIFT-4X7P-QZ', message: 'Happy birthday! Turn your favourite playlist into a game night we can all play together.', from: 'Sanne & Tom' },
    },
    technical_instructions: {
      locale: 'en',
      printer: 'tromp',
      t: (key: string, vars?: Record<string, unknown>) => interpolate(business[`instructions.${key}`] ?? key, vars),
      formatDate: (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    },
    pdf_bingo: {
      apiUri: LOCAL,
      playlistName: 'Summer Hits 2026',
      t: {
        roundInfo: (round: number) => interpolate(en['bingo_pdf.roundInfo'], { round }),
        footerBranding: en['bingo_pdf.footerBranding'],
        footerGenerator: en['bingo_pdf.footerGenerator'],
      },
      sheets: [
        { round: 1, sheetNumber: 1, grid: grid(1), qrData: 'https://www.qrsong.io/bingo/verify/1/1' },
        { round: 5, sheetNumber: 3, grid: grid(5), qrData: 'https://www.qrsong.io/bingo/verify/5/3' },
      ],
    },
    pdf_bingo_hostcards: {
      tracks: Array.from({ length: 12 }, (_, i) => bingoTrack(i + 1)),
    },
    onboarding: {
      translations: byPrefix(en, 'countdown'),
      version: 'preview',
      domain: 'https://www.qrsong.io',
    },
  };

  await fs.mkdir(OUT, { recursive: true });
  let failed = 0;
  for (const [name, data] of Object.entries(views)) {
    try {
      let html = await ejs.renderFile(path.join(VIEWS, `${name}.ejs`), data, { async: true });
      // Absolute asset paths only resolve on the API host; point them at the repo for the preview
      html = html.replace(/(href|src)="\/assets\//g, `$1="${LOCAL}/assets/`);
      await fs.writeFile(path.join(OUT, `${name}.html`), html);
    } catch (err) {
      failed++;
      console.error(`✗ ${name}: ${(err as Error).message}`);
    }
  }
  console.log(`${Object.keys(views).length - failed} view previews written to ${OUT}${failed ? `, ${failed} failed` : ''}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
