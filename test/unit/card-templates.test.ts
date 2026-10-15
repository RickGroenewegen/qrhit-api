import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  buildFontFaces,
  CardTemplateError,
  CardTemplateSource,
  CardTemplateVersion,
  cardTemplateCsp,
  checkAsset,
  checkCardSize,
  checkSource,
  describeFont,
  detectAssetType,
  FIT_SCRIPT,
  fontFaceCss,
  printerCardSizeMm,
  proofQuery,
  referencedAssets,
  renderCards,
  RenderInput,
  sampleDesign,
  SAMPLE_TRACKS,
  trialRender,
  verifyProof,
} from '../../src/cardTemplates';

/**
 * Card templates stored as data (src/cardTemplates.ts): what is refused at
 * upload, what Liquid can and cannot reach, and what the page is given.
 */

const FONTS = path.join(__dirname, '../../assets/fonts');
const API = 'https://api.example.test';

function source(over: Partial<CardTemplateSource> = {}): CardTemplateSource {
  return {
    cardSizeMm: 56,
    css: '.card-front { width: 56mm; }',
    front: '<div class="card-front {{ card.designClass }}"><img src="{{ qrUrl }}"></div>',
    back: '<div class="card-back">{{ track.artist }} {{ track.year }} {{ track.name }}</div>',
    ...over,
  };
}

function version(over: Partial<CardTemplateVersion> = {}): CardTemplateVersion {
  return { name: 'acme', version: 3, ...source(), assets: {}, ...over } as CardTemplateVersion;
}

function input(over: Partial<RenderInput> = {}): RenderInput {
  const php = sampleDesign();
  return {
    php,
    designs: [php],
    cardDesignIndexes: [0, 0],
    tracks: SAMPLE_TRACKS.slice(0, 2),
    subdir: 'abc123',
    eco: false,
    startIndex: 0,
    batchNumber: '77',
    apiUri: API,
    ...over,
  };
}

const front = (tpl: string, over: Partial<RenderInput> = {}, v: Partial<CardTemplateVersion> = {}) =>
  renderCards(version({ front: tpl, ...v }), input(over), { cacheable: false }).cards[0].front;

describe('checkSource', () => {
  it('accepts a plain template, inline SVG and a Google Fonts import', () => {
    expect(checkSource(source())).toEqual([]);
    expect(
      checkSource(
        source({
          css: "@import url('https://fonts.googleapis.com/css2?family=Unna:wght@400;700&display=block');",
          front: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
          cardSizeMm: null,
          data: { sizes: [15, 14] },
        })
      )
    ).toEqual([]);
  });

  it('refuses anything that runs code or loads from elsewhere', () => {
    const refused: [Partial<CardTemplateSource>, RegExp][] = [
      [{ front: '<script>alert(1)</script>' }, /<script> element/],
      [{ back: '<IFRAME src="x">' }, /<iframe> element/],
      [{ back: '<img src="x" onerror="alert(1)">' }, /event handler/],
      [{ back: '<a href="javascript:alert(1)">' }, /javascript: URLs/],
      [{ back: '<object data="data:text/html,x">' }, /<object>/],
      [{ front: '<link rel="stylesheet" href="/x.css">' }, /<link> element/],
      [{ front: '<style>body{}</style>' }, /<style> element/],
      [{ back: '<img src="https://evil.example/pixel.png">' }, /outside the template/],
      [{ css: "body { background: url('//evil.example/x.png'); }" }, /outside the template/],
      [{ css: "@import url('/assets/x.css');" }, /@import is only allowed/],
      [{ css: 'x { width: expression(alert(1)); }' }, /expression/],
      [{ css: '</style><script>' }, /<\/style>/],
      [{ front: "{% include 'secrets' %}" }, /include/],
      [{ back: "{% render 'x' %}" }, /render/],
      [{ cardSizeMm: 62 as any }, /cardSizeMm/],
      [{ data: [1, 2] as any }, /data must be a JSON object/],
      [{ fonts: [{ file: '../x.ttf' }] as any }, /fonts\[0\]\.file/],
      [{ fonts: [{ file: 'a.ttf', family: "x'; }" }] as any }, /family/],
      [{ fonts: [{ file: 'a.ttf', weight: 1200 }] as any }, /weight/],
      [{ designFont: 'yes' as any }, /designFont/],
    ];
    for (const [over, why] of refused) {
      expect(checkSource(source(over)).join('\n'), JSON.stringify(over)).toMatch(why);
    }
  });

  it('says on which line', () => {
    expect(checkSource(source({ back: '<div>\n\n<script>' }))[0]).toMatch(/^back line 3:/);
  });

  it('finds the assets a template names literally', () => {
    expect(referencedAssets(source({ css: "url('{{ 'voor.png' | asset }}')", back: '{{ "achter.png" | asset }}' })).sort()).toEqual([
      'achter.png',
      'voor.png',
    ]);
  });
});

