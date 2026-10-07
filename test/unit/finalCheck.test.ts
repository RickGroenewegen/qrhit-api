/**
 * Unit tests for src/finalCheck.ts: the Hitster detector on every picture of
 * a physical order, and the text search of its PDFs.
 *
 * All I/O is mocked:
 *  - src/prisma           → paymentHasPlaylist records
 *  - src/hitsterDetector  → a verdict per file (the model itself is tested in
 *                           hitster-detector.test.ts)
 *  - fs                   → access / readFile
 *  - pdf-parse            → getText
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  paymentHasPlaylist: {
    findMany: vi.fn(async (): Promise<any[]> => []),
  },
};
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

// The detector flags the files whose name is in `hitsterFiles`
const { detectMock, hitsterFiles } = vi.hoisted(() => ({
  detectMock: vi.fn(),
  hitsterFiles: new Map<string, { class: string; score: number }>(),
}));
vi.mock('../../src/hitsterDetector', () => ({
  default: { getInstance: () => ({ detect: detectMock }) },
}));

const pdfTextMock = vi.fn(async (_params: any) => ({ pages: [{ text: 'Normal song title' }] }));
// Screenshots: the pages asked for, each named after its PDF and number
const { screenshotMock } = vi.hoisted(() => ({ screenshotMock: vi.fn() }));
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    source: string;
    constructor(opts: any) {
      this.source = Buffer.from(opts.data).toString();
    }
    getText = pdfTextMock;
    getScreenshot = (params: any) => screenshotMock(this.source, params);
    destroy = vi.fn(async () => {});
  },
}));

// The live render of the design route, and the pixel comparison of two pages
const { renderMock, driftMock, extractMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  driftMock: vi.fn(),
  extractMock: vi.fn(),
}));
vi.mock('../../src/pdf', () => ({
  default: class {
    renderUrlToPdfBuffer = renderMock;
  },
}));
vi.mock('../../src/qrPaths', () => ({ resolveQrSubDir: async () => 'qrsub' }));
vi.mock('../../src/designDrift', () => ({ measureDrift: driftMock }));
// Reading the QR code off a page; isCardLink stays the real one
const { readQrMock } = vi.hoisted(() => ({ readQrMock: vi.fn() }));
vi.mock('../../src/qrRead', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/qrRead')>()),
  readQrCodes: readQrMock,
}));
vi.mock('sharp', () => ({
  default: vi.fn((input: Buffer) => {
    const chain: any = {
      // A4 at scale 1: 210mm = 595px
      metadata: async () => ({ width: 595 }),
      extract: (region: any) => {
        extractMock(input.toString(), region);
        return chain;
      },
      png: () => chain,
      toBuffer: async () => Buffer.from(`${input.toString()} cut`),
    };
    return chain;
  }),
}));

const { missing, fsAccessMock, fsReadFileMock } = vi.hoisted(() => {
  const missing = new Set<string>();
  return {
    missing,
    fsAccessMock: vi.fn(async (file: string) => {
      if (missing.has(file)) throw new Error('ENOENT');
    }),
    fsReadFileMock: vi.fn(async (file: string) => {
      if (missing.has(file)) throw new Error('ENOENT');
      return Buffer.from(`bytes of ${file}`);
    }),
  };
});
vi.mock('fs', () => ({
  promises: { access: fsAccessMock, readFile: fsReadFileMock },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

process.env['PUBLIC_DIR'] = '/tmp/test-public';
// finalCheck holds from HITSTER_HOLD_THRESHOLD: its default here
delete process.env['HITSTER_HOLD_THRESHOLD'];

import FinalCheck, { correctionTabForFlaggedKeys, orderPictures } from '../../src/finalCheck';

const finalCheck = FinalCheck.getInstance();
const payment = { id: 42, paymentId: 'pay-abc123', qrSubDir: null };
const file = (folder: string, name: string) => `/tmp/test-public/${folder}/${name}`;

function makePhp(overrides: Partial<any> = {}) {
  return {
    id: 1,
    filename: 'test-file.pdf',
    subType: null,
    addHowToCard: false,
    boxEnabled: false,
    background: 'frontaaaa1.png',
    backgroundFrontType: 'image',
    backgroundBack: 'backbbbb1.jpg',
    backgroundBackType: 'image',
    logo: 'logocccc1.png',
    qrLogo: null,
    extraDesigns: [],
    playlist: { id: 10, playlistId: 'spotify-playlist-123', name: 'My Playlist' },
    ...overrides,
  };
}

/** The pictures the detector was asked about, by file path. */
const asked = () => detectMock.mock.calls.map((call) => call[0].toString().replace('bytes of ', ''));

