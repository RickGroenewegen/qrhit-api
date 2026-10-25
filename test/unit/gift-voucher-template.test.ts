import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import fs from 'fs/promises';
import path from 'path';
import Translation from '../../src/translation';

/**
 * Renders src/views/gift_voucher.ejs with the real translations, the way
 * Gift.voucherView feeds it: `t()` comes back from the i18n package with its
 * params already HTML-escaped by Mustache, so the view prints it unescaped.
 * Printed with <%= %> as well, the redeem address on the voucher read
 * "qrsong.io&#x2F;redeem".
 */

const TEMPLATE = path.resolve('src/views/gift_voucher.ejs');
const translation = new Translation();

async function render(voucher: Record<string, unknown>, setName = 'Indie Road Trip'): Promise<string> {
  const template = await fs.readFile(TEMPLATE, 'utf-8');
  return ejs.render(
    template,
    {
      process: { env: { API_URI: 'https://api.example' } },
      voucher: { message: null, ...voucher },
      code: 'GIFT-AAAA-BBBB-CCCC',
      sets: [{ name: setName, numberOfTracks: 24, type: 'physical', picture: { src: null, card: false } }],
      hasPrinted: true,
      qr: '<svg></svg>',
      redeemHost: 'qrsong.io/redeem',
      translations: await translation.getTranslationsByPrefix('en', 'giftVoucher'),
      t: (key: string, params: Record<string, unknown> = {}) =>
        translation.translate(`giftVoucher.${key}`, 'en', params),
    },
    { filename: TEMPLATE }
  );
}

/** What a browser shows for an HTML fragment: entities decoded once. */
const shown = (html: string) =>
  html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x60;/g, '`')
    .replace(/&#x3D;/g, '=')
    .replace(/&amp;/g, '&');

describe('gift_voucher.ejs', () => {
  it('shows the redeem address as typed', async () => {
    const html = await render({ recipientName: 'Pietje', giverName: 'Puk' });

    expect(shown(html)).toContain('Scan the code or go to qrsong.io/redeem');
  });

  it('escapes names and the set exactly once', async () => {
    const html = await render(
      { recipientName: `Pietje <b>& Co's</b>`, giverName: 'Puk & "Mark"' },
      'Rock & Roll / 80s'
    );

    // No raw markup from a name reaches the page...
    expect(html).not.toContain('<b>& Co');
    // ...and nothing is escaped twice.
    expect(html).not.toContain('&amp;amp;');
    expect(html).not.toContain('&amp;#');
    expect(shown(html)).toContain(`A gift for Pietje <b>& Co's</b>`);
    expect(shown(html)).toContain('From Puk & "Mark"');
    expect(shown(html)).toContain('24 music cards: Rock & Roll / 80s');
  });

  it('puts the cream logo on the dark band', async () => {
    const html = await render({ recipientName: 'Pietje', giverName: 'Puk' });

    expect(html).toContain('https://api.example/assets/images/logo_white.png');
  });
});