describe('assets', () => {
  it('knows a file by its bytes, not its name', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } }).png().toBuffer();
    const jpg = await sharp(png).jpeg().toBuffer();
    const webp = await sharp(png).webp().toBuffer();
    expect(detectAssetType(png)).toBe('png');
    expect(detectAssetType(jpg)).toBe('jpeg');
    expect(detectAssetType(webp)).toBe('webp');
    expect(detectAssetType(fs.readFileSync(path.join(FONTS, 'Aeonik-Light.woff2')))).toBe('woff2');
    expect(detectAssetType(fs.readFileSync(path.join(FONTS, 'Lovelo.otf')))).toBe('otf');
    expect(detectAssetType(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull();

    expect(await checkAsset({ name: 'logo.png', bytes: png })).toMatch(/^[0-9a-f]{32}\.png$/);
    // Content-addressed: the same bytes are the same file.
    expect(await checkAsset({ name: 'other.png', bytes: png })).toBe(await checkAsset({ name: 'logo.png', bytes: png }));
    await expect(checkAsset({ name: 'logo.jpg', bytes: png })).rejects.toThrow(/PNG file; name it .png/);
    await expect(checkAsset({ name: 'x.svg', bytes: Buffer.from('<svg/>') })).rejects.toThrow(/not a PNG/);
    await expect(checkAsset({ name: '../x.png', bytes: png })).rejects.toThrow(/asset name/);
    await expect(checkAsset({ name: 'x.ttc', bytes: Buffer.from('ttcf\0\0\0\0') })).rejects.toThrow(/font collection/);
    await expect(checkAsset({ name: 'x.ttf', bytes: Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(64)]) })).rejects.toThrow(
      /cannot be read as a font/
    );
  });

  it('reads family, weight and style from the font files customers send', () => {
    const font = (f: string) => describeFont(fs.readFileSync(path.join(FONTS, f)), f);
    expect(font('Aeonik-Light.woff2')).toMatchObject({ family: 'Aeonik', weight: 250, style: 'normal', format: 'woff2', postscriptName: 'Aeonik-Light' });
    expect(font('Moret-BookOblique.otf')).toMatchObject({ family: 'Moret', weight: 300, style: 'italic', format: 'opentype' });
    expect(font('InterstateBoldCondensed.woff2')).toMatchObject({ family: 'Interstate', weight: 700 });
    expect(font('Lovelo.otf')).toMatchObject({ family: 'Lovelo', weight: 900 });
  });

  it('writes @font-face rules from the files, overridable per font', () => {
    const files = new Map([
      ['Aeonik-Light.woff2', fs.readFileSync(path.join(FONTS, 'Aeonik-Light.woff2'))],
      ['Moret-Bold.otf', fs.readFileSync(path.join(FONTS, 'Moret-Bold.otf'))],
    ]);
    const fonts = buildFontFaces([{ file: 'Aeonik-Light.woff2' }, { file: 'Moret-Bold.otf', family: 'Brand', weight: 700 }], files);
    expect(fonts).toEqual([
      { file: 'Aeonik-Light.woff2', family: 'Aeonik', weight: 250, style: 'normal', format: 'woff2' },
      { file: 'Moret-Bold.otf', family: 'Brand', weight: 700, style: 'normal', format: 'opentype' },
    ]);
    const css = fontFaceCss({ name: 'acme', assets: { 'Aeonik-Light.woff2': 'aa.woff2', 'Moret-Bold.otf': 'bb.otf' }, fonts }, API);
    expect(css).toContain(`font-family: 'Aeonik';\n    src: url('${API}/public/card-templates/acme/aa.woff2') format('woff2');`);
    expect(css).toContain("format('opentype');\n    font-weight: 700;");
    expect(css).toContain('font-display: block;');
    expect(() => buildFontFaces([{ file: 'missing.ttf' }], files)).toThrow(/not an asset/);
  });
});

