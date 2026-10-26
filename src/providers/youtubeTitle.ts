/**
 * Artist and title of a YouTube Music playlist item.
 *
 * A catalogue song (MUSIC_VIDEO_TYPE_ATV, _OFFICIAL_SOURCE_MUSIC) has a real
 * title and artist. A video does not: an official video (_OMV) is listed under
 * the artist's channel but titled "Artist - Title (Official Video)", and an
 * upload (_UGC, or no type) carries the uploader's channel as its artist.
 *
 * Until 2026-10-26 an official video kept its raw title, and cleanTrackName,
 * which drops everything after " - " to turn "Song - Remastered" into "Song",
 * then kept the ARTIST as the title: "Menelaos - Magda (Official Video)"
 * became "Menelaos - Menelaos". No year source finds that, the duplicate
 * filter folds every video of one artist into one card, and the artist+title
 * twin match hands one song's year to all of them. In the playlist that showed
 * it, 113 of 407 items were official videos.
 */

const CATALOG_TYPES = new Set([
  'MUSIC_VIDEO_TYPE_ATV',
  'MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC',
]);

// " - ", " – " or " — ": a hyphen inside a word ("Toples-SĄSIADKA") is not one
const DASH_SEPARATOR = /\s+[-–—]\s+/gu;
const PIPE_SEPARATOR = /\s+[|┇]+\s*/gu;

const OPENING_BRACKETS = '([【［';
const CLOSING_BRACKETS = ')]】］';

// What a bracket holds when it describes the video rather than the song:
// "(Official Video)", "( Official Video )", "[4K Upgrade]", "(Oficjalny
// Teledysk)", "(Officiële Videoclip)", "(Hit Disco Polo)", "(1994)"
const VIDEO_TAG =
  /(?<![\p{L}\p{N}])(official|oficjaln\p{L}*|offizi\p{L}*|officiel\p{L}*|offici\p{L}*le|video\p{L}*|clip|teledysk|lyrics?|audio|visuali[sz]er|remaster\p{L}*|hd|hq|uhd|4k|premiere|premiera|nowość|nowosc|disco polo|karaoke)(?![\p{L}\p{N}])|^\s*(19|20)\d{2}\s*$/iu;

// A bracketed group, with the year some channels write right after it:
// "(Official Video) 2017"
const BRACKET_GROUP =
  /\s*([([【［])([^()[\]【】［］]*)[)\]】］](\s+(?:19|20)\d{2}(?!\p{N}))?/gu;

// Unbracketed tails that are about the video, and everything after them:
// "... Official Video", "... ~Official Video", "... Oficjalny Teledysk",
// "... NOWOŚĆ 2012", "... BANGER 2025"
const TRAILING_TAG =
  /\s+~?\s*(official(\s+music)?\s+(video|clip|audio)|oficjalny\s+teledysk|teledysk|nowość|nowosc|(new|hit|banger)\s+(19|20)\d{2})(?![\p{L}\p{N}]).*$/iu;

// The same words that only describe the video at the very end of a title:
// "... Disco Polo 2021", "... UHD 4K", "... with lyrics", "... videoclip"
// ("The Lyrics of Love" keeps its title)
const ENDING_TAG =
  /\s+(disco\s+polo(\s+(19|20)\d{2})?|(uhd|hd|hq|4k)(\s+(uhd|hd|hq|4k))*|(with\s+)?lyrics?|videoclip|musikvideo|music\s*video|video\s+official(\s+hd)?)$/iu;

// The other places a channel appends things: "Title | Official Music Video",
// "Title ┇Oficjalny Teledysk", "Title // UMK26", "Title • TopPop"
const TRAILING_SEGMENT = /\s+(\||┇|\/\/|•).*$/u;

// What a cut can leave behind: "Born to Be Alive - Official Video" → "Born to Be Alive -"
const DANGLING_SEPARATOR = /[\s\-–—|┇/•]+$/u;