describe('FinalCheck.runCheck', () => {
  beforeEach(() => {
    prismaMock.paymentHasPlaylist.findMany.mockReset();
    detectMock.mockReset();
    detectMock.mockImplementation(async (buffer: Buffer) => {
      const name = buffer.toString().split('/').pop()!;
      const hit = hitsterFiles.get(name);
      return { scores: {}, marks: hit ? [{ ...hit, box: { x: 0, y: 0, width: 10, height: 10 } }] : [] };
    });
    hitsterFiles.clear();
    missing.clear();
    pdfTextMock.mockReset();
    pdfTextMock.mockResolvedValue({ pages: [{ text: 'Normal song title' }] });
    renderMock.mockReset();
    renderMock.mockResolvedValue(Buffer.from('live pdf'));
    screenshotMock.mockReset();
    screenshotMock.mockImplementation(async (source: string, params: any) => ({
      pages: params.partial.map((n: number) => ({ pageNumber: n, data: Buffer.from(`${source} page ${n}${params.scale === 3 ? ' @3' : ''}`) })),
    }));
    driftMock.mockReset();
    driftMock.mockResolvedValue({ changed: 0.02, colours: 0.01, drifted: false });
    extractMock.mockReset();
    // Every card's QR code reads, and leads to order line 1
    readQrMock.mockReset();
    readQrMock.mockResolvedValue(['https://api.qrsong.io/qr2/77/1']);
  });

  it('passes an order without physical cards', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([]);
    expect(await finalCheck.runCheck(payment)).toEqual({ ok: true });
  });

  it('fails with pdf-missing when there is no PDF', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ filename: null })]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'pdf-missing', userActionable: false });

    missing.add('/tmp/test-public/pdf/test-file.pdf');
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    expect(await finalCheck.runCheck(payment)).toMatchObject({ ok: false, reason: 'pdf-missing' });
    expect(detectMock).not.toHaveBeenCalled();
  });

  it('passes when every printed picture is clean, and asks no language model anything', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    expect(await finalCheck.runCheck(payment)).toEqual({ ok: true });
    expect(asked()).toEqual([
      file('background', 'frontaaaa1.png'),
      file('background', 'backbbbb1.jpg'),
      file('logo', 'logocccc1.png'),
    ]);
    // The hold threshold, stricter than the designer's warning at 0.5
    expect(detectMock.mock.calls[0][1]).toBe(0.7);
  });

  it('checks every picture the templates print: any card background type but solid, any safe filename', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ backgroundFrontType: null, background: 'frontaaaa1', backgroundBackType: 'gradient', backgroundBack: 'backbbbb1.gif' }),
    ]);
    await finalCheck.runCheck(payment);
    expect(asked()).toEqual([
      file('background', 'frontaaaa1'),
      file('background', 'backbbbb1.gif'),
      file('logo', 'logocccc1.png'),
    ]);
  });

  it('asks the model about a picture once, wherever it is used', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ backgroundBack: 'frontaaaa1.png' }),
    ]);
    await finalCheck.runCheck(payment);
    expect(asked().filter((f) => f.endsWith('frontaaaa1.png'))).toHaveLength(1);
  });

  it('flags a Hitster picture with the picture attached, for the card tab', async () => {
    hitsterFiles.set('logocccc1.png', { class: 'word', score: 0.97 });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({
      ok: false,
      reason: 'hitster',
      userActionable: true,
      correctionTab: 'card',
      paymentHasPlaylistId: 1,
      playlistDbId: 10,
      playlistId: 'spotify-playlist-123',
      designCount: 1,
    });
    if (result.ok) return;
    expect(result.problems).toEqual([
      { check: 'hitster', design: null, place: 'card-front', message: 'the word Hitster (0.97) in the logo' },
    ]);
    expect(result.details).toBe('Card front: the word Hitster (0.97) in the logo');
    expect(result.flaggedImages).toEqual([
      { key: 'cardFront', filename: 'logo.png', buffer: Buffer.from(`bytes of ${file('logo', 'logocccc1.png')}`), design: null },
    ]);
  });

  it('skips backgrounds that print as a solid colour, and names the templates would not print', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ backgroundFrontType: 'solid', backgroundBack: '../../etc/passwd.png', logo: '.hidden.png' }),
    ]);
    expect(await finalCheck.runCheck(payment)).toEqual({ ok: true });
    expect(asked()).toEqual([]);
  });

  it('holds the order, without mailing the customer, when a printed picture cannot be checked', async () => {
    missing.add(file('logo', 'logocccc1.png'));
    detectMock.mockImplementation(async (buffer: Buffer) => {
      if (buffer.toString().includes('backbbbb1')) throw new Error('hitster: picture of 9000x9000 refused');
      return { scores: {}, marks: [] };
    });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'picture-unchecked', userActionable: false });
    if (result.ok) return;
    expect(result.problems).toEqual([
      { check: 'picture-unchecked', design: null, place: 'card-back', message: 'the back background backbbbb1.jpg could not be checked (hitster: picture of 9000x9000 refused)' },
      { check: 'picture-unchecked', design: null, place: 'card-front', message: 'the logo logocccc1.png is not on disk' },
    ]);
    expect(result.flaggedImages).toBeUndefined();
  });

  it('mails about the Hitster picture and lists an unchecked one beside it', async () => {
    missing.add(file('logo', 'logocccc1.png'));
    hitsterFiles.set('frontaaaa1.png', { class: 'rings', score: 0.99 });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'hitster', userActionable: true });
    if (result.ok) return;
    expect(result.problems.map((p) => p.check)).toEqual(['hitster', 'picture-unchecked']);
    expect(result.flaggedImages?.map((i) => i.filename)).toEqual(['front-background.png']);
  });

  it('checks the box pictures only when there is a box, and sends the customer to the box tab', async () => {
    const box = {
      boxFrontBackground: 'boxfront01.png',
      boxFrontBackgroundType: 'image',
      boxFrontLogo: 'boxlogo001.png',
      boxBackBackground: 'boxback001.png',
      boxBackBackgroundType: 'solid',
      boxFilename: 'inlay.pdf',
    };
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp(box)]);
    await finalCheck.runCheck(payment);
    expect(asked().some((f) => f.includes('box'))).toBe(false);

    detectMock.mockClear();
    hitsterFiles.set('boxfront01.png', { class: 'rings', score: 0.88 });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ ...box, boxEnabled: true })]);
    const result = await finalCheck.runCheck(payment);
    // The back is a solid colour here, so it is not asked about
    expect(asked().filter((f) => f.includes('box'))).toEqual([
      file('background', 'boxfront01.png'),
      file('logo', 'boxlogo001.png'),
    ]);
    expect(result).toMatchObject({ ok: false, reason: 'hitster', correctionTab: 'box' });
    if (result.ok) return;
    expect(result.flaggedImages?.map((i) => [i.key, i.filename])).toEqual([['boxFront', 'box-front-background.png']]);
    expect(result.problems[0].message).toBe('the Hitster card rings (0.88) in the box front background');
  });

  it('names the alternating design a hit is on', async () => {
    hitsterFiles.set('design3bg1.png', { class: 'word', score: 0.91 });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({
        extraDesigns: [
          { position: 3, background: 'design3bg1.png', backgroundFrontType: 'image', backgroundBack: null, backgroundBackType: 'image', logo: null, qrLogo: null },
          { position: 2, background: 'design2bg1.png', backgroundFrontType: 'image', backgroundBack: null, backgroundBackType: 'image', logo: null, qrLogo: 'design2qr1.png' },
        ],
      }),
    ]);
    const result = await finalCheck.runCheck(payment);
    expect(asked()).toEqual([
      file('background', 'frontaaaa1.png'),
      file('background', 'backbbbb1.jpg'),
      file('logo', 'logocccc1.png'),
      file('background', 'design2bg1.png'),
      file('logo', 'design2qr1.png'),
      file('background', 'design3bg1.png'),
    ]);
    expect(result).toMatchObject({ ok: false, designCount: 3 });
    if (result.ok) return;
    expect(result.problems).toEqual([
      { check: 'hitster', design: 3, place: 'card-front', message: 'the word Hitster (0.91) in the front background' },
    ]);
    expect(result.details).toBe('Design 3 front: the word Hitster (0.91) in the front background');
    expect(result.flaggedImages?.[0]).toMatchObject({ key: 'cardFront', filename: 'design-3-front-background.png', design: 3 });
  });

  it('flags the word Hitster in the printed text, on the cards or the box', async () => {
    pdfTextMock.mockImplementation(async () => ({ pages: [{ text: 'Mijn HITSTER feest' }] }));
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'hitster', correctionTab: 'card' });
    if (result.ok) return;
    expect(result.problems).toEqual([
      { check: 'hitster', design: null, place: 'card', message: 'the word "Hitster" is in the printed text' },
    ]);
    expect(result.flaggedImages).toEqual([]);

    // Only the box inlay's text says it
    pdfTextMock.mockImplementation(async () => ({ pages: [{ text: 'clean' }] }));
    pdfTextMock.mockImplementationOnce(async () => ({ pages: [{ text: 'clean' }] }));
    pdfTextMock.mockImplementationOnce(async () => ({ pages: [{ text: 'Onze hitster avond' }] }));
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ boxEnabled: true, boxFilename: 'inlay.pdf' })]);
    expect(await finalCheck.runCheck(payment)).toMatchObject({ ok: false, correctionTab: 'box' });
  });

  it('searches the first card of every design, past the how-to card, and a sheet as its two pages', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ addHowToCard: true, extraDesigns: [{ position: 2 }] }),
    ]);
    await finalCheck.runCheck(payment);
    expect(pdfTextMock.mock.calls.map((call) => call[0].partial)).toEqual([[3, 4], [5, 6]]);

    pdfTextMock.mockClear();
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ subType: 'sheets', addHowToCard: true })]);
    await finalCheck.runCheck(payment);
    expect(pdfTextMock.mock.calls.map((call) => call[0].partial)).toEqual([[1, 2]]);
  });

  it('stops at the first order line that fails', async () => {
    hitsterFiles.set('second001.png', { class: 'speaker', score: 0.8 });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ id: 1 }),
      makePhp({ id: 2, background: 'second001.png' }),
      makePhp({ id: 3, background: 'third0001.png' }),
    ]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, paymentHasPlaylistId: 2 });
    expect(asked().some((f) => f.endsWith('third0001.png'))).toBe(false);
  });
});

