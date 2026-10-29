import {
  boxInsertArticle,
  boxPackingComment,
  boxUpgradeArticle,
  gameCardsArticle,
  toPbArticle,
} from '../../src/printers/printenbindV2Request';
import { cardsUrl, insertUrl } from './fixtures';
import type { FileInfo, FixtureLine, Fixtures, HarnessCase } from './types';

/** Countries the international cases ship to (deck + box, as production builds it). */
const INTERNATIONAL = ['DE', 'BE', 'FR', 'GB', 'AT', 'CH'];

interface Built {
  articles: Record<string, any>[];
  files: FileInfo[];
  pageChecks: HarnessCase['pageChecks'];
}

function fileInfo(fx: Fixtures, url: string, kind: FileInfo['kind']): FileInfo {
  return fx.files[url] ?? { url, kind, bytes: null, pages: null, fetch: 'not checked' };
}

function push(built: Built, article: any, file: FileInfo): void {
  const pb = toPbArticle(article);
  built.articles.push(pb);
  if (!built.files.some((f) => f.url === file.url)) built.files.push(file);
  built.pageChecks.push({ article: built.articles.length, copies: pb.copies, pages: file.pages });
}

/** The game-card articles of one order line: one per copy, as createOrder sends them. */
function addDeck(built: Built, fx: Fixtures, line: FixtureLine): void {
  const item = {
    type: 'physical',
    paymentHasPlaylistId: line.phpId,
    amount: line.amount,
    subType: line.subType,
    addHowToCard: line.addHowToCard,
    boxEnabled: line.boxEnabled,
  };
  line.cardFiles.forEach((file, i) => {
    const url = cardsUrl(fx.fileBase, file);
    push(
      built,
      gameCardsArticle(line.numberOfTracks, url, item, line.usesItems ? { index: i + 1 } : null),
      fileInfo(fx, url, 'cards')
    );
  });
}

/** The single-playlist insert article (copies = the insert file's pages). */
function addInsert(built: Built, fx: Fixtures, line: FixtureLine): void {
  if (!line.boxEnabled || !line.boxFilename) return;
  const url = insertUrl(fx.fileBase, line.boxFilename);
  const file = fileInfo(fx, url, 'insert');
  push(built, boxInsertArticle(url, file.pages ?? line.boxQuantity * line.amount * 2, ''), file);
}

const totalBoxes = (lines: FixtureLine[]) =>
  lines.reduce((sum, l) => sum + (l.boxEnabled ? l.boxQuantity * l.amount : 0), 0);

const describeLine = (line: FixtureLine) =>
  `payment ${line.paymentDbId} (${line.created}), ${line.numberOfTracks} cards` +
  `${line.amount > 1 ? ` ×${line.amount}` : ''}` +
  `${line.subType === 'sheets' ? ', sheets' : ''}` +
  `${line.boxEnabled ? `, ${line.boxQuantity * line.amount} box(es)` : ''}` +
  `${line.addHowToCard ? ', how-to card' : ''}`;

/**
 * Every case the harness knows, built from the fixtures with the builders
 * production uses. `placeCountries` are the countries with a configured
 * address: only those may be placed on live.
 */