const WRAPPING_QUOTES = /^["'“”„«»]+(.+?)["'“”„«»]+$/u;

// "Boulevard of Broken Dreams - Single Album Version", "Sandstorm - Radio Edit"
const VERSION_SUFFIX =
  /^(((single|album|radio|tv|cd|extended|original|club|short|long|live|acoustic|instrumental|mono|stereo|demo|remastered|movie|(19|20)\d{2})\s+){0,3}(version|edit|mix|remaster(ed)?|ver\.?)|live|acoustic|instrumental)$/iu;

// "Zur Party - Official Video": no title after the dash
const ONLY_VIDEO_WORDS =
  /^((official|offizielles|oficjalny|music|musik|lyrics?|video|videoclip|audio|clip|teledysk|hd|hq|4k)\s*)+$/iu;

// "インフェルノ - Inferno": a Japanese, Chinese or Korean title with its romanisation
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// The words that join two credited artists, so "FiNCH & BLÜMCHEN" is more
// than the channel "FiNCH" and not a channel suffix like "LOVERBOY Polska"
const ARTIST_JOINER = /\s(?:&|\+|x|[Ff]eat\.?|[Ff]t\.?|vs\.?|and|und|i|with)\s|,\s/u;

// "SKOLIM Official", "Daria i Pancio Official"
const ARTIST_SUFFIX = /\s+(official|vevo)$/iu;

function stripVideoTags(text: string): string {
  return text
    .replace(BRACKET_GROUP, (group, _open, content: string) =>
      VIDEO_TAG.test(content) ? ' ' : group
    )
    .replace(/\s+/gu, ' ')
    .trim();
}

function removeTrailingTags(text: string): string {
  return text
    .replace(TRAILING_TAG, '')
    .replace(ENDING_TAG, '')
    .replace(DANGLING_SEPARATOR, '')
    .trim()
    .replace(WRAPPING_QUOTES, '$1')
    .trim();
}

function tidyTitle(text: string): string {
  return removeTrailingTags(text.replace(TRAILING_SEGMENT, ''));
}

function tidyArtist(text: string): string {
  return text.replace(ARTIST_SUFFIX, '').trim() || text.trim();
}

function withoutBrackets(text: string): string {
  return text.replace(BRACKET_GROUP, ' ').trim();
}

/** Lowercase letters and digits only, without accents: "SŁAWOMIR" → "slawomir" */
function normalizeName(text: string): string {
  return withoutBrackets(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/giu, 'l')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The title's artist names the channel: "Tomasz Niecik" / "TOMASZ NIECIK",
 * "LOVERBOY Polska" / "Loverboy", "SŁAWOMIR" / "SŁAWOMIR gwiazda Rock Polo",
 * "Juli Fabian & Zoohacker" / "Zoohacker".
 */
function namesChannel(fromTitle: string, channel: string): boolean {
  const x = normalizeName(fromTitle);
  const y = normalizeName(channel);
  if (Math.min(x.length, y.length) < 3) return x === y && x.length > 0;
  return x.includes(y) || y.includes(x);
}

/**
 * Stricter, for an artist at the END of a title ("What I've Done - Linkin
 * Park"): channels also append their own name to every title ("... 2012
 * Eurovision Song Contest", "... #Grafson"), so it has to be the channel's
 * name, or the channel's name and the artists it is joined with.
 */
function isChannelCredit(text: string, channel: string): boolean {
  const y = normalizeName(channel);
  // "Kocica - Edyta JOŃCZYK - hit Tik Toka"
  const credit = withoutBrackets(text).split(/\s+[-–—]\s+/u)[0];
  const first = credit.split(ARTIST_JOINER)[0];
  return y.length > 0 && (normalizeName(credit) === y || normalizeName(first) === y);
}

/** Of two spellings of one artist, the one to print on the card. */
function preferredArtist(fromTitle: string, channel: string): string {
  const a = tidyArtist(fromTitle);
  const b = tidyArtist(channel);
  if (normalizeName(a) === normalizeName(b)) {
    const shouting = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();
    return shouting(a) && !shouting(b) ? b : a;
  }
  // "Piratenhits -- Anneke Drent": the channel's name in front of the artist
  const afterChannel = a.slice(b.length).match(/^\s*(--|:|\|)\s*(.+)$/u);
  if (a.toLowerCase().startsWith(b.toLowerCase()) && afterChannel) {
    return afterChannel[2].trim();
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return ARTIST_JOINER.test(longer) ? longer : shorter;
}

/** The first separator that is not inside brackets: "(cover – Jessica Music)" is not one */
function findSeparator(title: string, separator: RegExp): { start: number; end: number } | null {
  for (const match of title.matchAll(separator)) {
    const before = title.slice(0, match.index);
    const depth =
      [...before].filter((c) => OPENING_BRACKETS.includes(c)).length -
      [...before].filter((c) => CLOSING_BRACKETS.includes(c)).length;
    if (depth <= 0) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}

/**
 * Split a video title into artist and title. Returns null when the title is
 * not "Artist - Title" (or "Title - Artist"), so the caller keeps the title as
 * it is and the channel as the artist.
 */
function splitOnSeparator(
  title: string,
  channelArtist: string,
  separator: RegExp,
  requireArtistMatch: boolean
): { name: string; artist: string } | null {
  const found = findSeparator(title, separator);
  if (!found) return null;

  const left = title.slice(0, found.start).trim();
  const rest = title.slice(found.end).trim();
  const right = tidyTitle(rest);
  if (!left || !right || ONLY_VIDEO_WORDS.test(right)) return null;

  if (namesChannel(left, channelArtist)) {
    return { name: right, artist: preferredArtist(left, channelArtist) };
  }
  if (isChannelCredit(right, channelArtist)) {
    return { name: tidyTitle(left), artist: preferredArtist(right, channelArtist) };
  }
  if (requireArtistMatch) return null;
  // Not an artist on the left: a version, or the title in two scripts
  const firstPart = withoutBrackets(rest).split(/\s+[-–—]\s*/u)[0].trim();
  if (VERSION_SUFFIX.test(firstPart) || (CJK.test(left) && !CJK.test(right))) {
    return null;
  }
  // The channel is a label or an uploader: the title names the artist
  return { name: right, artist: tidyArtist(left) };
}

export function resolveYouTubeTitleAndArtist(
  rawTitle: string,
  channelArtist: string,
  videoType: string | null
): { name: string; artist: string } {
  if (videoType && CATALOG_TYPES.has(videoType)) {
    return { name: rawTitle, artist: channelArtist };
  }

  const title = stripVideoTags(rawTitle);

  return (
    splitOnSeparator(title, channelArtist, DASH_SEPARATOR, false) ??
    // "Lily Allen | Not Fair": a pipe only splits when it names the channel
    splitOnSeparator(title, channelArtist, PIPE_SEPARATOR, true) ?? {
      name: removeTrailingTags(title) || rawTitle,
      artist: tidyArtist(channelArtist),
    }
  );
}
