import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pure unit tests for src/designer.ts: base64 parsing/validation branches,
 * filename/extension decisions, the sharp processing pipelines for card and
 * logo uploads, and the ownership-checked design read/update flows.
 *
 * sharp, fs/promises, prisma and utils are fully mocked; assertions target
 * the payload shapes passed to those boundaries.
 */

const holder = vi.hoisted(() => ({
  chains: [] as any[],
  nextToBufferError: null as Error | null,
  sharp: undefined as any,
  writeFile: undefined as any,
  createDir: undefined as any,
  generateRandomString: undefined as any,
  parseBoolean: undefined as any,
  prisma: {
    $queryRaw: undefined as any,
    playlist: { findFirst: undefined as any },
    paymentHasPlaylist: { update: undefined as any },
  },
}));

vi.mock('sharp', () => {
  const sharpFn = (input: Buffer) => {
    const chain: any = { __input: input };
    chain.resize = vi.fn(() => chain);
    chain.composite = vi.fn(() => chain);
    chain.png = vi.fn(() => chain);
    chain.toBuffer = vi.fn(async () => {
      if (holder.nextToBufferError) {
        const err = holder.nextToBufferError;
        holder.nextToBufferError = null;
        throw err;
      }
      return Buffer.from('processed-image');
    });
    holder.chains.push(chain);
    return chain;
  };
  holder.sharp = vi.fn(sharpFn);
  return { default: holder.sharp };
});

vi.mock('fs/promises', () => {
  const writeFile = (...args: any[]) => holder.writeFile(...args);
  return { default: { writeFile }, writeFile };
});

