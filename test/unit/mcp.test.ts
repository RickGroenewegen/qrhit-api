import { describe, it, expect } from 'vitest';

/**
 * QRSong! in ChatGPT (src/mcp): the hand-off links, the tools on stubbed
 * data, and the JSON-RPC endpoint's protocol.
 */

import { featuredLink, playlistLink, siteLocale } from '../../src/mcp/links';
import {
  McpToolDeps,
  formatMoney,
  getDeliveryTime,
  getPlaylist,
  getPrice,
  parseDecade,
  searchFeaturedPlaylists,
} from '../../src/mcp/tools';
import { handleMcpBody, listTools } from '../../src/mcp/server';
import { parseOrderSource } from '../../src/orderSource';
import { ServiceType } from '../../src/enums/ServiceType';

const featured = [
  { name: 'Top 100 All Time', slug: 'top-100', numberOfTracks: 100, genreName: 'Pop', description: 'The biggest hits', decadePercentage1980: 20 },
  { name: '80s Party', slug: '80s-party', numberOfTracks: 150, genreName: 'Pop', description: 'Dance floor fillers', decadePercentage1980: 90 },
  { name: 'Rock Classics', slug: 'rock-classics', numberOfTracks: 200, genreName: 'Rock', description: 'Guitars from the 70s and 80s', decadePercentage1980: 40 },
  { name: 'Too Big', slug: 'too-big', numberOfTracks: 2500, genreName: 'Pop', description: '' },
  { name: 'No Page', slug: null, numberOfTracks: 50, genreName: 'Pop', description: '' },
];

const deps = (over: Partial<McpToolDeps> = {}): McpToolDeps => ({
  featured: async () => featured,
  priceOfDeck: async (cards) => 20 + cards / 10,
  calculateOrder: async (params: any) => {
    const item = params.cart.items[0];
    const shipping = params.countrycode ? 4 : 0;
    const boxFee = item.boxEnabled ? 6.99 * item.boxQuantity : 0;
    const gamesFee = item.gamesEnabled ? 5 : 0;
    return {
      success: true,
      data: {
        total: item.price * item.amount + shipping + boxFee + gamesFee,
        shipping,
        shippingSaved: 0,
        gamesFee,
        boxFee,
        totalBoxCount: item.boxQuantity,
      },
    };
  },
  convert: async (amount, currency) =>
    currency === 'NOK' ? { amount: Math.round(amount * 12), currency } : { amount, currency: 'EUR' },
  playlistFromUrl: async () => ({
    success: true,
    serviceType: ServiceType.APPLE_MUSIC,
    data: { id: 'pl.abc', name: 'My list', description: '', imageUrl: null, trackCount: 80 },
  }),
  shippingInfo: async () => ({
    productionDays: 3,
    productionMessage: null,
    countries: [{ countryCode: 'NL', averageDays: 2, minDays: 1, maxDays: 3, orderCount: 40 }],
  }),
  ...over,
});

describe('hand-off links', () => {
  it('opens a featured playlist on printed cards, marked as from ChatGPT', () => {
    expect(featuredLink('nl', 'top-100')).toMatch(
      /\/nl\/product\/top-100\?orderType=physical&src=chatgpt$/
    );
  });

  it('opens an own playlist on the summary route with the service as the enum writes it', () => {
    expect(playlistLink('de', ServiceType.APPLE_MUSIC, 'pl.abc')).toMatch(
      /\/de\/generate\/summary\/pl\.abc\/0\/1\/apple_music\?orderType=physical&src=chatgpt$/
    );
  });

  it('falls back to English for a language the site does not have', () => {
    expect(siteLocale('xx')).toBe('en');
    expect(siteLocale('nl-BE')).toBe('nl');
    expect(siteLocale(undefined)).toBe('en');
  });
});

describe('search_featured_playlists', () => {
  it('returns the market order without a query, leaving out what cannot be ordered as printed cards', async () => {
    const { playlists } = await searchFeaturedPlaylists({ locale: 'nl' }, deps());
    expect(playlists.map((p) => p.name)).toEqual(['Top 100 All Time', '80s Party', 'Rock Classics']);
    expect(playlists[0].price).toEqual({ amount: 30, currency: 'EUR', text: '€30' });
  });

  it('puts a name match first and filters on the decade', async () => {
    const byName = await searchFeaturedPlaylists({ query: 'rock' }, deps());
    expect(byName.playlists[0].name).toBe('Rock Classics');
    const byDecade = await searchFeaturedPlaylists({ decade: '80s' }, deps());
    expect(byDecade.playlists.map((p) => p.name)).toEqual(['80s Party', 'Rock Classics']);
  });

  it('gives the popular ones with a note when nothing matches', async () => {
    const result = await searchFeaturedPlaylists({ query: 'zydeco' }, deps());
    expect(result.playlists).toHaveLength(3);
    expect(result.note).toMatch(/get_playlist/);
  });

  it('prices in the currency of the country', async () => {
    const { playlists } = await searchFeaturedPlaylists({ country: 'NO', limit: 1 }, deps());
    expect(playlists[0].price).toEqual({ amount: 360, currency: 'NOK', text: 'NOK 360' });
  });
});

