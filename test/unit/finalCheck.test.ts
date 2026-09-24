/**
 * Unit tests for src/finalCheck.ts (FinalCheck class).
 *
 * FinalCheck.runCheck() coordinates PDF rendering, AI-vision checks (design-match,
 * Hitster look-alike, readability) and PDF text scanning.
 *
 * All I/O is mocked:
 *  - src/prisma        → paymentHasPlaylist records
 *  - src/chatgpt       → configurable vision responses
 *  - src/pdf           → renderUrlToPdfBuffer stub
 *  - fs/promises       → access / readFile / mkdir / writeFile / rm stubbed
 *  - pdf-parse         → getScreenshot / getText / destroy stubbed
 *
 * No network, no DB, no filesystem.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Prisma (in-memory) ────────────────────────────────────────────────────
const prismaMock = {
  paymentHasPlaylist: {
    findMany: vi.fn(async () => []),
  },
};
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

// ─── ChatGPT (vision) ─────────────────────────────────────────────────────
const askWithImagesMock = vi.fn();
vi.mock('../../src/chatgpt', () => ({
  ChatGPT: class {
    askWithImages = askWithImagesMock;
  },
}));

// ─── PDF service ──────────────────────────────────────────────────────────
const renderUrlToPdfBufferMock = vi.fn(async () => Buffer.from('pdf-content'));
vi.mock('../../src/pdf', () => ({
  default: class {
    renderUrlToPdfBuffer = renderUrlToPdfBufferMock;
    countPDFPages = vi.fn(async () => 4);
  },
}));

// ─── pdf-parse ────────────────────────────────────────────────────────────
const pdfParseMock = {
  getScreenshot: vi.fn(async () => ({
    pages: [
      { data: Buffer.from('page1-png') },
      { data: Buffer.from('page2-png') },
    ],
  })),
  getText: vi.fn(async () => ({
    pages: [{ text: 'Normal song title' }, { text: 'Artist name 2000' }],
  })),
  destroy: vi.fn(async () => {}),
};
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor(_opts: any) {}
    getScreenshot = pdfParseMock.getScreenshot;
    getText = pdfParseMock.getText;
    destroy = pdfParseMock.destroy;
  },
}));

// ─── fs/promises ─────────────────────────────────────────────────────────
const {
  fsAccessMock,
  fsReadFileMock,
  fsMkdirMock,
  fsWriteFileMock,
  fsRmMock,
} = vi.hoisted(() => ({
  fsAccessMock: vi.fn(async () => {}),
  fsReadFileMock: vi.fn(async () => Buffer.from('pdf-bytes')),
  fsMkdirMock: vi.fn(async () => undefined),
  fsWriteFileMock: vi.fn(async () => undefined),
  fsRmMock: vi.fn(async () => undefined),
}));

// finalCheck imports `{ promises as fs } from 'fs'` so we mock 'fs'
vi.mock('fs', () => ({
  promises: {
    access: fsAccessMock,
    readFile: fsReadFileMock,
    mkdir: fsMkdirMock,
    writeFile: fsWriteFileMock,
    rm: fsRmMock,
  },
}));

// ─── sharp (cuts one card out of a rendered sheet page) ────────────────────
const { sharpExtractMock } = vi.hoisted(() => ({ sharpExtractMock: vi.fn() }));
vi.mock('sharp', () => ({
  default: vi.fn(() => {
    const chain: any = {
      // A4 at pdf-parse scale 2: 210mm = 1190px
      metadata: async () => ({ width: 1190 }),
      extract: (region: any) => {
        sharpExtractMock(region);
        return chain;
      },
      png: () => chain,
      toBuffer: async () => Buffer.from('card-png'),
    };
    return chain;
  }),
}));

// pdf-parse screenshots: the pages asked for, each with its number
const screenshotPages = async (params: any) => {
  const numbers: number[] = params.partial ?? Array.from({ length: params.first ?? 2 }, (_, i) => i + 1);
  return {
    pages: numbers.map((n) => ({ pageNumber: n, data: Buffer.from(`page${n}-png`) })),
  };
};

// ─── Logger ────────────────────────────────────────────────────────────────
vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

// ─── Environment ──────────────────────────────────────────────────────────
process.env['PUBLIC_DIR'] = '/tmp/test-public';
process.env['ASSETS_DIR'] = '/tmp/test-assets';
process.env['API_URI'] = 'https://api.qrsong.io';

import FinalCheck, {
  correctionTabForFlaggedKeys,
} from '../../src/finalCheck';

// Build a minimal paymentHasPlaylist record
function makePhp(overrides: Partial<any> = {}) {
  return {
    id: 1,
    filename: 'test-file.pdf',
    subType: null,
    eco: false,
    boxEnabled: false,
    playlist: {
      id: 10,
      playlistId: 'spotify-playlist-123',
      name: 'My Playlist',
    },
    ...overrides,
  };
}

function makePayment(overrides: Partial<any> = {}) {
  return {
    id: 42,
    paymentId: 'pay-abc123',
    qrSubDir: null,
    ...overrides,
  };
}

describe('FinalCheck.runCheck', () => {
  let fc: FinalCheck;

  beforeEach(() => {
    // Reset singleton so mocks are re-applied on each test
    (FinalCheck as any).instance = undefined;
    fc = FinalCheck.getInstance();
    prismaMock.paymentHasPlaylist.findMany.mockReset();
    askWithImagesMock.mockReset();
    pdfParseMock.getScreenshot.mockReset();
    pdfParseMock.getText.mockReset();
    pdfParseMock.destroy.mockReset();
    fsAccessMock.mockReset();
    fsReadFileMock.mockReset();
    fsMkdirMock.mockReset();
    fsWriteFileMock.mockReset();
    renderUrlToPdfBufferMock.mockReset();

    // Default: PDF file exists, getScreenshot works, getText returns clean text
    fsAccessMock.mockResolvedValue(undefined);
    fsReadFileMock.mockResolvedValue(Buffer.from('pdf-bytes'));
    fsMkdirMock.mockResolvedValue(undefined);
    fsWriteFileMock.mockResolvedValue(undefined);
    fsRmMock.mockResolvedValue(undefined);
    sharpExtractMock.mockReset();
    pdfParseMock.getScreenshot.mockImplementation(screenshotPages);
    pdfParseMock.getText.mockResolvedValue({
      pages: [{ text: 'Normal song title' }, { text: 'Artist name 2000' }],
    });
    pdfParseMock.destroy.mockResolvedValue(undefined);
    renderUrlToPdfBufferMock.mockResolvedValue(Buffer.from('live-pdf'));

    // Default AI responses: all clean
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });
  });

  it('returns ok=true when there are no physical paymentHasPlaylist records', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([]);
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with reason=pdf-missing when filename is null', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ filename: null })]);
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pdf-missing');
      expect(result.userActionable).toBe(false);
    }
  });

  it('returns ok=false with reason=pdf-missing when file does not exist on disk', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    fsAccessMock.mockRejectedValue(new Error('ENOENT: no such file'));
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pdf-missing');
    }
  });

  it('returns ok=true when all checks pass', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with reason=design-mismatch when page 1 design does not match', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: false, reason: 'wrong background' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('design-mismatch');
      expect(result.userActionable).toBe(false);
    }
  });

  it('does not flag profanity in song titles or artist names (no content check)', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    pdfParseMock.getText.mockResolvedValue({
      pages: [{ text: 'Fuck tha Police' }, { text: 'N.W.A 1988' }],
    });
    const profanityPrompts: string[] = [];
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('profanity')) profanityPrompts.push(prompt);
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(true);
    // No profanity/content prompt may ever be sent to the vision model
    expect(profanityPrompts).toHaveLength(0);
  });

  it('returns ok=false with reason=hitster when visual check detects Hitster', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('Hitster')) return { clean: false, evidence: 'literal Hitster logo found' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hitster');
      expect(result.userActionable).toBe(true);
    }
  });

  it('returns ok=false with reason=hitster when text "Hitster" appears in PDF', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    // Visual check passes, but PDF text contains "hitster"
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });
    pdfParseMock.getText.mockResolvedValue({
      pages: [{ text: 'Powered by Hitster' }, { text: '2000' }],
    });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hitster');
      expect(result.details).toContain('Hitster');
    }
  });

  it('attaches the offending card page (flaggedImages) when the card visual check flags Hitster', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      if (prompt.includes('Hitster')) return { clean: false, evidence: 'logo found' };
      return {};
    });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hitster');
      expect(result.flaggedImages?.[0].key).toBe('cardFront');
      expect(result.flaggedImages?.[0].filename).toBe('card-front.png');
      expect(Buffer.isBuffer(result.flaggedImages?.[0].buffer)).toBe(true);
      expect(result.correctionTab).toBe('card');
    }
  });

  it('checks the box inlay and flags it (reason=hitster) with the box page attached', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ boxEnabled: true, boxFilename: 'box-pay.pdf' }),
    ]);
    // Card pages clean; only the box inlay front infringes.
    askWithImagesMock.mockImplementation(
      async (prompt: string, images: string[]) => {
        if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
        if (prompt.includes('readable')) return { readable: true, details: '' };
        if (prompt.includes('Hitster')) {
          const page = images[images.length - 1] || '';
          return page.includes('box_page1')
            ? { clean: false, evidence: 'Hitster box art reproduced' }
            : { clean: true, evidence: '' };
        }
        return {};
      }
    );
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hitster');
      expect(result.userActionable).toBe(true);
      expect(result.flaggedImages).toHaveLength(1);
      expect(result.flaggedImages?.[0].key).toBe('boxFront');
      expect(result.flaggedImages?.[0].filename).toBe('box-front.png');
      expect(result.correctionTab).toBe('box');
    }
  });

  it('does NOT check the box inlay when boxEnabled is false', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ boxEnabled: false }),
    ]);
    // Mock would flag a box page, but the box must never be rendered/checked.
    askWithImagesMock.mockImplementation(
      async (prompt: string, images: string[]) => {
        if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
        if (prompt.includes('readable')) return { readable: true, details: '' };
        if (prompt.includes('Hitster')) {
          const page = images[images.length - 1] || '';
          return page.includes('box_')
            ? { clean: false, evidence: 'box' }
            : { clean: true, evidence: '' };
        }
        return {};
      }
    );
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(true);
  });

  it('collects multiple flagged pages (card + box) when several infringe', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ boxEnabled: true, boxFilename: 'box-pay.pdf' }),
    ]);
    askWithImagesMock.mockImplementation(
      async (prompt: string, images: string[]) => {
        if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
        if (prompt.includes('readable')) return { readable: true, details: '' };
        if (prompt.includes('Hitster')) {
          const page = images[images.length - 1] || '';
          return page.includes('pdf_page1') || page.includes('box_page1')
            ? { clean: false, evidence: 'x' }
            : { clean: true, evidence: '' };
        }
        return {};
      }
    );
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.flaggedImages).toHaveLength(2);
      expect(result.flaggedImages?.map((f) => f.key)).toEqual([
        'cardFront',
        'boxFront',
      ]);
      // Card + box both flagged → send the user to the card tab.
      expect(result.correctionTab).toBe('card');
    }
  });

  it('sets correctionTab=card when the textual scan finds Hitster on the card', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    pdfParseMock.getText.mockResolvedValue({
      pages: [{ text: 'Powered by Hitster' }, { text: '2000' }],
    });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hitster');
      expect(result.correctionTab).toBe('card');
    }
  });

  it('sets correctionTab=box when only the box inlay text contains Hitster', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ boxEnabled: true, boxFilename: 'box-pay.pdf' }),
    ]);
    // First getText call is the card (clean), second is the box inlay.
    pdfParseMock.getText
      .mockResolvedValueOnce({
        pages: [{ text: 'Normal song title' }, { text: 'Artist 2000' }],
      })
      .mockResolvedValueOnce({
        pages: [{ text: 'A Hitster style box' }, { text: '' }],
      });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('hitster');
      expect(result.details).toContain('Box inlay');
      expect(result.problems).toEqual([
        { check: 'hitster', design: null, place: 'box', message: 'the word "Hitster" is in the printed text' },
      ]);
      expect(result.correctionTab).toBe('box');
    }
  });

  it('returns ok=false with reason=unreadable when readability check fails', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      if (prompt.includes('readable')) return { readable: false, details: 'white text on white background' };
      return {};
    });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unreadable');
      expect(result.userActionable).toBe(false);
    }
  });

  it('skips design-match when live re-render fails', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    // Live re-render throws → livePage1/livePage2 stay null → design-match skipped
    renderUrlToPdfBufferMock.mockRejectedValue(new Error('Lambda timeout'));
    const designMatchCalls: string[] = [];
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) designMatchCalls.push(prompt);
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });
    const result = await fc.runCheck(makePayment());
    // Design-match must not have been called because liveBuffer was null
    expect(designMatchCalls).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('throws when the rasterizer returns fewer pages than asked (design gap: no graceful fallback)', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    pdfParseMock.getScreenshot
      // Only page 1 returned from getScreenshot
      .mockResolvedValueOnce({ pages: [{ pageNumber: 1, data: Buffer.from('p1') }] });

    // NOTE: suspected bug / design gap: when the rasterizer throws (e.g. a page missing)
    // the error propagates uncaught through checkOnePlaylist (try/finally, no catch)
    // and through runCheck (no catch) up to the caller. There is no graceful
    // failure result for this case.
    await expect(fc.runCheck(makePayment())).rejects.toThrow(
      /pdf-parse getScreenshot returned/
    );
  });

  it('processes multiple paymentHasPlaylist records, stopping at first failure', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ id: 1, filename: 'file1.pdf' }),
      makePhp({ id: 2, filename: 'file2.pdf' }),
    ]);

    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('Hitster')) return { clean: false, evidence: 'fail on first php' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });

    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    // Should not have processed the second php because first already failed
    if (!result.ok) {
      expect(result.paymentHasPlaylistId).toBe(1);
    }
  });

  it('includes correct identifiers in failure result', async () => {
    const php = makePhp({
      id: 99,
      playlist: { id: 7, playlistId: 'spot-abc', name: 'My Playlist' },
    });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([php]);
    fsAccessMock.mockRejectedValue(new Error('ENOENT'));
    const result = await fc.runCheck(makePayment({ id: 42 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.paymentHasPlaylistId).toBe(99);
      expect(result.playlistDbId).toBe(7);
      expect(result.playlistId).toBe('spot-abc');
    }
  });

  it('uses sheets template for subType=sheets playlist', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      makePhp({ subType: 'sheets' }),
    ]);
    // renderUrlToPdfBuffer will be called with sheets-specific URL params
    renderUrlToPdfBufferMock.mockResolvedValue(Buffer.from('sheets-pdf'));
    await fc.runCheck(makePayment());
    // The URL passed to renderUrlToPdfBuffer should contain 'printer_sheets'
    expect(renderUrlToPdfBufferMock).toHaveBeenCalledWith(
      expect.stringContaining('printer_sheets'),
      expect.any(Object)
    );
  });

  it('uses regular template for non-sheets subType', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ subType: null })]);
    renderUrlToPdfBufferMock.mockResolvedValue(Buffer.from('regular-pdf'));
    await fc.runCheck(makePayment());
    expect(renderUrlToPdfBufferMock).toHaveBeenCalledWith(
      expect.stringContaining('/printer/'),
      expect.any(Object)
    );
  });

  it('checks card 1 itself, not the how-to card in front of it', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ addHowToCard: true })]);

    await fc.runCheck(makePayment());

    const partials = pdfParseMock.getScreenshot.mock.calls.map((call: any[]) => call[0].partial);
    expect(partials).toEqual([
      [3, 4],
      [3, 4],
    ]);
    expect((renderUrlToPdfBufferMock.mock.calls[0] as any[])[1].pageRanges).toBe('1-4');
  });

  it('pins a single-design problem to the card side, without a design number', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      return { readable: false, details: 'white on cream' };
    });

    const result = await fc.runCheck(makePayment());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.designCount).toBe(1);
      expect(result.problems).toEqual([
        { check: 'unreadable', design: null, place: 'card-back', message: 'white on cream' },
      ]);
      expect(result.details).toBe('Card back: white on cream');
    }
  });

  describe('alternating designs', () => {
    // Pages 1-2 of a printer PDF are card 1 (design 1); card k is design k,
    // on pages 2k-1 and 2k (two further when a how-to card comes first).
    const partialCalls = () =>
      pdfParseMock.getScreenshot.mock.calls
        .map((call: any[]) => call[0].partial)
        .filter(Boolean);

    it('renders and checks the first card of every design', async () => {
      prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
        makePhp({ extraDesigns: [{ position: 2 }, { position: 3 }] }),
      ]);

      const result = await fc.runCheck(makePayment());

      expect(result.ok).toBe(true);
      // The live render runs to card 3 and keeps its six pages.
      const [url, options] = renderUrlToPdfBufferMock.mock.calls[0] as any[];
      expect(url).toContain('/printer/0/2/');
      expect(options.pageRanges).toBe('1-6');
      // Stored and live PDF: the pages of cards 1-3.
      expect(partialCalls()).toEqual([
        [1, 2, 3, 4, 5, 6],
        [1, 2, 3, 4, 5, 6],
      ]);
      const prompts = askWithImagesMock.mock.calls.map((call: any[]) => call[0]);
      expect(prompts.filter((p: string) => p.includes('SAME OVERALL DESIGN'))).toHaveLength(6);
      expect(prompts.filter((p: string) => p.includes('Hitster product'))).toHaveLength(6);
      expect(prompts.filter((p: string) => p.includes('readable by a human'))).toHaveLength(3);
      // The printed text of each design is scanned on its own pages.
      expect(pdfParseMock.getText.mock.calls.map((call: any[]) => call[0].partial)).toEqual([
        [1, 2],
        [3, 4],
        [5, 6],
      ]);
    });

    it('skips a how-to card in front of the first card', async () => {
      prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
        makePhp({ addHowToCard: true, extraDesigns: [{ position: 2 }] }),
      ]);

      await fc.runCheck(makePayment());

      expect(partialCalls()[0]).toEqual([3, 4, 5, 6]);
      expect((renderUrlToPdfBufferMock.mock.calls[0] as any[])[1].pageRanges).toBe('1-6');
    });

    it('cuts each design out of a sheet, backs mirrored per row', async () => {
      prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
        makePhp({ subType: 'sheets', extraDesigns: [{ position: 2 }, { position: 3 }] }),
      ]);

      const result = await fc.runCheck(makePayment());

      expect(result.ok).toBe(true);
      const [url, options] = renderUrlToPdfBufferMock.mock.calls[0] as any[];
      expect(url).toContain('/printer_sheets/0/11/');
      expect(options.pageRanges).toBe('1-2');
      expect(partialCalls()).toEqual([
        [1, 2],
        [1, 2],
      ]);
      // 1190px / 210mm: a card is 340px, the margin 85px. Card 1 front is in
      // the first column and its back in the last; card 3 the other way round.
      const cells = sharpExtractMock.mock.calls.slice(0, 6).map((call: any[]) => [call[0].left, call[0].top]);
      expect(cells).toEqual([
        [85, 85], // design 1 front
        [765, 85], // design 1 back
        [425, 85], // design 2 front
        [425, 85], // design 2 back
        [765, 85], // design 3 front
        [85, 85], // design 3 back
      ]);
      expect(sharpExtractMock.mock.calls[0][0].width).toBe(340);
      const prompts = askWithImagesMock.mock.calls.map((call: any[]) => call[0]);
      expect(prompts.filter((p: string) => p.includes('readable by a human'))).toHaveLength(3);
    });

    it('checks a single-design sheet as whole pages, as before', async () => {
      prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp({ subType: 'sheets' })]);

      await fc.runCheck(makePayment());

      expect(sharpExtractMock).not.toHaveBeenCalled();
    });

    it('reports every design that drifted, by number and side', async () => {
      prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
        makePhp({ extraDesigns: [{ position: 2 }, { position: 3 }] }),
      ]);
      askWithImagesMock.mockImplementation(async (prompt: string, images: string[]) => {
        if (prompt.includes('SAME OVERALL DESIGN')) {
          if (images[0].endsWith('pdf_page4.png')) return { match: false, reason: 'wrong background' };
          if (images[0].endsWith('pdf_page5.png')) return { match: false, reason: 'logo missing' };
          return { match: true, reason: 'ok' };
        }
        if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
        return { readable: true, details: '' };
      });

      const result = await fc.runCheck(makePayment());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('design-mismatch');
        expect(result.designCount).toBe(3);
        expect(result.problems).toEqual([
          { check: 'design-mismatch', design: 2, place: 'card-back', message: 'wrong background' },
          { check: 'design-mismatch', design: 3, place: 'card-front', message: 'logo missing' },
        ]);
        expect(result.details).toBe('Design 2 back: wrong background | Design 3 front: logo missing');
      }
    });

    it('attaches a Hitster hit on another design under its own name', async () => {
      prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
        makePhp({ extraDesigns: [{ position: 2 }] }),
      ]);
      askWithImagesMock.mockImplementation(async (prompt: string, images: string[]) => {
        if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
        if (prompt.includes('Hitster')) {
          return images[images.length - 1].endsWith('pdf_page3.png')
            ? { clean: false, evidence: 'Hitster logo' }
            : { clean: true, evidence: '' };
        }
        return { readable: true, details: '' };
      });

      const result = await fc.runCheck(makePayment());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('hitster');
        expect(result.flaggedImages?.map((i) => [i.key, i.filename, i.design])).toEqual([
          ['cardFront', 'card-front-design-2.png', 2],
        ]);
        expect(result.details).toBe('Design 2 front: Hitster logo');
      }
    });

    it('names the design whose printed text says Hitster', async () => {
      prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
        makePhp({ extraDesigns: [{ position: 2 }] }),
      ]);
      pdfParseMock.getText.mockImplementation(async (params: any) => ({
        pages: [{ text: params.partial[0] === 3 ? 'Hitster edition' : 'Queen 1975' }],
      }));

      const result = await fc.runCheck(makePayment());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems).toEqual([
          { check: 'hitster', design: 2, place: 'card', message: 'the word "Hitster" is in the printed text' },
        ]);
        expect(result.correctionTab).toBe('card');
      }
    });

    it('reports every unreadable design, not only the first', async () => {
      prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
        makePhp({ extraDesigns: [{ position: 2 }, { position: 3 }] }),
      ]);
      askWithImagesMock.mockImplementation(async (prompt: string, images: string[]) => {
        if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
        if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
        return images[0].endsWith('pdf_page3.png')
          ? { readable: true, details: '' }
          : { readable: false, details: 'dark on dark' };
      });

      const result = await fc.runCheck(makePayment());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unreadable');
        expect(result.problems.map((p) => p.design)).toEqual([1, 3]);
        expect(result.details).toBe('Design 1 back: dark on dark | Design 3 back: dark on dark');
      }
    });
  });
});

describe('correctionTabForFlaggedKeys', () => {
  it('maps card-only hits to the card tab', () => {
    expect(correctionTabForFlaggedKeys(['cardFront'])).toBe('card');
    expect(correctionTabForFlaggedKeys(['cardBack'])).toBe('card');
    expect(correctionTabForFlaggedKeys(['cardFront', 'cardBack'])).toBe('card');
  });

  it('maps box-only hits to the box tab', () => {
    expect(correctionTabForFlaggedKeys(['boxFront'])).toBe('box');
    expect(correctionTabForFlaggedKeys(['boxBack'])).toBe('box');
    expect(correctionTabForFlaggedKeys(['boxFront', 'boxBack'])).toBe('box');
  });

  it('maps mixed card+box hits to the card tab', () => {
    expect(correctionTabForFlaggedKeys(['boxFront', 'cardBack'])).toBe('card');
    expect(correctionTabForFlaggedKeys(['cardFront', 'boxBack'])).toBe('card');
  });
});