describe('FinalCheck design comparison', () => {
  const stored = '/tmp/test-public/pdf/test-file.pdf';

  beforeEach(() => {
    prismaMock.paymentHasPlaylist.findMany.mockReset();
    detectMock.mockReset();
    detectMock.mockResolvedValue({ scores: {}, marks: [] });
    hitsterFiles.clear();
    missing.clear();
    pdfTextMock.mockReset();
    pdfTextMock.mockResolvedValue({ pages: [{ text: 'clean' }] });
    renderMock.mockReset();
    renderMock.mockResolvedValue(Buffer.from('live pdf'));
    screenshotMock.mockReset();
    screenshotMock.mockImplementation(async (source: string, params: any) => ({
      pages: params.partial.map((n: number) => ({ pageNumber: n, data: Buffer.from(`${source} page ${n}${params.scale === 3 ? ' @3' : ''}`) })),
    }));
    driftMock.mockReset();
    driftMock.mockResolvedValue({ changed: 0.02, colours: 0.01, drifted: false });
    extractMock.mockReset();
    // Every card's QR code reads, and leads to order line 1
    readQrMock.mockReset();
    readQrMock.mockResolvedValue(['https://api.qrsong.io/qr2/77/1']);
  });

  /** Which stored and live pages were compared, as "stored page → live page". */
  const compared = () =>
    driftMock.mock.calls.map(([a, b]: Buffer[]) => `${a.toString().replace(`bytes of ${stored} `, 'stored ')} → ${b.toString().replace('live pdf ', 'live ')}`);

  it('compares the front and back of every design with a fresh render of the design route', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ addHowToCard: true, extraDesigns: [{ position: 2 }] })]);
    expect(await finalCheck.runCheck(payment)).toEqual({ ok: true });
    const [url, options] = renderMock.mock.calls[0];
    expect(url).toContain('/qr/pdf/spotify-playlist-123/pay-abc123/printer/0/1/qrsub/0/0/0');
    expect(options).toMatchObject({ width: 60, height: 60, pageRanges: '1-6' });
    // Past the how-to card: cards on pages 3-4 and 5-6
    expect(compared()).toEqual(['stored page 3 → live page 3', 'stored page 4 → live page 4', 'stored page 5 → live page 5', 'stored page 6 → live page 6']);
  });

  it('holds the order for a person, without mailing the customer, when a design drifted', async () => {
    driftMock.mockImplementation(async (a: Buffer) =>
      a.toString().endsWith('page 4') ? { changed: 0.62, colours: 0.48, drifted: true } : { changed: 0.01, colours: 0, drifted: false }
    );
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ extraDesigns: [{ position: 2 }] })]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'design-mismatch', userActionable: false, designCount: 2 });
    if (result.ok) return;
    expect(result.problems).toEqual([
      { check: 'design-mismatch', design: 2, place: 'card-back', message: '62% of the card differs from a fresh render, colours moved 48%' },
    ]);
    expect(result.details).toBe('Design 2 back: 62% of the card differs from a fresh render, colours moved 48%');
    expect(result.flaggedImages).toBeUndefined();
  });

  it('mails about Hitster when it is there, and lists a drift beside it', async () => {
    driftMock.mockResolvedValue({ changed: 0.5, colours: 0.5, drifted: true });
    hitsterFiles.set('logocccc1.png', { class: 'word', score: 0.99 });
    detectMock.mockImplementation(async (buffer: Buffer) => {
      const hit = hitsterFiles.get(buffer.toString().split('/').pop()!);
      return { scores: {}, marks: hit ? [{ ...hit, box: { x: 0, y: 0, width: 1, height: 1 } }] : [] };
    });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'hitster', userActionable: true });
    if (result.ok) return;
    expect(result.problems.map((p) => p.check)).toEqual(['hitster', 'design-mismatch', 'design-mismatch']);
  });

  it('skips the comparison when the live render fails', async () => {
    renderMock.mockRejectedValue(new Error('Lambda timeout'));
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    expect(await finalCheck.runCheck(payment)).toEqual({ ok: true });
    expect(driftMock).not.toHaveBeenCalled();
  });

  it('holds the order when the stored PDF cannot be rasterised', async () => {
    screenshotMock.mockImplementation(async (source: string, params: any) => ({
      pages: source.startsWith('bytes of') ? [] : params.partial.map((n: number) => ({ pageNumber: n, data: Buffer.from(`p${n}`) })),
    }));
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    await expect(finalCheck.runCheck(payment)).rejects.toThrow(/no usable data for page 1/);
  });

  it('renders a sheet as A4 and cuts each design out of it, backs mirrored per row', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ subType: 'sheets', extraDesigns: [{ position: 2 }] }),
    ]);
    await finalCheck.runCheck(payment);
    const [url, options] = renderMock.mock.calls[0];
    expect(url).toContain('/printer_sheets/0/11/');
    expect(options).toMatchObject({ format: 'a4', pageRanges: '1-2' });
    // 595px for 210mm: 15mm margin = 43px, a 60mm card = 170px
    const stored1 = extractMock.mock.calls.filter(([page]) => page === `bytes of ${stored} page 1`).map(([, r]) => r.left);
    const stored2 = extractMock.mock.calls.filter(([page]) => page === `bytes of ${stored} page 2`).map(([, r]) => r.left);
    expect(stored1).toEqual([43, 213]);
    // Design 1's back is in the third column of the back page, design 2's in the second
    expect(stored2).toEqual([383, 213]);
    expect(driftMock).toHaveBeenCalledTimes(4);
  });
});

