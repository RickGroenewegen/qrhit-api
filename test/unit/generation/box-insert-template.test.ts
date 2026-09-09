import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import fs from 'fs/promises';
import path from 'path';

/**
 * Renders src/views/pdf_box_insert.ejs (the box insert card that ships inside
 * the lid) straight through EJS and asserts the background branches:
 *
 *  - customer picked nothing        -> the cream brand artwork, like every
 *                                      other card template
 *  - customer picked a colour       -> that solid / gradient, no artwork
 *  - customer uploaded a background -> their own file, no artwork
 *
 * The route (`/qr/pdf-box/...`) only feeds the template `php` and `count`, so
 * this covers the whole data path without a browser or Lambda.
 */

const TEMPLATE = path.resolve('src/views/pdf_box_insert.ejs');
const BRAND_ARTWORK = '/assets/images/background_brand.png';

async function render(php: Record<string, any>, count = 1): Promise<string> {
  const template = await fs.readFile(TEMPLATE, 'utf-8');
  return ejs.render(template, { php, count }, { filename: TEMPLATE });
}

describe('pdf_box_insert.ejs backgrounds', () => {
  it('falls back to the brand artwork on both sides when the customer chose nothing', async () => {
    const html = await render({ boxQuantity: 1, amount: 1 });

    // Front and back both get the artwork.
    const artwork = html.match(new RegExp(BRAND_ARTWORK, 'g')) || [];
    expect(artwork).toHaveLength(2);

    // ...and no plain white fill is emitted any more.
    expect(html).not.toContain('background-color: #ffffff');
  });

  it('keeps the solid colour branch when the customer picked a colour', async () => {
    const html = await render({
      boxFrontBackgroundType: 'solid',
      boxFrontBackgroundColor: '#18565e',
      boxBackBackgroundType: 'solid',
      boxBackBackgroundColor: '#feefe5',
    });

    expect(html).toContain('background-color: #18565e');
    expect(html).toContain('background-color: #feefe5');
    expect(html).not.toContain(BRAND_ARTWORK);
  });

  it('keeps the gradient branch when the customer picked a gradient', async () => {
    const html = await render({
      boxFrontBackgroundType: 'solid',
      boxFrontUseFrontGradient: true,
      boxFrontBackgroundColor: '#18565e',
      boxFrontGradientColor: '#0b2c31',
      boxBackBackgroundType: 'solid',
      boxBackUseGradient: true,
      boxBackBackgroundColor: '#f79677',
      boxBackGradientColor: '#dd6a45',
    });

    expect(html).toContain('linear-gradient(180deg, #18565e 50%, #0b2c31 100%)');
    expect(html).toContain('linear-gradient(180deg, #f79677 50%, #dd6a45 100%)');
    expect(html).not.toContain(BRAND_ARTWORK);
  });

  it('uses the uploaded background when the customer supplied one', async () => {
    const html = await render({
      boxFrontBackgroundType: 'image',
      boxFrontBackground: 'front.png',
      boxBackBackgroundType: 'image',
      boxBackBackground: 'back.png',
    });

    expect(html).toContain('/public/background/front.png');
    expect(html).toContain('/public/background/back.png');
    expect(html).not.toContain(BRAND_ARTWORK);
  });

  it('repeats the front/back pair once per insert', async () => {
    const html = await render({ boxQuantity: 2, amount: 3 }, 0);

    // boxQuantity x amount = 6 inserts, each with the artwork twice.
    const artwork = html.match(new RegExp(BRAND_ARTWORK, 'g')) || [];
    expect(artwork).toHaveLength(12);
    expect(html).toContain('Insert 6 of 6');
  });
});
