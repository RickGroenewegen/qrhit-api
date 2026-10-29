import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { OrderSong, photoCards } from '../../src/productPhoto/orderPhoto';
import { mailPhoto } from '../../src/productPhoto/outputs';

const song = (n: number, link = `https://open.spotify.com/track/t${n}`): OrderSong => ({
  trackId: `t${n}`,
  artist: `Artist ${n}`,
  name: `Song ${n}`,
  year: 1980 + n,
  link,
  extraArtistAttribute: null,
  extraNameAttribute: null,
});

describe('photoCards (the cards on an order line\'s photo)', () => {
  it('shows five songs, the designs as on the summary page', () => {
    const cards = photoCards([1, 2, 3, 4, 5].map((n) => song(n)), 3);
    expect(cards.map((card) => card.trackId)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(cards.map((card) => card.design)).toEqual([0, 1, 2, 1, 2]);
  });

  it('lets two designs take turns, and gives one design to every card', () => {
    expect(photoCards([song(1)], 2).map((card) => card.design)).toEqual([0, 1, 0, 1, 0]);
    expect(photoCards([song(1)], 1).map((card) => card.design)).toEqual([0, 0, 0, 0, 0]);
  });

  it('repeats the songs when the playlist has fewer than five', () => {
    expect(photoCards([song(1), song(2)], 1).map((card) => card.trackId)).toEqual(['t1', 't2', 't1', 't2', 't1']);
  });

  it('opens the song in the app, or the website for a song without a link', () => {
    const [linked, bare] = photoCards([song(1), song(2, '')], 1);
    expect(linked.qrUrl).toContain(`/qr_url2?link=${encodeURIComponent('https://open.spotify.com/track/t1')}`);
    expect(bare.qrUrl).toBe('https://www.qrsong.io/');
  });
});

describe('mailPhoto', () => {
  it('lays the cutout on the mail panel at the asked width, without the empty margin', async () => {
    // a transparent 16:10 frame with one opaque "card" in the middle
    const card = await sharp({ create: { width: 400, height: 300, channels: 4, background: '#3366cc' } }).png().toBuffer();
    const master = await sharp({ create: { width: 1600, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: card, left: 600, top: 350 }])
      .png()
      .toBuffer();
    const jpeg = await mailPhoto(master, '#fff8f3', 536);
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(536);
    // trimmed to the card: about its 4:3 shape, not the frame's 16:10
    expect(info.height / info.width).toBeGreaterThan(0.7);
    // the corner is the panel's colour
    const corner = Array.from(data.subarray(0, 3));
    [0xff, 0xf8, 0xf3].forEach((value, i) => expect(Math.abs(corner[i] - value)).toBeLessThanOrEqual(3));
  });
});
