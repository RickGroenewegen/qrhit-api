/**
 * Renders every customer mail template in src/templates/mails with sample
 * data so the HTML can be eyeballed in a browser or screenshotted.
 *
 *   npx tsx _scripts/mail-previews.ts [outDir]   (default: test/.tmp/mail-previews)
 *
 * The inline logo (cid:logo) is replaced with a data URI of assets/images/logo.png
 * so the preview shows the real mark. Exits non-zero when a template fails
 * to compile or render, which makes this usable as a smoke test.
 */
import fs from 'fs/promises';
import path from 'path';
import Templates from '../src/templates';

process.env['APP_ROOT'] = path.resolve('src');

const OUT = path.resolve(process.argv[2] || 'test/.tmp/mail-previews');
const MAILS = path.resolve('src/templates/mails');
const FRONTEND = 'https://www.qrsong.io';
const API = 'https://api.qrsong.io';

// Onze Vibe branded mails are not part of the QRSong! restyle
const SKIP = new Set(['portal_welcome', 'verification']);

// Templates whose translation prefix is not simply their own name
const PREFIX: Record<string, string> = {
  promotional_sale: 'promotional_email',
  qrvote_verification: 'verification',
};

async function main() {
  const en = JSON.parse(await fs.readFile('src/locales/en.json', 'utf8')) as Record<string, string>;
  const byPrefix = (prefix: string) =>
    Object.fromEntries(
      Object.entries(en)
        .filter(([k]) => k.startsWith(prefix + '.'))
        .map(([k, v]) => [k.slice(prefix.length + 1), v])
    );
  const mail = byPrefix('mail');
  const countries = byPrefix('countries');

  const logo = await fs.readFile('assets/images/logo.png');
  const logoUri = `data:image/png;base64,${logo.toString('base64')}`;
  const placeholder =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="100%" height="100%" fill="#18565e"/><text x="50%" y="50%" fill="#feefe5" font-family="Arial" font-size="28" text-anchor="middle" dominant-baseline="middle">image</text></svg>'
    );

  const playlists = [
    { name: 'Summer Hits 2026', amount: 2, numberOfTracks: 150, featured: false },
    { name: 'Road Trip Classics', amount: 1, numberOfTracks: 80, featured: false },
  ];

  const base = {
    productName: 'QRSong!',
    currentYear: new Date().getFullYear(),
    payment: { fullname: 'Rick Groenewegen', locale: 'en' },
    fullname: 'Rick Groenewegen',
    email: 'rick@example.com',
    orderId: 'QR-2026-048213',
    address: 'Musicstraat',
    housenumber: '12a',
    city: 'Amsterdam',
    zipcode: '1017 AB',
    country: 'NL',
    invoiceAddress: 'Kantoorlaan',
    invoiceHousenumber: '8',
    invoiceCity: 'Utrecht',
    invoiceZipcode: '3511 CD',
    invoiceCountry: 'NL',
    differentInvoiceAddress: true,
    playlists,
    playlist: playlists[0],
    numberOfTracks: 230,
    hasBox: true,
    boxQuantity: 2,
    countries,
    mail,
    showPromotionalCta: true,
    hasBingo: true,
    bingoDownloadUrl: `${FRONTEND}/en/my-account`,
    sendPhysicalLink: true,
    digitalDownloadLink: `${API}/download/1/abc/2/digital`,
    digitalDownloadCorrectionLink: `${FRONTEND}/en/usersuggestions/1/abc/2/1`,
    downloadLink: `${API}/download/1/abc/2/printer`,
    promotionalSetupLink: `${FRONTEND}/en/promotional/1/abc/2`,
    trackingLink: 'https://postnl.nl/track/3SABCD123456789',
    reviewLink: `${FRONTEND}/en/user/review/1`,
    reviewLinkTrustPilot: 'https://www.trustpilot.com/evaluate/qrsong.io',
    unsubscribeLink: `${FRONTEND}/en/user/unsubscribe/abc`,
    pincode: '482913',
    activationCode: 'A7K2-9QZM',
    resetLink: `${FRONTEND}/en/reset-password/2f8c1a9e7b3d4c5f6a7b8c9d0e1f2a3b`,
    verificationLink: `${FRONTEND}/en/verify/2f8c1a9e7b3d4c5f6a7b8c9d0e1f2a3b`,
    verifyUrl: `${FRONTEND}/en/verify/2f8c1a9e7b3d4c5f6a7b8c9d0e1f2a3b`,
    designerLink: `${FRONTEND}/en/generate/designer/1/abc/2`,
    reasonText: en['design_alter.reasonInappropriate'],
    flaggedImagesIntro: en['design_alter.flaggedImagesIntro'],
    flaggedImages: [
      { name: en['design_alter.imageCardFront'], cid: 'flag1' },
      { name: en['design_alter.imageBoxFront'], cid: 'flag2' },
    ],
    videoLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    videoThumbnail: placeholder,
    giftBoxLink: `${FRONTEND}/en/gift-box`,
    quantity: 2,
    boxPriceFormatted: '9,95',
    shippingCost: '4,95',
    totalPrice: '24,85',
    playlistName: 'Summer Hits 2026',
    shareLink: `${FRONTEND}/en/product/summer-hits-2026`,
    whatsappLink: 'https://wa.me/?text=QRSong',
    facebookLink: 'https://www.facebook.com/sharer/sharer.php?u=qrsong.io',
    instagramLink: 'https://www.instagram.com/',
    twitterLink: 'https://x.com/intent/tweet?text=QRSong',
    discountCode: 'SUMMER26',
    creditedAmount: '7,50',
    totalBalance: '22,50',
    setupLink: `${FRONTEND}/en/promotional/1/abc/2`,
    companyName: 'Acme Events BV',
    greeting: 'Hi',
    message:
      '<p style="margin:0 0 16px;">Allereerst bedankt voor je QRSong! bestelling. Tijdens de controle hebben we iets opgemerkt.</p><p style="margin:0;">We nemen zo snel mogelijk contact met je op.</p>',
  };

  const templates = new Templates();
  const files = (await fs.readdir(MAILS)).filter((f) => f.endsWith('_html.hbs')).sort();
  await fs.mkdir(OUT, { recursive: true });

  let failed = 0;
  const written: string[] = [];
  for (const file of files) {
    const name = file.replace('_html.hbs', '');
    if (SKIP.has(name)) continue;
    const prefix = PREFIX[name] ?? (en[`${name}.subject`] || en[`${name}.title`] ? name : 'mail');
    const data = { ...base, translations: { ...mail, ...byPrefix(prefix) } };
    try {
      let html = await templates.render(`mails/${name}_html`, data);
      html = html
        .replace(/src="cid:(logo|qrsong_logo)"/g, `src="${logoUri}"`)
        .replace(/src="cid:[^"]+"/g, `src="${placeholder}"`);
      await fs.writeFile(path.join(OUT, `${name}.html`), html);
      written.push(name);
    } catch (err) {
      failed++;
      console.error(`✗ ${name}: ${(err as Error).message}`);
    }
  }
  console.log(`${written.length} previews written to ${OUT}${failed ? `, ${failed} failed` : ''}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
