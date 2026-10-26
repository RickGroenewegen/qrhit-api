import { describe, it, expect } from 'vitest';
import { resolveYouTubeTitleAndArtist } from '../../../src/providers/youtubeTitle';

/**
 * Artist and title of YouTube Music playlist items. The cases are real titles
 * from customers' playlists (2026-10-26), most from the order whose official
 * videos all came out as "Artist - Artist".
 */

const OMV = 'MUSIC_VIDEO_TYPE_OMV';
const UGC = 'MUSIC_VIDEO_TYPE_UGC';
const ATV = 'MUSIC_VIDEO_TYPE_ATV';

const parse = (title: string, channel: string, type: string | null) =>
  resolveYouTubeTitleAndArtist(title, channel, type);

describe('resolveYouTubeTitleAndArtist: catalogue songs', () => {
  it('keeps the title and artist of a song as they are', () => {
    expect(parse('Song - Live Version', 'Real Artist', ATV)).toEqual({
      name: 'Song - Live Version',
      artist: 'Real Artist',
    });
    expect(parse('ピースサイン - Peace Sign', 'Kenshi Yonezu', ATV)).toEqual({
      name: 'ピースサイン - Peace Sign',
      artist: 'Kenshi Yonezu',
    });
  });
});

describe('resolveYouTubeTitleAndArtist: official videos', () => {
  it('takes the title after the artist instead of the artist twice', () => {
    expect(parse('Menelaos - Magda (Official Video)', 'Menelaos', OMV)).toEqual({
      name: 'Magda',
      artist: 'Menelaos',
    });
    expect(parse('The Beatles - Yellow Submarine (Official Music Video)', 'The Beatles', OMV)).toEqual({
      name: 'Yellow Submarine',
      artist: 'The Beatles',
    });
  });

  it('prints the plainest spelling of the artist', () => {
    // channel suffix in the title
    expect(parse('LOVERBOY Polska - Chcę buziaka (Official video)', 'Loverboy', OMV)).toEqual({
      name: 'Chcę buziaka',
      artist: 'Loverboy',
    });
    // channel suffix on the channel
    expect(
      parse('SŁAWOMIR - Miłość w Zakopanem (Official Video Clip HIT 2017)', 'SŁAWOMIR gwiazda Rock Polo', OMV)
    ).toEqual({ name: 'Miłość w Zakopanem', artist: 'SŁAWOMIR' });
    // the same name, not in capitals
    expect(parse('Tomasz Niecik - Cztery osiemnastki', 'TOMASZ NIECIK', OMV)).toEqual({
      name: 'Cztery osiemnastki',
      artist: 'Tomasz Niecik',
    });
    expect(parse('SKOLIM - Palermo (Official Video)', 'SKOLIM Official', OMV).artist).toBe('SKOLIM');
  });

  it('keeps every credited artist', () => {
    expect(parse('FiNCH & BLÜMCHEN - HERZALARM', 'FiNCH', OMV).artist).toBe('FiNCH & BLÜMCHEN');
    expect(parse('Juli Fabian & Zoohacker - It\'s Time', 'Zoohacker', OMV).artist).toBe(
      'Juli Fabian & Zoohacker'
    );
  });

  it('takes the artist from the title when the channel is a label', () => {
    expect(parse('MiłyPan - Ale Kot (Official Video)', 'Lemon Records', OMV)).toEqual({
      name: 'Ale Kot',
      artist: 'MiłyPan',
    });
  });

  it('reads "Title - Artist" when the artist is the channel', () => {
    expect(
      parse("What I've Done (Official Music Video) [4K Upgrade] - Linkin Park", 'Linkin Park', OMV)
    ).toEqual({ name: "What I've Done", artist: 'Linkin Park' });
    expect(parse('Kocica - Edyta JOŃCZYK - hit Tik Toka', 'Edyta JOŃCZYK', OMV)).toEqual({
      name: 'Kocica',
      artist: 'Edyta JOŃCZYK',
    });
  });

  it('does not split a version or a title written in two scripts', () => {
    expect(parse('Sandstorm - Radio Edit', 'Darude', OMV)).toEqual({
      name: 'Sandstorm - Radio Edit',
      artist: 'Darude',
    });
    expect(parse('Boulevard of Broken Dreams - Single Album Version', 'Green Day', OMV).artist).toBe(
      'Green Day'
    );
    expect(parse('インフェルノ - Inferno', 'Mrs. GREEN APPLE', OMV)).toEqual({
      name: 'インフェルノ - Inferno',
      artist: 'Mrs. GREEN APPLE',
    });
  });

  it('removes what describes the video, and only that', () => {
    expect(parse('Cliver - Moje ciało oszalało (Official Clip) NOWOŚĆ 2012', 'Cliver', OMV).name).toBe(
      'Moje ciało oszalało'
    );
    expect(parse('ALBIK - "LOUI VUITON" Nowość Disco Polo 2022', 'Albik', OMV).name).toBe('LOUI VUITON');
    expect(parse('LOVERBOY Polska - Jak cię poderwać (Official Video) 2017', 'Loverboy', OMV).name).toBe(
      'Jak cię poderwać'
    );
    expect(parse('Menelaos - Prima Sort (Truskaweczka) Official Video', 'Menelaos', OMV).name).toBe(
      'Prima Sort (Truskaweczka)'
    );
    expect(parse('LOVERBOY Polska - Dajesz (Nie przestajesz) (OFFICIAL VIDEO)', 'Loverboy', OMV).name).toBe(
      'Dajesz (Nie przestajesz)'
    );
    expect(parse('DAJ TO GŁOŚNIEJ - ZE WSI DZIEWCZYNA ┇Oficjalny Teledysk', 'Daj To Głośniej', OMV)).toEqual({
      name: 'ZE WSI DZIEWCZYNA',
      artist: 'Daj To Głośniej',
    });
    expect(parse('Survive Said The Prophet - MUKANJYO | Official Music Video', 'Survive Said The Prophet', OMV).name).toBe(
      'MUKANJYO'
    );
    expect(parse('Skaner - Wakacyjny Romans - Official Video', 'Skaner', OMV).name).toBe('Wakacyjny Romans');
    expect(parse('Akcent - Mała Figlarka (1994)', 'Akcent', OMV).name).toBe('Mała Figlarka');
    expect(parse('Shouse - Love Tonight (David Guetta Remix)', 'David Guetta', OMV)).toEqual({
      name: 'Love Tonight (David Guetta Remix)',
      artist: 'Shouse',
    });
  });

  it('keeps a title without an artist in it', () => {
    expect(parse('Grzybowa', 'LETNI', OMV)).toEqual({ name: 'Grzybowa', artist: 'LETNI' });
    expect(parse('All The Small Things (Official Music Video)', 'blink-182', OMV)).toEqual({
      name: 'All The Small Things',
      artist: 'blink-182',
    });
    expect(parse("What's Up ?", '4 Non Blondes', OMV).name).toBe("What's Up ?");
  });

  it('splits on a pipe only when one side is the channel', () => {
    expect(parse('Lily Allen | Not Fair (Official Video)', 'Lily Allen', OMV)).toEqual({
      name: 'Not Fair',
      artist: 'Lily Allen',
    });
  });
});