describe('renderCards', () => {
  it('gives each card its track, QR and design, numbered over the deck', () => {
    const out = renderCards(
      version({
        front: '{{ card.number }}|{{ card.index }}|{{ qrUrl }}|{{ design.backgroundUrl }}|{{ design.logoUrl }}|{{ design.yearFontSize }}',
        back: '{{ track.artist }}|{{ order.lineId }}|{{ order.printerType }}|{{ batchNumber }}|{{ template.name }}@{{ template.version }}',
      }),
      input({ startIndex: 50 }),
      { cacheable: false }
    );
    expect(out.cards).toHaveLength(2);
    expect(out.cards[1].front).toBe(`52|51|${API}/public/qr/abc123/sample2.png|${API}/assets/images/background_brand.png||44px`);
    expect(out.cards[0].back).toBe('ABBA|0|schneiders|77|acme@3');
    expect(out.designFont).toBe(true);
  });

  it('escapes like EJS <%= and lets | raw through', () => {
    const tracks = [{ ...SAMPLE_TRACKS[0], artist: `<b>"Tom" & 'Jerry'</b>`, extraNameAttribute: '<i>live</i>' }];
    expect(front('{{ track.artist }}', { tracks })).toBe('&lt;b&gt;&#34;Tom&#34; &amp; &#39;Jerry&#39;&lt;/b&gt;');
    expect(front('{{ track.extraNameAttribute | raw }}', { tracks })).toBe('<i>live</i>');
  });

  it('follows JavaScript truthiness, as the EJS templates did', () => {
    const php = { ...sampleDesign(), background: '', gradientDegrees: 0 };
    expect(front("{% if design.background %}yes{% else %}no{% endif %}|{{ design.gradientDegrees | default: 180 }}", { php, designs: [php] })).toBe(
      'no|180'
    );
  });

  it('cannot reach the prototype, the file system or unknown names', () => {
    for (const tpl of ['{{ track.constructor }}', '{{ track.artist.constructor }}', "{{ track['__proto__'] }}", '{{ trak.artist }}']) {
      expect(() => front(tpl)).toThrow(/undefined variable/);
    }
    expect(() => front("{% include 'secrets' %}")).toThrow(CardTemplateError);
    expect(() => front('{{ track.artist | evil }}')).toThrow(/undefined filter/);
    expect(() => front("{{ 'x.png' | asset }}")).toThrow(/no asset "x.png"/);
  });

  it('stops a template that loops forever or builds huge text', () => {
    const t0 = Date.now();
    expect(() => front('{% for i in (1..100000000) %}{% endfor %}')).toThrow(/limit/);
    expect(() => front('{% assign s = "xxxxxxxxxx" %}{% for i in (1..40) %}{% assign s = s | append: s %}{% endfor %}{{ s }}')).toThrow(/limit/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('resolves assets, data, fonts and a card that follows the printer', () => {
    const v = version({
      cardSizeMm: null,
      assets: { 'kaart.png': 'cafe.png' },
      data: { panel: { top: '8.64' }, sizes: [15, 14] },
      fonts: [{ file: 'Brand.woff2', family: 'Brand', weight: 700, style: 'normal', format: 'woff2' }],
      css: ".x { top: {{ data.panel.top }}mm; width: {{ template.cardSizeMm }}mm; background: url('{{ 'kaart.png' | asset }}'); }",
      front: "{{ data.sizes | join: ' ' }}",
    });
    v.assets['Brand.woff2'] = 'beef.woff2';
    const out = renderCards(v, input({ php: { ...sampleDesign(), printerType: 'tromp' } }), { cacheable: false });
    expect(out.css).toContain(`.x { top: 8.64mm; width: 60mm; background: url('${API}/public/card-templates/acme/cafe.png'); }`);
    expect(out.css.indexOf('@font-face')).toBe(0);
    expect(out.cards[0].front).toBe('15 14');
  });

  it('gives each card of alternating designs its own design', () => {
    const one = { ...sampleDesign(), fontColor: '#111111' };
    const two = { ...sampleDesign(), fontColor: '#222222' };
    const out = renderCards(version({ back: '{{ design.fontColor }} {{ card.designClass }}' }), input({ php: one, designs: [one, two], cardDesignIndexes: [0, 1] }), {
      cacheable: false,
    });
    expect(out.cards.map((c) => c.back)).toEqual(['#111111 ', '#222222 d1']);
  });

  it('runs every check of a push on the sample cards', () => {
    expect(() => trialRender(version())).not.toThrow();
    expect(() => trialRender(version({ back: '{{ design.nope }}' }))).toThrow(/undefined variable: design.nope/);
  });
});

describe('the page', () => {
  it('allows only our own script and our own pictures and fonts', () => {
    const csp = cardTemplateCsp('https://api.qrsong.io', 'n0nce');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-n0nce'");
    expect(csp).toContain("img-src 'self' https://api.qrsong.io data:");
    expect(csp).toContain('font-src');
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("base-uri 'none'");
  });

  it('ships a fit script that parses', () => {
    expect(() => new Function(FIT_SCRIPT)).not.toThrow();
    expect(FIT_SCRIPT).toContain('data-fit-size');
  });

  it('signs proof links and refuses a changed or expired one', () => {
    const q = new URLSearchParams(proofQuery('acme', 3, 12, 6, '#002b53'));
    const exp = Number(q.get('exp'));
    expect(q.get('qc')).toBe('#002b53');
    expect(verifyProof('acme', 3, 12, 6, '#002b53', exp, q.get('sig'))).toBe(true);
    expect(verifyProof('acme', 4, 12, 6, '#002b53', exp, q.get('sig'))).toBe(false);
    expect(verifyProof('acme', 3, 13, 6, '#002b53', exp, q.get('sig'))).toBe(false);
    expect(verifyProof('acme', 3, 12, 24, '#002b53', exp, q.get('sig'))).toBe(false);
    expect(verifyProof('acme', 3, 12, 6, '#000000', exp, q.get('sig'))).toBe(false);
    const old = new URLSearchParams(proofQuery('acme', 3, 12, 6, '#000000', -10));
    expect(verifyProof('acme', 3, 12, 6, '#000000', Number(old.get('exp')), old.get('sig'))).toBe(false);
  });

  it('refuses a card size the printer does not cut', () => {
    expect(printerCardSizeMm('schneiders')).toBe(56);
    expect(printerCardSizeMm('tromp')).toBe(60);
    expect(() => checkCardSize({ name: 'acme', version: 1, cardSizeMm: 60 }, 'schneiders')).toThrow(/drawn for 60 mm cards; printer schneiders cuts 56 mm/);
    expect(() => checkCardSize({ name: 'acme', version: 1, cardSizeMm: 56 }, 'schneiders')).not.toThrow();
    expect(() => checkCardSize({ name: 'acme', version: 1, cardSizeMm: null }, 'tromp')).not.toThrow();
  });
});