export function buildCases(fx: Fixtures, placeCountries: Set<string>): HarnessCase[] {
  const cases: HarnessCase[] = [];
  const empty = (): Built => ({ articles: [], files: [], pageChecks: [] });

  const order = (
    id: string,
    title: string,
    group: HarnessCase['group'],
    lines: FixtureLine[],
    options: {
      country?: string;
      fast?: boolean;
      overrides?: HarnessCase['customerOverrides'];
      notes?: string[];
      build?: (built: Built) => void;
      comment?: string;
    } = {}
  ) => {
    const built = empty();
    if (options.build) {
      options.build(built);
    } else {
      for (const line of lines) addDeck(built, fx, line);
      for (const line of lines) addInsert(built, fx, line);
    }
    const boxes = totalBoxes(lines);
    const country = options.country ?? 'NL';
    cases.push({
      id,
      title,
      group,
      articles: built.articles,
      country,
      ...(options.overrides ? { customerOverrides: options.overrides } : {}),
      fast: options.fast ?? false,
      orderComment: options.comment ?? (boxes > 0 ? boxPackingComment(boxes) : ''),
      files: built.files,
      pageChecks: built.pageChecks,
      livePlaceable: placeCountries.has(country),
      notes: options.notes ?? [],
      source: lines.map(describeLine).join('; '),
    });
  };

  const shape = (name: string) => fx.shapes[name]?.[0];

  const small = shape('deckSmall');
  if (small) {
    order('deck-s-nl', 'Small deck, no box (canary)', 'deck', [small]);
  }
  if (shape('deckLarge')) order('deck-l-nl', 'Large deck, no box', 'deck', [shape('deckLarge')!]);
  if (shape('deckXl')) {
    order('deck-xl-nl', 'Biggest deck available (file size probe)', 'deck', [shape('deckXl')!]);
  }
  if (shape('howto')) order('deck-howto', 'Deck with how-to card', 'deck', [shape('howto')!]);
  if (shape('sheets')) order('sheets-nl', 'A4 sheets', 'deck', [shape('sheets')!]);
  if (shape('twoCopies')) {
    order('two-copies', 'One playlist ×2: one article per copy file', 'deck', [shape('twoCopies')!]);
  }

  const box1 = shape('box1');
  if (box1) order('deck-box1-nl', 'Deck + 1 box (cards with box accessory + insert)', 'box', [box1]);
  if (shape('box2')) order('deck-box2-nl', 'Deck + 2 boxes', 'box', [shape('box2')!]);
  if (shape('boxXl')) {
    order('deck-box-xl', 'Big deck + box (Print&Bind adds a box per 190 cards)', 'box', [shape('boxXl')!]);
  }
  if (fx.mergedInsert) {
    const lines = fx.mergedInsert.lines;
    const merged = fx.mergedInsert.url;
    order('two-decks-box', 'Two playlists with boxes, merged insert', 'box', lines, {
      build: (built) => {
        for (const line of lines) addDeck(built, fx, line);
        const file = fileInfo(fx, merged, 'insert');
        push(built, boxInsertArticle(merged, file.pages ?? 0, ''), file);
      },
    });
  }
  if (box1?.boxFilename) {
    const url = insertUrl(fx.fileBase, box1.boxFilename);
    const file = fileInfo(fx, url, 'insert');
    order('box-upgrade', 'Box bought afterwards: insert card carrying the box', 'box', [box1], {
      build: (built) => push(built, boxUpgradeArticle(url, box1.playlistName, file.pages ?? 0), file),
      comment: boxPackingComment(totalBoxes([box1])),
    });
    order('inlay-only', 'Insert card only (admin "inlay card only")', 'box', [box1], {
      build: (built) => push(built, boxInsertArticle(url, file.pages ?? 0, ''), file),
      comment: '',
    });
  }

  const fast = shape('fast');
  if (fast || small) {
    order('deck-fast', 'Fast production', 'deck', [fast ?? small!], {
      fast: true,
      notes: fast ? [] : ['no recent fast order: the small deck with fast production'],
    });
  }
  if (small) {
    order('deck-label', 'Company on the label, accents and an apostrophe in the names', 'probe', [small], {
      overrides: { fullname: "Jürgen O'Brien-Müller", company: 'Café Zoë & Søn B.V.' },
    });
    order('same-file-twice', 'Two articles with the same file_url (file_overwrite)', 'probe', [small], {
      build: (built) => {
        addDeck(built, fx, small);
        addDeck(built, fx, small);
      },
      notes: ['production never sends this; checks whether a shared file name trips Print&Bind'],
    });
  }

  if (box1) {
    for (const country of INTERNATIONAL) {
      order(`deck-box1-${country.toLowerCase()}`, `Deck + 1 box to ${country}`, 'international', [box1], {
        country,
        notes: placeCountries.has(country)
          ? []
          : [`no address configured for ${country}: calculated only on live`],
      });
    }
  }

  fx.replays.forEach((replay, i) => {
    const request = replay.request;
    const articles: Record<string, any>[] = request['articles'] ?? [];
    const files = articles
      .filter((a) => a['file_url'])
      .map((a) => fileInfo(fx, a['file_url'], a['product'] === 'werkblad' ? 'insert' : 'cards'));
    const country = String(request['country'] || 'NL').toUpperCase();
    cases.push({
      id: `replay-${replay.paymentDbId}${fx.replays.length > 1 && fx.replays.filter((r) => r.paymentDbId === replay.paymentDbId).length > 1 ? `-${i + 1}` : ''}`,
      title: `Replay of the request that got ${replay.status} on ${replay.created}`,
      group: 'replay',
      articles,
      country,
      fast: request['production_method'] === 'fast',
      orderComment: String(request['comment'] || ''),
      files,
      pageChecks: articles.map((a, index) => ({
        article: index + 1,
        copies: a['copies'],
        pages: fx.files[a['file_url']]?.pages ?? null,
      })),
      livePlaceable: placeCountries.has(country),
      notes: [
        `articles verbatim from payment ${replay.paymentDbId}, address replaced by ours`,
        `Print&Bind answered then: ${JSON.stringify(replay.responseBody)}`,
      ],
      source: `payment ${replay.paymentDbId} (${replay.created}), ${replay.url}`,
    });
  });

  return cases;
}
