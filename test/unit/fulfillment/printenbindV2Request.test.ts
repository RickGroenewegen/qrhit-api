import { describe, it, expect } from 'vitest';
import {
  boxPackingComment,
  buildOrderRequest,
  gameCardsArticle,
  toPbArticle,
} from '../../../src/printers/printenbindV2Request';

// The request shapes shared by printenbindV2.ts and the Print&Bind harness
// (scripts/pnb-harness). The V2 class's own tests cover them through its
// delegates; these pin what the harness relies on directly.

const deckLine = (overrides: Record<string, any> = {}) => ({
  type: 'physical',
  paymentHasPlaylistId: 9728,
  amount: 1,
  subType: 'none',
  addHowToCard: false,
  boxEnabled: false,
  ...overrides,
});

describe('gameCardsArticle', () => {
  it('prints two pages per card and names the batch per copy file', () => {
    const article = gameCardsArticle(371, 'https://x/cards_1.pdf', deckLine(), { index: 1 });
    expect(article).toMatchObject({
      product: 'losbladig',
      copies: 742,
      size: 'custom',
      size_custom_width: 60,
      accessory_item: 'none',
      file_url: 'https://x/cards_1.pdf',
    });
    expect(article.comment).toContain('#9728-1');
  });

  it('puts the box on the cards article as a packaging accessory', () => {
    const article = gameCardsArticle(100, 'u', deckLine({ boxEnabled: true }), null);
    expect(article.accessory_group).toBe('packaging');
    expect(article.accessory_item).toBe('box_qrsong');
  });

  it('prints sheets as A4, twelve cards a side', () => {
    const article = gameCardsArticle(600, 'u', deckLine({ subType: 'sheets' }), null);
    expect(article.size).toBe('a4');
    expect(article.copies).toBe(100);
    expect(article.size_custom_width).toBeUndefined();
    expect(toPbArticle(article).borderless).toBe(false);
  });
});

describe('boxPackingComment', () => {
  it('says doos for one box and dozen for more', () => {
    expect(boxPackingComment(1)).toBe('LET OP: Deze order moet verpakt worden met in totaal 1 QRSong! doos');
    expect(boxPackingComment(2)).toBe('LET OP: Deze order moet verpakt worden met in totaal 2 QRSong! dozen');
  });
});

describe('buildOrderRequest', () => {
  const customer = {
    fullname: 'Jürgen O\'Brien-Müller with a name far longer than the label allows',
    company: 'Café Zoë & Søn B.V.',
    email: 'test@qrsong.io',
    address: 'Teststraat',
    housenumber: '1',
    zipcode: '2171AB',
    city: 'Sassenheim',
    countrycode: 'nl',
  };

  it('sends NL by post and everything else international', () => {
    expect(buildOrderRequest(customer, [], { fast: false, orderComment: '' }).delivery_method).toBe('post');
    expect(
      buildOrderRequest({ ...customer, countrycode: 'DE' }, [], { fast: false, orderComment: '' }).delivery_method
    ).toBe('international');
  });

  it('cuts fields to the API limits and puts the company on the label', () => {
    const request = buildOrderRequest(customer, [], { fast: true, orderComment: 'x'.repeat(300) });
    expect(request.contact).toHaveLength(35);
    expect(request.company).toBe('Café Zoë & Søn B.V.');
    expect(request.comment).toHaveLength(255);
    expect(request.country).toBe('NL');
    expect(request.production_method).toBe('fast');
    expect(request.anonymous).toBe(true);
  });

  it('makes the reference unique per send', () => {
    const request = buildOrderRequest(customer, [], {
      fast: false,
      orderComment: '',
      reference: 'qrs-harness-20261029-111035-deck-s-nl-1',
    });
    expect(request.reference).toMatch(/^qrs-harness-20261029-111035-deck-s-nl-1-[0-9a-z]+$/);
  });

  it('leaves company, comment and reference out when there are none', () => {
    const request = buildOrderRequest({ email: 'a@b.nl', countrycode: 'NL' }, [], { fast: false, orderComment: '' });
    expect(request).not.toHaveProperty('company');
    expect(request).not.toHaveProperty('comment');
    expect(request).not.toHaveProperty('reference');
    expect(request.contact).toBe('John Doe');
  });
});