describe('get_playlist', () => {
  it('returns the cards, the price and the link', async () => {
    const result = await getPlaylist({ url: 'https://music.apple.com/x', locale: 'nl' }, deps());
    expect(result).toMatchObject({ found: true, cards: 80, service: 'apple_music' });
    expect(result['url']).toMatch(/apple_music\?orderType=physical&src=chatgpt$/);
  });

  it('does not look up something that is not a link', async () => {
    let called = false;
    const result = await getPlaylist(
      { url: 'my playlist' },
      deps({ playlistFromUrl: async () => { called = true; return { success: false }; } })
    );
    expect(result['found']).toBe(false);
    expect(called).toBe(false);
  });

  it('names the limit for a playlist too big to print, without a price', async () => {
    const result = await getPlaylist(
      { url: 'https://open.spotify.com/playlist/x' },
      deps({
        playlistFromUrl: async () => ({
          success: true,
          serviceType: ServiceType.SPOTIFY,
          data: { id: 'x', name: 'Big', description: '', imageUrl: null, trackCount: 2400 },
        }),
      })
    );
    expect(result['price']).toBeUndefined();
    expect(result['note']).toMatch(/2000/);
  });
});

describe('get_price', () => {
  it('leaves shipping out until the country is known', async () => {
    const result = await getPrice({ cards: 100 }, deps());
    expect(result).toMatchObject({ available: true, totalIncludesShipping: false });
    expect(result['shipping']).toBeUndefined();
    expect(result['total']).toMatchObject({ amount: 30 });
  });

  it('adds sets, gift box, games and shipping', async () => {
    const result = await getPrice({ cards: 100, sets: 2, giftBox: true, games: true, country: 'nl' }, deps());
    expect(result).toMatchObject({ sets: 2, shipsTo: 'NL', giftBoxes: 1, totalIncludesShipping: true });
    expect((result['total'] as any).amount).toBeCloseTo(60 + 4 + 6.99 + 5);
  });

  it('refuses more cards than can be printed', async () => {
    expect(await getPrice({ cards: 2001 }, deps())).toMatchObject({ available: false });
    expect(await getPrice({ cards: 0 }, deps())).toMatchObject({ available: false });
  });
});

describe('get_delivery_time', () => {
  it('gives the days for a country with deliveries, and says so without', async () => {
    expect(await getDeliveryTime({ country: 'nl' }, deps())).toMatchObject({
      known: true,
      totalDaysEstimate: 5,
    });
    expect(await getDeliveryTime({ country: 'BR' }, deps())).toMatchObject({ known: false });
  });
});

describe('helpers', () => {
  it('reads a decade', () => {
    expect(parseDecade('80s')).toBe(1980);
    expect(parseDecade('jaren 90')).toBe(1990);
    expect(parseDecade(2015)).toBe(2010);
    expect(parseDecade('rock')).toBeNull();
  });

  it('writes amounts without cents when there are none', () => {
    expect(formatMoney(23.5, 'EUR')).toBe('€23.50');
    expect(formatMoney(5000, 'HUF')).toBe('HUF 5000');
  });

  it('stores only a known order source', () => {
    expect(parseOrderSource('ChatGPT')).toBe('chatgpt');
    expect(parseOrderSource('newsletter')).toBeNull();
    expect(parseOrderSource(undefined)).toBeNull();
  });
});

describe('the MCP endpoint', () => {
  it('answers initialize with the tools capability and instructions', async () => {
    const answer: any = await handleMcpBody({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(answer.result.protocolVersion).toBe('2025-03-26');
    expect(answer.result.capabilities.tools).toBeDefined();
    expect(answer.result.instructions).toMatch(/printed cards/);
  });

  it('gives no answer to a notification', async () => {
    expect(await handleMcpBody({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('lists every tool as read-only, without login, with explicit hints', () => {
    const tools: any[] = listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'search_featured_playlists',
      'get_playlist',
      'get_price',
      'get_delivery_time',
      'get_support_contact',
    ]);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(typeof tool.annotations.openWorldHint).toBe('boolean');
      expect(tool.securitySchemes).toEqual([{ type: 'noauth' }]);
      expect(tool.description).not.toMatch(/digital|PDF|discount|€/i);
    }
    expect(tools.find((t) => t.name === 'get_playlist').annotations.openWorldHint).toBe(true);
  });

  it('calls a tool and returns text plus structured content', async () => {
    const answer: any = await handleMcpBody({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_support_contact', arguments: { locale: 'nl' } },
    });
    expect(answer.result.structuredContent.email).toBe('info@qrsong.io');
    expect(JSON.parse(answer.result.content[0].text).faq).toMatch(/\/nl\/faq$/);
  });

  it('rejects an unknown method and an unknown tool', async () => {
    const method: any = await handleMcpBody({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    expect(method.error.code).toBe(-32601);
    const tool: any = await handleMcpBody({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'place_order' },
    });
    expect(tool.error.code).toBe(-32602);
  });
});