describe('FinalCheck QR codes on the print', () => {
  beforeEach(() => {
    prismaMock.paymentHasPlaylist.findMany.mockReset();
    detectMock.mockReset();
    detectMock.mockResolvedValue({ scores: {}, marks: [] });
    hitsterFiles.clear();
    missing.clear();
    pdfTextMock.mockReset();
    pdfTextMock.mockResolvedValue({ pages: [{ text: 'clean' }] });
    renderMock.mockReset();
    renderMock.mockResolvedValue(Buffer.from('live pdf'));
    screenshotMock.mockReset();
    screenshotMock.mockImplementation(async (source: string, params: any) => ({
      pages: params.partial.map((n: number) => ({ pageNumber: n, data: Buffer.from(`${source} page ${n}${params.scale === 3 ? ' @3' : ''}`) })),
    }));
    driftMock.mockReset();
    driftMock.mockResolvedValue({ changed: 0.02, colours: 0.01, drifted: false });
    extractMock.mockReset();
    readQrMock.mockReset();
    readQrMock.mockResolvedValue(['https://api.qrsong.io/qr2/77/1']);
  });

  it("reads the front of every design's first card from the stored print, at three times the size", async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ addHowToCard: true, extraDesigns: [{ position: 2 }] })]);
    expect(await finalCheck.runCheck(payment)).toEqual({ ok: true });
    expect(readQrMock.mock.calls.map(([page]: Buffer[]) => page.toString())).toEqual([
      'bytes of /tmp/test-public/pdf/test-file.pdf page 3 @3',
      'bytes of /tmp/test-public/pdf/test-file.pdf page 5 @3',
    ]);
  });

  it('passes a code that reads at the second size only: one render size can trip the decoder', async () => {
    readQrMock.mockImplementation(async (page: Buffer) => (page.toString().endsWith('@3') ? [] : ['https://api.qrsong.io/qr2/77/1']));
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    expect(await finalCheck.runCheck(payment)).toEqual({ ok: true });
    expect(readQrMock.mock.calls.map(([page]: Buffer[]) => page.toString())).toEqual([
      'bytes of /tmp/test-public/pdf/test-file.pdf page 1 @3',
      'bytes of /tmp/test-public/pdf/test-file.pdf page 1',
    ]);
  });

  it('holds the order, without mailing the customer, when a code does not scan on the print', async () => {
    readQrMock.mockImplementation(async (page: Buffer) => (page.toString().includes('page 3') ? [] : ['https://api.qrsong.io/qr2/77/1']));
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ extraDesigns: [{ position: 2 }] })]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'qr-unreadable', userActionable: false });
    if (result.ok) return;
    expect(result.problems).toEqual([
      { check: 'qr-unreadable', design: 2, place: 'card-front', message: 'the QR code on the card does not scan' },
    ]);
    expect(result.flaggedImages).toBeUndefined();
  });

  it('holds the order when a code reads but leads somewhere else', async () => {
    readQrMock.mockResolvedValue(['https://api.qrsong.io/qr2/77/999']);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'qr-unreadable' });
    if (result.ok) return;
    expect(result.problems[0].message).toBe(
      'the QR code reads as https://api.qrsong.io/qr2/77/999, not a card link of this order line'
    );
  });

  it('still mails about Hitster, listing the unreadable code beside it', async () => {
    readQrMock.mockResolvedValue([]);
    detectMock.mockResolvedValue({ scores: {}, marks: [{ class: 'word', score: 0.98, box: { x: 0, y: 0, width: 1, height: 1 } }] });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ background: null, backgroundBack: null })]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'hitster', userActionable: true });
    if (result.ok) return;
    expect(result.problems.map((p) => p.check)).toEqual(['hitster', 'qr-unreadable']);
  });

  it('a design drift comes before an unreadable code as the reason', async () => {
    readQrMock.mockResolvedValue([]);
    driftMock.mockResolvedValue({ changed: 0.5, colours: 0.5, drifted: true });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    const result = await finalCheck.runCheck(payment);
    expect(result).toMatchObject({ ok: false, reason: 'design-mismatch' });
    if (result.ok) return;
    expect(result.problems.map((p) => p.check)).toEqual(['design-mismatch', 'design-mismatch', 'qr-unreadable']);
  });
});

