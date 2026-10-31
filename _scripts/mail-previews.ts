/**
 * Renders every customer mail template in src/templates/mails with sample
 * data so the HTML can be eyeballed in a browser or screenshotted.
 *
 *   npx tsx _scripts/mail-previews.ts [outDir]   (default: test/.tmp/mail-previews)
 *
 * The inline logos (cid:logo, and cid:logo_dark that dark mode swaps in) are
 * replaced with data URIs of assets/images/mail/ so the preview shows the real
 * marks; a card photo (cid:card*) with a stand-in on the cream ground the real
 * photo has, every other inline image with a plain one. Open a preview with the
 * system in dark mode to check the mail's dark palette. Exits non-zero when a
 * template fails to compile or render, which makes this usable as a smoke test.
 *
 * renderMailPreviews() hands out the same mails (HTML with its cid: links, and
 * the text part) for a script that needs them unrendered.
 */
import fs from 'fs/promises';
import path from 'path';
import Templates from '../src/templates';

process.env['APP_ROOT'] = path.resolve('src');

const MAILS = path.resolve('src/templates/mails');
const FRONTEND = 'https://www.qrsong.io';
const API = 'https://api.qrsong.io';

// Templates whose translation prefix is not simply their own name
const PREFIX: Record<string, string> = {
  promotional_sale: 'promotional_email',
  qrvote_verification: 'verification',
};

// Sample data a template reads under a name another one uses differently
const EXTRA: Record<string, Record<string, unknown>> = {
  payment_help: {
    intro: {
      html: 'We saw that the payment for your QRSong! order 100009439 didn&#39;t go through. That can happen, and nothing is lost: your playlist and your card design are saved, just as you made them.',
    },
    lines: [
      { name: 'Summer Hits 2026', cid: 'card0', card: true, detail: { html: '150 printed cards' }, sets: { html: '2 sets' } },
      // a playlist name the mail leaves out (mailSafeText)
      { name: '', cid: 'card1', card: false, detail: { html: '80 cards as a PDF to print yourself' }, sets: null },
    ],
    resumeUrl: `${API}/order/resume/100009439?l=en`,
    validUntil: { html: 'This link works until 2 November.' },
  },
  gift_received: {
    intro: 'Laura gave you QRSong! and the gift is in your own account now:',
    setLines: ['150 music cards: Summer Hits 2026'],
    hasGames: true,
    accountLink: `${FRONTEND}/en/my-account`,
    appLink: `${FRONTEND}/en/download-app`,
  },
  gift_redeemed: {
    intro: 'Laura has redeemed your QRSong! gift. These sets are in their own account now:',
    setLines: ['150 music cards: Summer Hits 2026'],
    accountLink: `${FRONTEND}/en/my-account`,
  },
  open_corrections: {
    playlists: [
      { name: 'Summer Hits 2026', link: `${FRONTEND}/en/usersuggestions/1/abc/2/1` },
      { name: 'Road Trip Classics', link: `${FRONTEND}/en/usersuggestions/1/abc/3/1` },
    ],
  },
  upgrade_invoice: {
    invoiceNumber: 'QRS-2026-01234',
    purchase: 'App Designer',
    date: '31 October 2026',
    amountFormatted: '€4.95',
  },
};

// What the senders fill into the texts before the template sees them
// (replaceAmountPlaceholder, the playlist in mail.printingStarted, the order in a title)
const fillIn = (text: string) =>
  text
    .replace(/\{\{\s*amount\s*\}\}/g, '€2,50')
    .replace(/\{\{\s*playlist\s*\}\}/g, 'Summer Hits 2026')
    .replace(/\{\{\s*orderId\s*\}\}/g, 'QR-2026-048213');

export interface MailPreview {
  name: string;
  html: string;
  text: string;
}

export async function renderMailPreviews(): Promise<{ previews: MailPreview[]; failed: string[] }> {
  const en = JSON.parse(await fs.readFile('src/locales/en.json', 'utf8')) as Record<string, string>;
  const byPrefix = (prefix: string) =>
    Object.fromEntries(
      Object.entries(en)
        .filter(([k]) => k.startsWith(prefix + '.'))
        .map(([k, v]) => [k.slice(prefix.length + 1), fillIn(v)])
    );
  const mail = byPrefix('mail');
  const countries = byPrefix('countries');

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
    foldGuideLink: `${FRONTEND}/en/gift-box/how-to-fold`,
    foldGuideImage: `${FRONTEND}/assets/images/gift-box-fold-guide.jpg`,
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
    showAppDesign: true,
    appDesignUrl: `${FRONTEND}/en/app-designer`,
    designUrl: `${FRONTEND}/en/my-account/app-design`,
    message:
      '<p style="margin:0 0 16px;">Allereerst bedankt voor je QRSong! bestelling. Tijdens de controle hebben we iets opgemerkt.</p><p style="margin:0;">We nemen zo snel mogelijk contact met je op.</p>',
  };

  const templates = new Templates();
  const files = (await fs.readdir(MAILS)).filter((f) => f.endsWith('_html.hbs')).sort();
  const previews: MailPreview[] = [];
  const failed: string[] = [];
  for (const file of files) {
    const name = file.replace('_html.hbs', '');
    const prefix = PREFIX[name] ?? (en[`${name}.subject`] || en[`${name}.title`] ? name : 'mail');
    const data = { ...base, ...EXTRA[name], translations: { ...mail, ...byPrefix(prefix) } };
    try {
      const html = await templates.render(`mails/${name}_html`, data);
      const text = await templates.render(`mails/${name}_text`, data);
      previews.push({ name, html, text });
    } catch (err) {
      failed.push(name);
      console.error(`✗ ${name}: ${(err as Error).message}`);
    }
  }
  return { previews, failed };
}

const svg = (body: string) => 'data:image/svg+xml;utf8,' + encodeURIComponent(body);

async function main() {
  const out = path.resolve(process.argv[2] || 'test/.tmp/mail-previews');
  const dataUri = async (file: string) =>
    `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`;
  const logo = await dataUri('assets/images/mail/logo.png');
  const logoDark = await dataUri('assets/images/mail/logo_dark.png');
  // the card photo is a JPEG on the mail's cream panel (mailPhoto), which dark mode has to live with
  const photo = svg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="536" height="400"><rect width="100%" height="100%" fill="#fff8f3"/><rect x="168" y="80" width="200" height="240" rx="16" fill="#18565e" transform="rotate(-6 268 200)"/><text x="50%" y="50%" fill="#feefe5" font-family="Arial" font-size="24" text-anchor="middle" dominant-baseline="middle">card photo</text></svg>'
  );
  const image = svg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="100%" height="100%" fill="#18565e"/><text x="50%" y="50%" fill="#feefe5" font-family="Arial" font-size="28" text-anchor="middle" dominant-baseline="middle">image</text></svg>'
  );

  const { previews, failed } = await renderMailPreviews();
  await fs.mkdir(out, { recursive: true });
  for (const { name, html } of previews) {
    await fs.writeFile(
      path.join(out, `${name}.html`),
      html
        .replace(/src="cid:logo_dark"/g, `src="${logoDark}"`)
        .replace(/src="cid:(logo|qrsong_logo)"/g, `src="${logo}"`)
        .replace(/src="cid:card0"/g, `src="${photo}"`)
        .replace(/src="cid:[^"]+"/g, `src="${image}"`)
    );
  }
  console.log(`${previews.length} previews written to ${out}${failed.length ? `, ${failed.length} failed` : ''}`);
  if (failed.length) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
