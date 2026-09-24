import { describe, it, expect, beforeAll } from 'vitest';
import ejs from 'ejs';
import fs from 'fs/promises';
import path from 'path';
import { deckDesigns, designIndexForCard, sanitizeCardDesign } from '../../../src/cardDesigns';

/**
 * Renders the consumer card templates straight through EJS with alternating
 * designs (src/cardDesigns.ts), fed the way the /qr/pdf route feeds them:
 * `designs` is the deck, `cardDesigns` / `cardDesignIndexes` line up with the
 * tracks of the chunk, numbered from startIndex over the whole deck.
 *
 * A single-design deck has to come out exactly as before the feature: every
 * card on php, no d<k> classes, no override rules.
 */

const VIEWS = path.resolve('src/views');
const TEMPLATES = [
  'printer',
  'printer_sheets',
  'digital',
  'digital_us',
  'digital_double',
  'digital_double_us',
];

const php = {
  paymentHasPlaylistId: 55,
  background: 'one.png',
  backgroundFrontType: 'image',
  backgroundBack: '',
  backgroundBackType: 'solid',
  backgroundBackColor: '#fefefe',
  selectedFont: 'Arial, sans-serif',
  selectedFontSize: '16px',
  fontColor: '#010101',
  qrBackgroundType: 'square',
  qrBackgroundColor: '#ffffff',
  frontOpacity: 100,
  backOpacity: 50,
  addHowToCard: 0,
};

const extras = [
  sanitizeCardDesign({
    background: 'two.png',
    backgroundBackType: 'image',
    backgroundBack: 'twoback.png',
    fontColor: '#020202',
    selectedFont: 'Oswald, Arial, sans-serif',
    qrBackgroundType: 'circle',
    qrBackgroundColor: '#222222',
  }),
  sanitizeCardDesign({
    backgroundFrontType: 'solid',
    backgroundFrontColor: '#333333',
    backgroundBackType: 'solid',
    backgroundBackColor: '#343434',
    fontColor: '#030303',
  }),
];

const tracks = Array.from({ length: 13 }, (_, i) => ({
  id: i + 1,
  trackId: `trk${i + 1}`,
  artist: `Artist ${i + 1}`,
  name: `Song ${i + 1}`,
  year: 1970 + i,
}));

const helpers = {
  getYearFontSize: () => '44px',
  getGoogleFontWeights: () => '400;700',
  getGoogleFontName: (font: string) => font.split(',')[0].trim().replace(/["']/g, ''),
  getFontWeight: () => '',
  getQrTotalModules: () => 29,
};

async function render(template: string, designs: any[], startIndex = 0): Promise<string> {
  const file = path.join(VIEWS, `pdf_${template}.ejs`);
  const source = await fs.readFile(file, 'utf-8');
  const cardDesignIndexes = tracks.map((_, i) => designIndexForCard(designs.length, startIndex + i));
  return ejs.render(
    source,
    {
      subdir: 'sub',
      payment: { vibe: false },
      playlist: { name: 'P' },
      php,
      tracks,
      designs,
      cardDesigns: cardDesignIndexes.map((k) => designs[k]),
      cardDesignIndexes,
      user: {},
      eco: false,
      emptyPages: 0,
      batchNumber: '55',
      startIndex,
      howtoTranslations: null,
      ...helpers,
    },
    { filename: file }
  );
}

/** Each card element's design class suffix, in document order. */
function cardClasses(html: string, side: 'front' | 'back', template: string): string[] {
  const pattern =
    template === 'printer'
      ? new RegExp(`class="card-${side}( d\\d)?"`, 'g')
      : new RegExp(`class="card ${side}( d\\d)?" style`, 'g');
  return [...html.matchAll(pattern)].map((m) => (m[1] || '').trim());
}

describe('card templates with alternating designs', () => {
  beforeAll(() => {
    process.env['API_URI'] = 'https://api.test';
  });

  for (const template of TEMPLATES) {
    describe(`pdf_${template}.ejs`, () => {
      it('renders a single-design deck without design classes or override rules', async () => {
        const html = await render(template, deckDesigns(php));
        expect(html).not.toMatch(/ d\d"/);
        expect(html).not.toMatch(/\.d\d/);
        expect(html).toContain('/public/background/one.png');
        expect(html).toContain('color:#010101');
      });

      it('gives card k design k % 3 and draws it with that design', async () => {
        const designs = deckDesigns(php, extras);
        const html = await render(template, designs);

        const fronts = cardClasses(html, 'front', template);
        expect(fronts).toHaveLength(tracks.length);
        expect(fronts.slice(0, 4)).toEqual(['', 'd1', 'd2', '']);

        // Per-card values come from the card's own design.
        expect(html).toContain('/public/background/two.png');
        expect(html).toContain('/public/background/twoback.png');
        expect(html).toContain('color:#020202');
        expect(html).toContain('color:#030303');
        expect(html).toContain('background: #333333;');
        expect(html).toContain('fill="#222222"');

        // Design 3 paints its back colour through its own rule.
        expect(html.replace(/\s+/g, ' ')).toMatch(/\.d2 \{ background: none; background-color: #343434; \}/);
        // Design 2's font is loaded and scoped to its cards.
        expect(html).toContain('family=Oswald');
        expect(html.replace(/\s+/g, ' ')).toMatch(/\.d1 \.text, \.d1 \.text\.artist, \.d1 \.text\.name \{ font-family: 'Oswald'/);
      });

      it('continues the cycle in a later chunk', async () => {
        const html = await render(template, deckDesigns(php, extras), 50);
        // Card 51 is design 3 (index 2), then 1, 2, 3...
        expect(cardClasses(html, 'front', template).slice(0, 4)).toEqual(['d2', '', 'd1', 'd2']);
      });
    });
  }

  it('paints the front artwork of an extra design through ::before on the printer layout', async () => {
    const html = (await render('printer', deckDesigns(php, extras))).replace(/\s+/g, ' ');
    expect(html).toMatch(/\.card-front\.d1::before \{ background: none; background-image: url\('https:\/\/api\.test\/public\/background\/two\.png'\);/);
    // A solid design clears design 1's artwork instead of inheriting it.
    expect(html).toMatch(/\.card-front\.d2::before \{ background: none; opacity: 1; \}/);
  });
});