describe('orderPictures', () => {
  it('lists the QR logo, and the box back only when it is an image', () => {
    const pictures = orderPictures(
      makePhp({ qrLogo: 'qrlogo0001.png', boxEnabled: true, boxBackBackground: 'boxback001.png', boxBackBackgroundType: 'image' })
    );
    expect(pictures.map((p) => [p.what, p.folder, p.filename])).toEqual([
      ['front background', 'background', 'frontaaaa1.png'],
      ['back background', 'background', 'backbbbb1.jpg'],
      ['logo', 'logo', 'logocccc1.png'],
      ['QR logo', 'logo', 'qrlogo0001.png'],
      ['box back background', 'background', 'boxback001.png'],
    ]);
  });
});

describe('correctionTabForFlaggedKeys', () => {
  it('maps card-only hits to the card tab', () => {
    expect(correctionTabForFlaggedKeys(['cardFront'])).toBe('card');
    expect(correctionTabForFlaggedKeys(['cardBack'])).toBe('card');
  });

  it('maps box-only hits to the box tab', () => {
    expect(correctionTabForFlaggedKeys(['boxFront', 'boxBack'])).toBe('box');
  });

  it('maps mixed card+box hits to the card tab', () => {
    expect(correctionTabForFlaggedKeys(['boxFront', 'cardBack'])).toBe('card');
  });
});