vi.mock('../../../src/utils', () => ({
  default: class {
    createDir = (...args: any[]) => holder.createDir(...args);
    generateRandomString = (...args: any[]) =>
      holder.generateRandomString(...args);
    parseBoolean = (...args: any[]) => holder.parseBoolean(...args);
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: {
    getInstance: () => ({
      $queryRaw: (...args: any[]) => holder.prisma.$queryRaw(...args),
      playlist: {
        findFirst: (...args: any[]) => holder.prisma.playlist.findFirst(...args),
      },
      paymentHasPlaylist: {
        update: (...args: any[]) =>
          holder.prisma.paymentHasPlaylist.update(...args),
      },
    }),
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    init = async () => {};
    log() {}
    logDev() {}
  },
}));

// Capture constructor-time createDir calls (initBackgroundDirectory).
holder.createDir = vi.fn(async () => undefined);
holder.generateRandomString = vi.fn(() => 'RANDOMID32');
holder.parseBoolean = vi.fn(
  (v: any) => v === true || v === 'true' || v === 1
);
holder.writeFile = vi.fn(async () => undefined);
holder.prisma.$queryRaw = vi.fn();
holder.prisma.playlist.findFirst = vi.fn();
holder.prisma.paymentHasPlaylist.update = vi.fn();

import Designer from '../../../src/designer';

const PUBLIC_DIR = process.env['PUBLIC_DIR'];
const designer = Designer.getInstance();

// A 1-byte payload; the exact bytes only matter for buffer assertions.
const RAW_B64 = Buffer.from('hello-image').toString('base64');
const PNG_DATA_URI = `data:image/png;base64,${RAW_B64}`;
const JPEG_DATA_URI = `data:image/jpeg;base64,${RAW_B64}`;

beforeEach(() => {
  holder.chains.length = 0;
  holder.nextToBufferError = null;
  holder.sharp.mockClear();
  holder.writeFile.mockClear();
  holder.generateRandomString.mockClear();
  holder.parseBoolean.mockClear();
  holder.prisma.$queryRaw = vi.fn();
  holder.prisma.playlist.findFirst = vi.fn();
  holder.prisma.paymentHasPlaylist.update = vi.fn();
});

describe('construction', () => {
  it('creates the background and logo directories on first instantiation', () => {
    const dirs = holder.createDir.mock.calls.map((c: any[]) => c[0]);
    expect(dirs).toContain(`${PUBLIC_DIR}/background`);
    expect(dirs).toContain(`${PUBLIC_DIR}/logo`);
  });
});

describe('uploadBackgroundImage', () => {
  it('rejects an empty image', async () => {
    expect(await designer.uploadBackgroundImage('')).toEqual({
      success: false,
      error: 'No image provided',
    });
    expect(holder.sharp).not.toHaveBeenCalled();
  });

  it('rejects a data URI that is not an image', async () => {
    expect(
      await designer.uploadBackgroundImage('data:application/pdf;base64,AAAA')
    ).toEqual({ success: false, error: 'Invalid image data format' });
  });

  it('processes a PNG data URI: 1000x1000 cover resize, transparent dest-over layer, compressed PNG', async () => {
    const result = await designer.uploadBackgroundImage(PNG_DATA_URI);

    expect(result).toEqual({ success: true, filename: 'randomid32.png' });

    // sharp received the decoded base64 payload.
    const chain = holder.chains[0];
    expect(chain.__input.equals(Buffer.from(RAW_B64, 'base64'))).toBe(true);
    expect(chain.resize).toHaveBeenCalledWith(1000, 1000, { fit: 'cover' });
    expect(chain.composite).toHaveBeenCalledWith([
      {
        input: {
          create: {
            width: 1000,
            height: 1000,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        },
        blend: 'dest-over',
      },
    ]);
    expect(chain.png).toHaveBeenCalledWith({
      compressionLevel: 9,
      quality: 90,
    });

    // Processed buffer written into PUBLIC_DIR/background.
    expect(holder.writeFile).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/background/randomid32.png`,
      Buffer.from('processed-image')
    );
  });

  it('always stores backgrounds as .png even for jpeg input', async () => {
    const result = await designer.uploadBackgroundImage(JPEG_DATA_URI);
    expect(result.filename).toBe('randomid32.png');
  });

  it('treats input without a data URI prefix as raw base64', async () => {
    const result = await designer.uploadBackgroundImage(RAW_B64);
    expect(result.success).toBe(true);
    expect(
      holder.chains[0].__input.equals(Buffer.from(RAW_B64, 'base64'))
    ).toBe(true);
  });

  it('returns a write error when image processing fails', async () => {
    holder.nextToBufferError = new Error('corrupt image');
    const result = await designer.uploadBackgroundImage(PNG_DATA_URI);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Error writing file:');
    expect(result.error).toContain('corrupt image');
    expect(holder.writeFile).not.toHaveBeenCalled();
  });
});

describe('uploadBackgroundBackImage', () => {
  it('processes the back image through the same 1000x1000 PNG pipeline', async () => {
    const result = await designer.uploadBackgroundBackImage(PNG_DATA_URI);

    expect(result).toEqual({ success: true, filename: 'randomid32.png' });
    const chain = holder.chains[0];
    expect(chain.resize).toHaveBeenCalledWith(1000, 1000, { fit: 'cover' });
    expect(chain.png).toHaveBeenCalledWith({
      compressionLevel: 9,
      quality: 90,
    });
    expect(holder.writeFile).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/background/randomid32.png`,
      Buffer.from('processed-image')
    );
  });

  it('validates input like the front upload', async () => {
    expect(await designer.uploadBackgroundBackImage('')).toEqual({
      success: false,
      error: 'No image provided',
    });
    expect(
      await designer.uploadBackgroundBackImage('data:text/plain;base64,AAAA')
    ).toEqual({ success: false, error: 'Invalid image data format' });
  });
});

describe('uploadLogoImage', () => {
  it('keeps the original image type in the filename and fits inside 800x800', async () => {
    const result = await designer.uploadLogoImage(JPEG_DATA_URI);

    expect(result).toEqual({
      success: true,
      filename: 'randomid32.jpeg',
      filePath: '/public/logo/randomid32.jpeg',
    });
    const chain = holder.chains[0];
    expect(chain.resize).toHaveBeenCalledWith(800, 800, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    // Logos are not recomposited or forced to PNG.
    expect(chain.composite).not.toHaveBeenCalled();
    expect(chain.png).not.toHaveBeenCalled();
    expect(holder.writeFile).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/logo/randomid32.jpeg`,
      Buffer.from('processed-image')
    );
  });

  it('defaults to png for raw base64 input', async () => {
    const result = await designer.uploadLogoImage(RAW_B64);
    expect(result.filename).toBe('randomid32.png');
    expect(result.filePath).toBe('/public/logo/randomid32.png');
  });

  it('rejects empty input and surfaces processing errors', async () => {
    expect(await designer.uploadLogoImage('')).toEqual({
      success: false,
      error: 'No image provided',
    });

    holder.nextToBufferError = new Error('too large');
    const result = await designer.uploadLogoImage(PNG_DATA_URI);
    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
  });
});

describe('getCardDesign', () => {
  const designRow = {
    background: 'bg.png',
    doubleSided: 1,
    eco: 0,
    type: 'physical',
    subType: 'none',
    playlistName: 'My List',
    numberOfTracks: 42,
    playlistId: 'pl1',
  };

  it('returns the design row enriched with the first track id', async () => {
    holder.prisma.$queryRaw
      .mockResolvedValueOnce([designRow])
      .mockResolvedValueOnce([{ trackId: 'track-123' }]);

    const result = await designer.getCardDesign('pay1', 'hash1', 'pl1');

    expect(result).toEqual({
      success: true,
      data: { ...designRow, firstTrackId: 'track-123' },
    });
    // Both queries are scoped by paymentId + userHash + playlistId.
    expect(holder.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(holder.prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([
      'pay1',
      'hash1',
      'pl1',
    ]);
    expect(holder.prisma.$queryRaw.mock.calls[1].slice(1)).toEqual([
      'pay1',
      'hash1',
      'pl1',
    ]);
  });

  it('returns a null firstTrackId when the playlist has no tracks', async () => {
    holder.prisma.$queryRaw
      .mockResolvedValueOnce([designRow])
      .mockResolvedValueOnce([]);

    const result = await designer.getCardDesign('pay1', 'hash1', 'pl1');
    expect(result.success).toBe(true);
    expect(result.data.firstTrackId).toBeNull();
  });

  it('fails without a second query when no design matches the ownership check', async () => {
    holder.prisma.$queryRaw.mockResolvedValueOnce([]);
    const result = await designer.getCardDesign('pay1', 'wrong-hash', 'pl1');
    expect(result).toEqual({ success: false, error: 'Card design not found' });
    expect(holder.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('converts query errors into a failure result', async () => {
    holder.prisma.$queryRaw.mockRejectedValueOnce(new Error('db gone'));
    const result = await designer.getCardDesign('pay1', 'hash1', 'pl1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('db gone');
  });
});

describe('updateCardDesign', () => {
  const design = {
    background: 'bg.png',
    qrColor: '#000000',
    doubleSided: true,
    eco: false,
    useFrontGradient: true,
    useGradient: undefined,
    frontOpacity: 80,
  } as any;

  it('refuses when no paid payment matches the user hash', async () => {
    holder.prisma.$queryRaw.mockResolvedValueOnce([]);

    const ok = await designer.updateCardDesign(
      'pay1',
      'hash1',
      'pl1',
      'physical',
      'none',
      design
    );

    expect(ok).toBe(false);
    expect(holder.prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([
      'pay1',
      'hash1',
    ]);
    expect(holder.prisma.playlist.findFirst).not.toHaveBeenCalled();
    expect(holder.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
  });

  it('refuses when the playlist does not exist', async () => {
    holder.prisma.$queryRaw.mockResolvedValueOnce([{ id: 7, status: 'paid' }]);
    holder.prisma.playlist.findFirst.mockResolvedValueOnce(null);

    const ok = await designer.updateCardDesign(
      'pay1',
      'hash1',
      'missing',
      'physical',
      'none',
      design
    );

    expect(ok).toBe(false);
    expect(holder.prisma.playlist.findFirst).toHaveBeenCalledWith({
      where: { playlistId: 'missing' },
      select: { id: true },
    });
    expect(holder.prisma.paymentHasPlaylist.update).not.toHaveBeenCalled();
  });

  it('updates the composite-keyed record with the mapped design payload', async () => {
    holder.prisma.$queryRaw.mockResolvedValueOnce([{ id: 7, status: 'paid' }]);
    holder.prisma.playlist.findFirst.mockResolvedValueOnce({ id: 31 });
    holder.prisma.paymentHasPlaylist.update.mockResolvedValueOnce({});

    const ok = await designer.updateCardDesign(
      'pay1',
      'hash1',
      'pl1',
      'digital',
      'sheets',
      design
    );

    expect(ok).toBe(true);
    expect(holder.prisma.paymentHasPlaylist.update).toHaveBeenCalledTimes(1);
    const arg = holder.prisma.paymentHasPlaylist.update.mock.calls[0][0];
    expect(arg.where).toEqual({
      paymentId_playlistId_type_subType: {
        paymentId: 7,
        playlistId: 31,
        type: 'digital',
        subType: 'sheets',
      },
    });
    expect(arg.data).toMatchObject({
      background: 'bg.png',
      qrColor: '#000000',
      doubleSided: true,
      eco: false,
      frontOpacity: 80,
      // Gradient flags are normalized through utils.parseBoolean.
      useFrontGradient: true,
      useGradient: false,
    });
    expect(holder.parseBoolean).toHaveBeenCalledWith(true);
    expect(holder.parseBoolean).toHaveBeenCalledWith(undefined);
  });

  it('returns false when the update throws', async () => {
    holder.prisma.$queryRaw.mockResolvedValueOnce([{ id: 7, status: 'paid' }]);
    holder.prisma.playlist.findFirst.mockResolvedValueOnce({ id: 31 });
    holder.prisma.paymentHasPlaylist.update.mockRejectedValueOnce(
      new Error('row missing')
    );

    const ok = await designer.updateCardDesign(
      'pay1',
      'hash1',
      'pl1',
      'physical',
      'none',
      design
    );
    expect(ok).toBe(false);
  });
});
