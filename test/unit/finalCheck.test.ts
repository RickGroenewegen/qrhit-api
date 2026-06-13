/**
 * Unit tests for src/finalCheck.ts (FinalCheck class).
 *
 * FinalCheck.runCheck() coordinates PDF rendering, AI-vision checks (design-match,
 * profanity, Hitster look-alike, readability) and PDF text scanning.
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

import FinalCheck from '../../src/finalCheck';

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
    pdfParseMock.getScreenshot.mockResolvedValue({
      pages: [
        { data: Buffer.from('page1-png') },
        { data: Buffer.from('page2-png') },
      ],
    });
    pdfParseMock.getText.mockResolvedValue({
      pages: [{ text: 'Normal song title' }, { text: 'Artist name 2000' }],
    });
    pdfParseMock.destroy.mockResolvedValue(undefined);
    renderUrlToPdfBufferMock.mockResolvedValue(Buffer.from('live-pdf'));

    // Default AI responses: all clean
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('profanity')) return { clean: true, categories: [], details: '' };
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
      if (prompt.includes('profanity')) return { clean: true, categories: [], details: '' };
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

  it('returns ok=false with reason=inappropriate when profanity detected', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('profanity')) return { clean: false, categories: ['hate_speech'], details: 'slur detected' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });
    const result = await fc.runCheck(makePayment());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('inappropriate');
      expect(result.userActionable).toBe(true);
      expect(result.details).toContain('hate_speech');
    }
  });

  it('returns ok=false with reason=hitster when visual check detects Hitster', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('profanity')) return { clean: true, categories: [], details: '' };
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
      if (prompt.includes('profanity')) return { clean: true, categories: [], details: '' };
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

  it('returns ok=false with reason=unreadable when readability check fails', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('profanity')) return { clean: true, categories: [], details: '' };
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
      if (prompt.includes('profanity')) return { clean: true, categories: [], details: '' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
      if (prompt.includes('readable')) return { readable: true, details: '' };
      return {};
    });
    const result = await fc.runCheck(makePayment());
    // Design-match must not have been called because liveBuffer was null
    expect(designMatchCalls).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('throws when pdfToPngPages returns < 2 pages (design gap: no graceful fallback)', async () => {
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([makePhp()]);
    pdfParseMock.getScreenshot
      // Only 1 page returned from getScreenshot
      .mockResolvedValueOnce({ pages: [{ data: Buffer.from('p1') }] });

    // NOTE: suspected bug / design gap: when pdfToPngPages throws (e.g. < 2 pages)
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

    let checkCount = 0;
    askWithImagesMock.mockImplementation(async (prompt: string) => {
      checkCount++;
      if (prompt.includes('profanity')) return { clean: false, categories: ['test'], details: 'fail on first php' };
      if (prompt.includes('SAME OVERALL DESIGN')) return { match: true, reason: 'ok' };
      if (prompt.includes('Hitster')) return { clean: true, evidence: '' };
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
});
