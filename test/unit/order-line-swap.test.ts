import { describe, it, expect } from 'vitest';
import { cardComparison, swapRefusal, type SwapLineState } from '../../src/orderLineSwap';

const NEW_ID = '2ClCpTyXqDWTbfa0Ygl4A4';

const line = (extra: Partial<SwapLineState> = {}): SwapLineState => ({
  orderId: '100009410',
  status: 'paid',
  sentToPrinter: false,
  printApiOrderId: '',
  type: 'physical',
  gifted: false,
  serviceType: 'spotify',
  currentSpotifyId: '02ElqJv6Li2OJ1b1e20Efd',
  ...extra,
});

describe('swap-playlist: which lines may take another playlist', () => {
  it('lets a paid printed line through that is not at the printer yet', () => {
    expect(swapRefusal(line(), NEW_ID)).toBeNull();
  });

  it('refuses an id that is not a Spotify playlist id', () => {
    expect(swapRefusal(line(), 'https://open.spotify.com/playlist/x')).toBe('invalid playlist id');
  });

  it('refuses an unpaid order', () => {
    expect(swapRefusal(line({ status: 'open' }), NEW_ID)).toMatch(/not paid/);
  });

  it('refuses an order at the printer, by the flag or by a printer order id', () => {
    expect(swapRefusal(line({ sentToPrinter: true }), NEW_ID)).toMatch(/already at the printer/);
    expect(swapRefusal(line({ printApiOrderId: '1538570' }), NEW_ID)).toMatch(/already at the printer/);
  });

  it('refuses a digital line: its PDF went out on finalizing', () => {
    expect(swapRefusal(line({ type: 'digital' }), NEW_ID)).toMatch(/only a printed line/);
  });

  it('refuses a given set and a line on another service', () => {
    expect(swapRefusal(line({ gifted: true }), NEW_ID)).toMatch(/gift/);
    expect(swapRefusal(line({ serviceType: 'applemusic' }), NEW_ID)).toMatch(/not spotify/);
  });

  it('refuses the playlist the line already plays', () => {
    expect(swapRefusal(line({ currentSpotifyId: NEW_ID }), NEW_ID)).toMatch(/already plays/);
  });
});

describe('swap-playlist: paid cards against the new list', () => {
  it('says so when they match', () => {
    expect(cardComparison(258, 258)).toMatchObject({ difference: 0 });
  });

  it('names more songs than paid as free cards unless the customer pays', () => {
    const c = cardComparison(258, 270);
    expect(c.difference).toBe(12);
    expect(c.note).toMatch(/12 more songs than paid cards/);
  });

  it('keeps the price for fewer songs', () => {
    const c = cardComparison(258, 240);
    expect(c.difference).toBe(-18);
    expect(c.note).toMatch(/18 fewer songs.*price stays/);
  });
});