describe('resolveYouTubeTitleAndArtist: uploads', () => {
  it('replaces the uploader with the artist from the title', () => {
    expect(parse('Queen - Bohemian Rhapsody', 'RandomChannel', UGC)).toEqual({
      name: 'Bohemian Rhapsody',
      artist: 'Queen',
    });
    expect(parse('MOTYL - Bronek ( Official Video )', 'MUSIC SOUL atelier ', UGC)).toEqual({
      name: 'Bronek',
      artist: 'MOTYL',
    });
    expect(parse('CHACHI – Cherry Cake (music video) // UMK26', 'Uuden Musiikin Kilpailu', UGC)).toEqual({
      name: 'Cherry Cake',
      artist: 'CHACHI',
    });
  });

  it('does not take a channel that tags its own name onto every title for the artist', () => {
    expect(
      parse('Rona Nishliu - Suus - Albania - Live - Grand Final - 2012 Eurovision Song Contest', 'Eurovision Song Contest', UGC)
        .artist
    ).toBe('Rona Nishliu');
    expect(parse('Hydra - Als het gras twee kontje hoog is • TopPop', 'TopPop', UGC)).toEqual({
      name: 'Als het gras twee kontje hoog is',
      artist: 'Hydra',
    });
    expect(parse('Piratenhits -- Anneke Drent - Jolly Jacqueline', 'Piratenhits', UGC)).toEqual({
      name: 'Jolly Jacqueline',
      artist: 'Anneke Drent',
    });
  });

  it('does not split on a dash inside brackets', () => {
    expect(parse('OJ WYMASUJ MNIE ROMANIE (cover – Jessica Music)', 'Kuzyn', UGC)).toEqual({
      name: 'OJ WYMASUJ MNIE ROMANIE (cover – Jessica Music)',
      artist: 'Kuzyn',
    });
  });

  it('treats a hyphen inside a word as part of the title', () => {
    expect(parse('Toples-SĄSIADKA', 'Anna Tuchowska', UGC)).toEqual({
      name: 'Toples-SĄSIADKA',
      artist: 'Anna Tuchowska',
    });
  });

  it('handles a missing video type like an upload', () => {
    expect(parse('Sylver - I Hate You Now (Live At Jim Fuzz! Bobbejaanland 2010)', 'RamirezAriel', null)).toEqual({
      name: 'I Hate You Now (Live At Jim Fuzz! Bobbejaanland 2010)',
      artist: 'Sylver',
    });
  });
});
