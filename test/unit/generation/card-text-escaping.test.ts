import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Card text is typed by customers (the corrections page) and, with auto_mode
 * on, printed without anybody looking. Every pdf_*.ejs card template is
 * rendered through the real sendCardPages (/qr/pdf-showcase stands in for an
 * order) and has to print it as text. No database, no Redis.
 */

const h = vi.hoisted(() => ({ view: null as any }));

const stub = vi.hoisted(() => () => {
  class Stub {
    static getInstance() {
      return new Stub();
    }
  }
  return { default: Stub };
});
vi.mock('../../../src/cache', stub);
vi.mock('../../../src/mollie', stub);
vi.mock('../../../src/data', stub);
vi.mock('../../../src/order', stub);
vi.mock('../../../src/discount', stub);
vi.mock('../../../src/review', stub);
vi.mock('../../../src/translation', stub);
vi.mock('../../../src/upgradeInvoice', stub);
vi.mock('../../../src/cardPreview', stub);
vi.mock('../../../src/services/fx', stub);
vi.mock('../../../src/prisma', stub);
vi.mock('../../../src/productPhoto/cards', () => ({ showcaseView: async () => h.view }));
vi.mock('../../../src/renderSignature', () => ({ isSignedRenderRequest: () => true }));

import paymentRoutes from '../../../src/routes/paymentRoutes';
import { plainCardTracks } from '../../../src/cardText';

const VIEWS = path.resolve('src/views');
// the bingo sheets and the box insert print no card text
const TEMPLATES = readdirSync(VIEWS)
  .filter((file) => /^pdf_.*\.ejs$/.test(file))
  .filter((file) => readFileSync(path.join(VIEWS, file), 'utf-8').includes('extraNameAttribute'))
  .map((file) => file.replace(/^pdf_|\.ejs$/g, ''));

const php = {
  paymentHasPlaylistId: 55,
  background: 'one.png',
  backgroundFrontType: 'image',
  backgroundBackType: 'solid',
  backgroundBackColor: '#fefefe',
  selectedFont: 'Arial, sans-serif',
  selectedFontSize: '16px',
  fontColor: '#010101',
  qrBackgroundType: 'square',
  qrBackgroundColor: '#ffffff',
  frontOpacity: 100,
  backOpacity: 50,
  addHowToCard: false,
  orderTemplate: null,
};

describe('customer text on the cards', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyView, { engine: { ejs }, root: VIEWS, includeViewExtension: true });
    await app.register(paymentRoutes);
  });

  afterAll(async () => {
    await app.close();
  });

  async function page(template: string, track: Record<string, unknown>): Promise<string> {
    h.view = {
      payment: null,
      user: null,
      playlist: { name: '<img src=x onerror=p()>' },
      php,
      extraDesigns: [],
      eco: false,
      requestedTemplate: template,
      subdir: 'sub',
      batchNumber: '',
      tracks: [{ trackId: 'trk1', name: 'Waterloo', artist: 'ABBA', year: 1974, ...track }],
    };
    const res = await app.inject({ method: 'GET', url: '/qr/pdf-showcase/token' });
    expect(res.statusCode, res.body).toBe(200);
    return res.body;
  }

  it('finds every card template', () => {
    expect(TEMPLATES).toContain('printer');
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(25);
  });

  it.each(TEMPLATES)('pdf_%s escapes what the customer typed', async (template) => {
    const html = await page(template, {
      name: '<img src=x onerror=a()>',
      artist: '<img src=x onerror=b()>',
      extraNameAttribute: '<img src=x onerror=c()> & "Tom"',
      extraArtistAttribute: '<img src=x onerror=d()>',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=c()&gt; &amp; &#34;Tom&#34;');
  });

  it.each(TEMPLATES)('pdf_%s keeps the hard space of the 2025 voter names', async (template) => {
    const html = await page(template, { extraNameAttribute: 'Ann&nbsp;B.&nbsp;C & Cas <3' });
    expect(html).toContain('Ann B. C &amp; Cas &lt;3');
  });

  it('decodes nothing but &nbsp;, and only in extraNameAttribute', () => {
    const tracks = [
      { name: 'A&nbsp;B', extraNameAttribute: 'x&lt;b&gt;&amp;nbsp;y&NBSP;' },
      { name: 'C', extraNameAttribute: null },
      { name: 'D' },
    ];
    expect(plainCardTracks(tracks)).toEqual([
      { name: 'A&nbsp;B', extraNameAttribute: 'x&lt;b&gt;&amp;nbsp;y&NBSP;' },
      { name: 'C', extraNameAttribute: null },
      { name: 'D' },
    ]);
    const stored = { extraNameAttribute: 'Ann&nbsp;B' };
    expect(plainCardTracks([stored])).toEqual([{ extraNameAttribute: 'Ann B' }]);
    expect(stored.extraNameAttribute).toBe('Ann&nbsp;B');
  });
});
