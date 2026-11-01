import { describe, it, expect, beforeAll } from 'vitest';
import ejs from 'ejs';
import fs from 'fs/promises';
import { readdirSync } from 'fs';
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
      payment: {},
      playlist: { name: 'P' },
      // deckDesigns puts the order line first, as the route does
      php: designs[0],
      tracks,
      designs,
      cardDesigns: cardDesignIndexes.map((k) => designs[k]),
      cardDesignIndexes,
      user: {},
      eco: false,
      emptyPages: 0,
      batchNumber: '55',
      startIndex,
      howtoTranslations: designs[0].addHowToCard ? HOWTO : null,
      ...helpers,
    },
    { filename: file }
  );
}

const HOWTO = { title: 'How to play', rulesTitle: 'Rules', rule1: '1', rule2: '2', rule3: '3', rule4: '4', rule5: '5' };

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

/**
 * A design's 0 is a choice the designers offer: a gradient pointing up (0°),
 * colours meeting at the edge (position 0), a transparent picture. The
 * templates used `x || 180`, so a 0 printed as the default while the preview
 * showed the 0. Every pdf_*.ejs card template, the consumer ones and the
 * company ones, now writes these fallbacks as `x ?? y`.
 */
describe('a design value of 0', () => {
  // Front: from #aa0000 at 0% to #00aa00 at 50%; back: #0000aa to #aaaa00.
  const zeroDesign = {
    backgroundFrontType: 'solid',
    backgroundFrontColor: '#aa0000',
    useFrontGradient: true,
    gradientFrontColor: '#00aa00',
    gradientFrontDegrees: 0,
    gradientFrontPosition: 0,
    backgroundBackType: 'solid',
    backgroundBackColor: '#0000aa',
    useGradient: true,
    gradientBackgroundColor: '#aaaa00',
    gradientDegrees: 0,
    gradientPosition: 0,
  };
  const zero = { ...php, ...zeroDesign };
  const FRONT_UP = 'linear-gradient(0deg, #aa0000 0%, #00aa00 50%)';
  const BACK_UP = 'linear-gradient(0deg, #0000aa 0%, #aaaa00 50%)';

  const COMPANY_TEMPLATES = readdirSync(VIEWS)
    .map((file) => /^pdf_(.+)\.ejs$/.exec(file)?.[1])
    .filter((name): name is string => !!name && !TEMPLATES.includes(name))
    .filter((name) => !/^(bingo|box_insert|complete)/.test(name));

  for (const template of TEMPLATES) {
    it(`pdf_${template}.ejs draws 0° and position 0 for design 1 and for an extra design`, async () => {
      const extra = sanitizeCardDesign({
        ...zeroDesign,
        backgroundFrontColor: '#110000',
        gradientFrontColor: '#001100',
        backgroundBackColor: '#000011',
        gradientBackgroundColor: '#111100',
      });
      const html = await render(template, deckDesigns(zero, [extra]));
      expect(html).toContain(FRONT_UP);
      expect(html).toContain(BACK_UP);
      expect(html).toContain('linear-gradient(0deg, #110000 0%, #001100 50%)');
      expect(html).toContain('linear-gradient(0deg, #000011 0%, #111100 50%)');
    });
  }

  it('finds the company templates', () => {
    expect(COMPANY_TEMPLATES).toEqual(expect.arrayContaining(['klomp', 'schneiders', 'steinkemper', 'gebo', 'kramp', 'ahaieee']));
  });

  for (const template of COMPANY_TEMPLATES) {
    it(`pdf_${template}.ejs draws 0° and position 0, the how-to card included`, async () => {
      const html = await render(template, deckDesigns({ ...zero, addHowToCard: 1 }));
      expect(html).toContain(BACK_UP);
      // pdf_bird and pdf_facta draw the front from their own artwork.
      if (!['bird', 'facta'].includes(template)) expect(html).toContain(FRONT_UP);
    });
  }

  it('prints a 0 opacity as 0 in pdf_ahaieee.ejs, as every other template already did', async () => {
    const html = (await render('ahaieee', deckDesigns({ ...php, frontOpacity: 0 }))).replace(/\s+/g, ' ');
    expect(html).toMatch(/\.card-front::before \{[^}]*opacity: 0;/);
  });

  it('keeps the defaults for a design that never set them', async () => {
    const unset = { ...zero };
    for (const key of ['gradientFrontDegrees', 'gradientFrontPosition', 'gradientDegrees'] as const) delete (unset as any)[key];
    const html = await render('printer', deckDesigns({ ...unset, gradientPosition: 50 }));
    expect(html).toContain('linear-gradient(180deg, #aa0000 0%, #00aa00 100%)');
    expect(html).toContain('linear-gradient(180deg, #0000aa 0%, #aaaa00 100%)');
  });
});
