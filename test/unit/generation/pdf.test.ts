import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Pure unit tests for src/pdf.ts orchestration logic: Lambda invoke payload
 * construction, S3 upload/download/delete decisions, chunking math, retry
 * behavior, merge sequencing and post-processing (resize/bleed) branching.
 *
 * The actual rendering boundaries (Lambda, ConvertAPI, pdf-lib internals)
 * are fully mocked; we assert the commands and payload shapes sent to them.
 */

const holder = vi.hoisted(() => {
  const page = {
    getSize: () => ({ width: 100, height: 200 }),
    scaleContent: undefined as any,
    translateContent: undefined as any,
    setSize: undefined as any,
  };
  return {
    lambdaSend: undefined as any,
    s3Send: undefined as any,
    fsp: {
      readFile: undefined as any,
      writeFile: undefined as any,
      rename: undefined as any,
      access: undefined as any,
      unlink: undefined as any,
    },
    pdfLoad: undefined as any,
    page,
    doc: {
      getPage: () => page,
      getPageCount: () => 6,
      getPages: () => [page],
      save: undefined as any,
    },
    increaseCounter: undefined as any,
    convertapiConvert: undefined as any,
  };
});

vi.mock('@aws-sdk/client-lambda', () => {
  class InvokeCommand {
    constructor(public input: any) {}
  }
  class LambdaClient {
    send = (...args: any[]) => holder.lambdaSend(...args);
  }
  return { LambdaClient, InvokeCommand };
});

vi.mock('@aws-sdk/client-s3', () => {
  class GetObjectCommand {
    kind = 'get';
    constructor(public input: any) {}
  }
  class DeleteObjectCommand {
    kind = 'delete';
    constructor(public input: any) {}
  }
  class PutObjectCommand {
    kind = 'put';
    constructor(public input: any) {}
  }
  class S3Client {
    send = (...args: any[]) => holder.s3Send(...args);
  }
  return { S3Client, GetObjectCommand, DeleteObjectCommand, PutObjectCommand };
});

vi.mock('convertapi', () => ({
  default: class {
    convert = (...args: any[]) => holder.convertapiConvert(...args);
  },
}));

vi.mock('../../../src/analytics', () => ({
  default: {
    getInstance: () => ({
      increaseCounter: (...args: any[]) => holder.increaseCounter(...args),
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

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<any>();
  const promises = {
    readFile: (...args: any[]) => holder.fsp.readFile(...args),
    writeFile: (...args: any[]) => holder.fsp.writeFile(...args),
    rename: (...args: any[]) => holder.fsp.rename(...args),
    access: (...args: any[]) => holder.fsp.access(...args),
    unlink: (...args: any[]) => holder.fsp.unlink(...args),
  };
  return { ...actual, promises, default: { ...actual, promises } };
});

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: (...args: any[]) => holder.pdfLoad(...args),
  },
}));

import PDF from '../../../src/pdf';

const PUBLIC_DIR = process.env['PUBLIC_DIR'];
const API_URI = 'https://api.test';
process.env['API_URI'] = API_URI;
process.env['PDF_LAMBDA_FUNCTION'] = 'pdf-fn-test';
process.env['CONVERT_API_KEY'] = 'convertapi-test-key';

function lambdaResponse(obj: any) {
  return { Payload: Buffer.from(JSON.stringify(obj)) };
}

function invokePayload(callIndex: number): any {
  return JSON.parse(holder.lambdaSend.mock.calls[callIndex][0].input.Payload);
}

function s3Commands(kind: 'get' | 'delete' | 'put') {
  return holder.s3Send.mock.calls
    .map((c: any[]) => c[0])
    .filter((cmd: any) => cmd.kind === kind);
}

let chunkCounter = 0;

/** Default Lambda behavior: chunk renders return S3 keys, merges succeed. */
function installDefaultLambda() {
  holder.lambdaSend.mockImplementation(async (cmd: any) => {
    const payload = JSON.parse(cmd.input.Payload);
    if (payload.operation === 'merge') {
      return lambdaResponse({
        statusCode: 200,
        body: JSON.stringify({
          s3Bucket: 'merge-bucket',
          s3Key: 'merged/output.pdf',
          size: 4242,
          pageCount: 12,
        }),
      });
    }
    chunkCounter += 1;
    return lambdaResponse({
      statusCode: 200,
      body: JSON.stringify({
        s3Bucket: 'qrhit-lambda-deployments',
        s3Key: `chunks/chunk-${chunkCounter}.pdf`,
        size: 1000,
      }),
    });
  });
}

let pdf: PDF;
let resizeSpy: any;
let bleedSpy: any;

beforeEach(() => {
  chunkCounter = 0;
  holder.lambdaSend = vi.fn();
  holder.s3Send = vi.fn(async (cmd: any) => {
    if (cmd.kind === 'get') {
      return {
        Body: {
          transformToByteArray: async () =>
            new Uint8Array(Buffer.from(`S3:${cmd.input.Key}`)),
        },
      };
    }
    return {};
  });
  holder.fsp.readFile = vi.fn(async (p: string) => Buffer.from(`file:${p}`));
  holder.fsp.writeFile = vi.fn(async () => undefined);
  holder.fsp.rename = vi.fn(async () => undefined);
  holder.fsp.access = vi.fn(async () => undefined);
  holder.fsp.unlink = vi.fn(async () => undefined);
  holder.pdfLoad = vi.fn(async () => holder.doc);
  holder.doc.save = vi.fn(async () => new Uint8Array([1, 2, 3]));
  holder.page.scaleContent = vi.fn();
  holder.page.translateContent = vi.fn();
  holder.page.setSize = vi.fn();
  holder.increaseCounter = vi.fn();
  holder.convertapiConvert = vi.fn();

  pdf = new PDF();
  resizeSpy = vi
    .spyOn(pdf, 'resizePDFPages')
    .mockResolvedValue(undefined as any);
  bleedSpy = vi.spyOn(pdf, 'addBleed').mockResolvedValue(undefined as any);
});

afterEach(() => {
  vi.useRealTimers();
});

const playlist10 = { playlistId: 'pl1', numberOfTracks: 10 } as any;
const payment = { paymentId: 'pay1', vibe: false } as any;

describe('renderUrlToPdfBuffer (convertHtmlToPdf)', () => {
  it('invokes the configured Lambda with url + options and decodes a base64 body', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7 tiny');
    holder.lambdaSend.mockResolvedValueOnce(
      lambdaResponse({ statusCode: 200, body: pdfBytes.toString('base64') })
    );

    const result = await pdf.renderUrlToPdfBuffer('https://x.test/card', {
      format: 'a4',
    });

    expect(result.equals(pdfBytes)).toBe(true);
    const cmd = holder.lambdaSend.mock.calls[0][0];
    expect(cmd.input.FunctionName).toBe('pdf-fn-test');
    expect(JSON.parse(cmd.input.Payload)).toEqual({
      url: 'https://x.test/card',
      options: { format: 'a4' },
    });
    // No S3 traffic for small inline PDFs.
    expect(holder.s3Send).not.toHaveBeenCalled();
  });

  it('downloads from S3 and deletes the object when the body carries an s3Key', async () => {
    holder.lambdaSend.mockResolvedValueOnce(
      lambdaResponse({
        statusCode: 200,
        body: JSON.stringify({ s3Bucket: 'big-bucket', s3Key: 'big/one.pdf' }),
      })
    );

    const result = await pdf.renderUrlToPdfBuffer('https://x.test/big', {});

    expect(result.toString()).toBe('S3:big/one.pdf');
    expect(s3Commands('get')[0].input).toEqual({
      Bucket: 'big-bucket',
      Key: 'big/one.pdf',
    });
    expect(s3Commands('delete')[0].input).toEqual({
      Bucket: 'big-bucket',
      Key: 'big/one.pdf',
    });
  });

  it('still returns the buffer when the post-download S3 delete fails', async () => {
    holder.lambdaSend.mockResolvedValueOnce(
      lambdaResponse({
        statusCode: 200,
        body: JSON.stringify({ s3Bucket: 'b', s3Key: 'k.pdf' }),
      })
    );
    holder.s3Send.mockImplementation(async (cmd: any) => {
      if (cmd.kind === 'get') {
        return {
          Body: {
            transformToByteArray: async () => new Uint8Array([1, 2]),
          },
        };
      }
      throw new Error('delete denied');
    });

    const result = await pdf.renderUrlToPdfBuffer('https://x.test/big', {});
    expect(result.length).toBe(2);
  });

  it('throws on Lambda FunctionError with the error payload message', async () => {
    holder.lambdaSend.mockResolvedValueOnce({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify({ errorMessage: 'boom' })),
    });
    await expect(
      pdf.renderUrlToPdfBuffer('https://x.test', {})
    ).rejects.toThrow('Lambda error: boom');
  });

  it('throws when Lambda returns no payload', async () => {
    holder.lambdaSend.mockResolvedValueOnce({});
    await expect(
      pdf.renderUrlToPdfBuffer('https://x.test', {})
    ).rejects.toThrow('No payload returned from Lambda');
  });

  it('assembles all error detail fields on non-200 status', async () => {
    holder.lambdaSend.mockResolvedValueOnce(
      lambdaResponse({
        statusCode: 500,
        body: JSON.stringify({
          message: 'render failed',
          error: 'X',
          errorName: 'TypeError',
        }),
      })
    );
    await expect(
      pdf.renderUrlToPdfBuffer('https://x.test', {})
    ).rejects.toThrow(
      'PDF generation failed: render failed | Error: X | Type: TypeError'
    );
  });
});

describe('lambda function name selection', () => {
  const origEnv = process.env['ENVIRONMENT'];

  afterEach(() => {
    process.env['ENVIRONMENT'] = origEnv;
    process.env['PDF_LAMBDA_FUNCTION'] = 'pdf-fn-test';
  });

  async function functionNameFor(env: string): Promise<string> {
    delete process.env['PDF_LAMBDA_FUNCTION'];
    process.env['ENVIRONMENT'] = env;
    const instance = new PDF();
    holder.lambdaSend.mockResolvedValueOnce(
      lambdaResponse({ statusCode: 200, body: Buffer.from('x').toString('base64') })
    );
    await instance.renderUrlToPdfBuffer('https://x.test', {});
    return holder.lambdaSend.mock.calls.at(-1)[0].input.FunctionName;
  }

  it('uses the -dev function in development when no override is set', async () => {
    expect(await functionNameFor('development')).toBe('convertHTMLToPDF-dev');
  });

  it('uses the production function otherwise', async () => {
    expect(await functionNameFor('production')).toBe('convertHTMLToPDF');
  });
});

describe('generatePDF (Lambda path)', () => {
  beforeEach(() => {
    installDefaultLambda();
  });

  it('rejects playlists with zero tracks before invoking anything', async () => {
    await expect(
      pdf.generatePDF(
        'out.pdf',
        { playlistId: 'pl0', numberOfTracks: 0 } as any,
        payment,
        'digital',
        'sub',
        false,
        'printnbind'
      )
    ).rejects.toThrow('Cannot generate PDF: playlist has 0 tracks');
    expect(holder.lambdaSend).not.toHaveBeenCalled();
  });

  it('renders a digital playlist as a single A4 chunk and downloads it from S3', async () => {
    const result = await pdf.generatePDF(
      'out.pdf',
      playlist10,
      payment,
      'digital',
      'sub',
      false,
      'printnbind'
    );

    expect(result).toBe('out.pdf');
    expect(holder.lambdaSend).toHaveBeenCalledTimes(1);
    const payload = invokePayload(0);
    // 10 tracks, 6 per page -> 2 pages, single chunk covering tracks 0..9.
    expect(payload.url).toBe(
      `${API_URI}/qr/pdf/pl1/pay1/digital/0/9/sub/0/0/0`
    );
    expect(payload.options).toEqual({
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      format: 'a4',
    });

    // Single chunk: direct S3 download + delete, no merge invoke.
    expect(s3Commands('get')[0].input).toEqual({
      Bucket: 'qrhit-lambda-deployments',
      Key: 'chunks/chunk-1.pdf',
    });
    expect(s3Commands('delete')[0].input.Key).toBe('chunks/chunk-1.pdf');
    expect(holder.fsp.writeFile).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/pdf/out.pdf`,
      expect.any(Buffer)
    );
    expect(holder.increaseCounter).toHaveBeenCalledWith('pdf', 'generated', 1);
    expect(holder.increaseCounter).not.toHaveBeenCalledWith('pdf', 'merged', 1);
    // Digital cards get no resize or bleed.
    expect(resizeSpy).not.toHaveBeenCalled();
    expect(bleedSpy).not.toHaveBeenCalled();
  });

  it('uses US Letter format for _us digital templates', async () => {
    await pdf.generatePDF(
      'us.pdf',
      playlist10,
      payment,
      'digital_us',
      'sub',
      false,
      'printnbind'
    );
    expect(invokePayload(0).options.format).toBe('letter');
  });

  it('encodes eco and itemIndex flags into the render URL', async () => {
    await pdf.generatePDF(
      'eco.pdf',
      playlist10,
      payment,
      'digital',
      'subdir2',
      true,
      'printnbind',
      2
    );
    expect(invokePayload(0).url).toBe(
      `${API_URI}/qr/pdf/pl1/pay1/digital/0/9/subdir2/1/0/2`
    );
  });

  it('renders printer templates at 60x60 and applies resize + bleed', async () => {
    const playlist = { playlistId: 'pl1', numberOfTracks: 4 } as any;
    await pdf.generatePDF(
      'p.pdf',
      playlist,
      payment,
      'printnbind',
      'sub',
      false,
      'printnbind'
    );

    const payload = invokePayload(0);
    // 4 tracks, front/back -> 8 pages, single chunk covering tracks 0..3.
    expect(payload.url).toBe(`${API_URI}/qr/pdf/pl1/pay1/printnbind/0/3/sub/0/0/0`);
    expect(payload.options.width).toBe(60);
    expect(payload.options.height).toBe(60);
    expect(payload.options.format).toBeUndefined();

    expect(resizeSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/p.pdf`, 60, 60);
    expect(bleedSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/p.pdf`, 3);
  });

  it('uses 56mm pages for the schneiders printer template', async () => {
    const playlist = { playlistId: 'pl1', numberOfTracks: 4 } as any;
    await pdf.generatePDF(
      's.pdf',
      playlist,
      payment,
      'schneiders',
      'sub',
      false,
      'schneiders'
    );
    expect(invokePayload(0).options.width).toBe(56);
    expect(resizeSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/s.pdf`, 56, 56);
    expect(bleedSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/s.pdf`, 3);
  });

  it('resizes vibe orders to 62x62 without bleed', async () => {
    const playlist = { playlistId: 'pl1', numberOfTracks: 4 } as any;
    await pdf.generatePDF(
      'v.pdf',
      playlist,
      { paymentId: 'pay1', vibe: true } as any,
      'printnbind',
      'sub',
      false,
      'printnbind'
    );
    expect(resizeSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/v.pdf`, 62, 62);
    expect(bleedSpy).not.toHaveBeenCalled();
  });

  it('resizes printer_sheets output to A4 dimensions', async () => {
    await pdf.generatePDF(
      'sheets.pdf',
      playlist10,
      payment,
      'printer_sheets',
      'sub',
      false,
      'printnbind'
    );
    expect(invokePayload(0).options.format).toBe('a4');
    expect(resizeSpy).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/pdf/sheets.pdf`,
      210,
      297
    );
    expect(bleedSpy).not.toHaveBeenCalled();
  });

  it('splits large digital playlists into chunks and merges them in order', async () => {
    const bigPlaylist = { playlistId: 'plBig', numberOfTracks: 1000 } as any;
    await pdf.generatePDF(
      'big.pdf',
      bigPlaylist,
      payment,
      'digital',
      'sub',
      false,
      'printnbind'
    );

    // 1000 tracks / 6 per page = 167 pages -> 2 chunks of <=100 pages.
    expect(holder.lambdaSend).toHaveBeenCalledTimes(3); // 2 chunks + merge
    expect(invokePayload(0).url).toBe(
      `${API_URI}/qr/pdf/plBig/pay1/digital/0/599/sub/0/0/0`
    );
    expect(invokePayload(1).url).toBe(
      `${API_URI}/qr/pdf/plBig/pay1/digital/600/999/sub/0/0/0`
    );
    expect(invokePayload(2)).toEqual({
      operation: 'merge',
      s3Keys: ['chunks/chunk-1.pdf', 'chunks/chunk-2.pdf'],
      deleteAfterMerge: true,
    });

    // The merged result is downloaded from the merge bucket and removed.
    expect(s3Commands('get')[0].input).toEqual({
      Bucket: 'merge-bucket',
      Key: 'merged/output.pdf',
    });
    expect(s3Commands('delete')[0].input.Key).toBe('merged/output.pdf');
    expect(holder.fsp.writeFile).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/pdf/big.pdf`,
      expect.any(Buffer)
    );
    expect(holder.increaseCounter).toHaveBeenCalledWith('pdf', 'generated', 1);
    expect(holder.increaseCounter).toHaveBeenCalledWith('pdf', 'merged', 1);
  });

  it('adds two how-to pages for printer templates, which can push into a second chunk', async () => {
    // 50 tracks * 2 pages = exactly 100 pages (one chunk). The how-to card
    // adds 2 pages, forcing a second chunk whose track range is empty (50..49).
    const playlist = { playlistId: 'plH', numberOfTracks: 50 } as any;
    await pdf.generatePDF(
      'howto.pdf',
      playlist,
      payment,
      'printnbind',
      'sub',
      false,
      'printnbind',
      undefined,
      true
    );

    expect(holder.lambdaSend).toHaveBeenCalledTimes(3); // 2 chunks + merge
    expect(invokePayload(0).url).toBe(
      `${API_URI}/qr/pdf/plH/pay1/printnbind/0/49/sub/0/0/0`
    );
    expect(invokePayload(1).url).toBe(
      `${API_URI}/qr/pdf/plH/pay1/printnbind/50/49/sub/0/0/0`
    );
    expect(invokePayload(2).operation).toBe('merge');
  });

  it('retries a failed chunk render before succeeding', async () => {
    vi.useFakeTimers();
    holder.lambdaSend.mockRejectedValueOnce(new Error('cold start'));

    const promise = pdf.generatePDF(
      'retry.pdf',
      playlist10,
      payment,
      'digital',
      'sub',
      false,
      'printnbind'
    );
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    const result = await promise;

    expect(result).toBe('retry.pdf');
    expect(holder.lambdaSend).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts and cleans up already-rendered chunks', async () => {
    vi.useFakeTimers();
    const bigPlaylist = { playlistId: 'plBig', numberOfTracks: 1000 } as any;

    // First chunk succeeds, every later render attempt fails.
    let calls = 0;
    holder.lambdaSend.mockImplementation(async (cmd: any) => {
      calls++;
      if (calls === 1) {
        return lambdaResponse({
          statusCode: 200,
          body: JSON.stringify({
            s3Bucket: 'qrhit-lambda-deployments',
            s3Key: 'chunks/first.pdf',
            size: 1,
          }),
        });
      }
      throw new Error('lambda down');
    });

    const promise = pdf
      .generatePDF('fail.pdf', bigPlaylist, payment, 'digital', 'sub', false, 'printnbind')
      .catch((e: Error) => e);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('lambda down');
    // 1 success + 3 attempts for the failing chunk.
    expect(holder.lambdaSend).toHaveBeenCalledTimes(4);
    // The successful chunk is cleaned up from S3.
    const deletes = s3Commands('delete').map((c: any) => c.input.Key);
    expect(deletes).toContain('chunks/first.pdf');
    expect(holder.fsp.writeFile).not.toHaveBeenCalled();
  });
});

describe('generateGiftcardPDF', () => {
  function smallPdfOnce(content = 'GIFT') {
    holder.lambdaSend.mockResolvedValueOnce(
      lambdaResponse({
        statusCode: 200,
        body: Buffer.from(content).toString('base64'),
      })
    );
  }

  const discount = { code: 'CODE10' } as any;

  it('renders a single A4 page for digital vouchers', async () => {
    smallPdfOnce();
    const result = await pdf.generateGiftcardPDF(
      'gift.pdf',
      playlist10,
      discount,
      payment,
      'digital',
      'sub'
    );

    expect(result).toBe('gift.pdf');
    const payload = invokePayload(0);
    expect(payload.url).toBe(`${API_URI}/discount/voucher/digital/CODE10/pay1`);
    expect(payload.options).toEqual({
      format: 'a4',
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      pageRanges: '1',
    });
    expect(holder.fsp.writeFile).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/pdf/gift.pdf`,
      expect.any(Buffer)
    );
    expect(resizeSpy).not.toHaveBeenCalled();
    expect(bleedSpy).not.toHaveBeenCalled();
  });

  it('renders A5 front/back with resize and bleed for printer vouchers', async () => {
    smallPdfOnce();
    await pdf.generateGiftcardPDF(
      'giftp.pdf',
      playlist10,
      discount,
      payment,
      'printer',
      'sub'
    );

    const payload = invokePayload(0);
    expect(payload.options.format).toBe('a5');
    expect(payload.options.pageRanges).toBe('1-2');
    expect(resizeSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/giftp.pdf`, 210, 148);
    expect(bleedSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/giftp.pdf`, 3);
  });
});

describe('generateFromUrl / generatePdfFromUrl option mapping', () => {
  function smallPdfOnce(content = 'DOC') {
    holder.lambdaSend.mockResolvedValueOnce(
      lambdaResponse({
        statusCode: 200,
        body: Buffer.from(content).toString('base64'),
      })
    );
  }

  it('generateFromUrl defaults to a4 with zero margins and writes the file', async () => {
    smallPdfOnce();
    await pdf.generateFromUrl('https://x.test/invoice', '/tmp/inv.pdf');

    expect(invokePayload(0).options).toEqual({
      format: 'a4',
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
    });
    expect(holder.fsp.writeFile).toHaveBeenCalledWith(
      '/tmp/inv.pdf',
      expect.any(Buffer)
    );
  });

  it('generateFromUrl drops format when explicit width/height are given', async () => {
    smallPdfOnce();
    await pdf.generateFromUrl('https://x.test/q', '/tmp/q.pdf', {
      format: 'letter',
      width: 60,
      height: 60,
      pageRanges: '1',
      marginTop: 5,
    });

    const options = invokePayload(0).options;
    expect(options.format).toBeUndefined();
    expect(options.width).toBe(60);
    expect(options.height).toBe(60);
    expect(options.pageRanges).toBe('1');
    expect(options.marginTop).toBe(5);
  });

  it('generatePdfFromUrl returns the buffer and defaults preferCSSPageSize to false', async () => {
    smallPdfOnce('BINGO');
    const buf = await pdf.generatePdfFromUrl('https://x.test/bingo');

    expect(buf.toString()).toBe('BINGO');
    expect(invokePayload(0).options).toEqual({
      format: 'a4',
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      preferCSSPageSize: false,
    });
    expect(holder.fsp.writeFile).not.toHaveBeenCalled();
  });

  it('generatePdfFromUrl honors width/height and preferCSSPageSize', async () => {
    smallPdfOnce();
    await pdf.generatePdfFromUrl('https://x.test/bingo', {
      width: 100,
      height: 150,
      preferCSSPageSize: true,
    });
    const options = invokePayload(0).options;
    expect(options.format).toBeUndefined();
    expect(options.width).toBe(100);
    expect(options.height).toBe(150);
    expect(options.preferCSSPageSize).toBe(true);
  });
});

describe('mergeLocalPdfs', () => {
  beforeEach(() => {
    installDefaultLambda();
  });

  it('rejects an empty input list', async () => {
    await expect(pdf.mergeLocalPdfs([], '/tmp/out.pdf')).rejects.toThrow(
      'mergeLocalPdfs requires at least one input'
    );
  });

  it('uploads each repetition as its own key, merges in order and reports the page count', async () => {
    const pages = await pdf.mergeLocalPdfs(
      [
        { localPath: '/tmp/a.pdf', repeat: 2 },
        { localPath: '/tmp/b.pdf', repeat: 1 },
      ],
      '/tmp/merged.pdf',
      'insert card'
    );

    // 3 uploads with sequential, unique keys.
    const puts = s3Commands('put');
    expect(puts).toHaveLength(3);
    const keys = puts.map((c: any) => c.input.Key);
    expect(keys[0]).toMatch(/^pdf-merge-tmp\/[0-9a-f-]+-0000\.pdf$/);
    expect(keys[1]).toMatch(/-0001\.pdf$/);
    expect(keys[2]).toMatch(/-0002\.pdf$/);
    // First two repetitions read from a.pdf, third from b.pdf.
    expect(puts[0].input.Body.toString()).toBe('file:/tmp/a.pdf');
    expect(puts[1].input.Body.toString()).toBe('file:/tmp/a.pdf');
    expect(puts[2].input.Body.toString()).toBe('file:/tmp/b.pdf');
    expect(puts[0].input.Bucket).toBe('qrhit-lambda-deployments');
    expect(puts[0].input.ContentType).toBe('application/pdf');

    // Merge invoked with the same keys, in order.
    const mergePayload = invokePayload(0);
    expect(mergePayload).toEqual({
      operation: 'merge',
      s3Keys: keys,
      deleteAfterMerge: true,
    });

    // Result written locally; page count from the merged PDF (mock doc: 6).
    expect(holder.fsp.writeFile).toHaveBeenCalledWith(
      '/tmp/merged.pdf',
      expect.any(Buffer)
    );
    expect(pages).toBe(6);
  });

  it('clamps repeat values below 1 to a single upload', async () => {
    await pdf.mergeLocalPdfs(
      [{ localPath: '/tmp/a.pdf', repeat: 0 }],
      '/tmp/one.pdf'
    );
    expect(s3Commands('put')).toHaveLength(1);
  });

  it('cleans up uploaded keys and rethrows when an upload fails', async () => {
    holder.s3Send.mockImplementation(async (cmd: any) => {
      if (cmd.kind === 'put') throw new Error('upload refused');
      return {};
    });

    await expect(
      pdf.mergeLocalPdfs(
        [{ localPath: '/tmp/a.pdf', repeat: 2 }],
        '/tmp/out.pdf'
      )
    ).rejects.toThrow('upload refused');

    const deleteKeys = s3Commands('delete').map((c: any) => c.input.Key);
    expect(deleteKeys).toHaveLength(2);
    expect(deleteKeys.every((k: string) => k.startsWith('pdf-merge-tmp/'))).toBe(
      true
    );
    expect(holder.lambdaSend).not.toHaveBeenCalled();
  });

  it('cleans up all keys and rethrows when the Lambda merge fails', async () => {
    holder.lambdaSend.mockResolvedValue(
      lambdaResponse({
        statusCode: 500,
        body: JSON.stringify({ message: 'merge exploded' }),
      })
    );

    await expect(
      pdf.mergeLocalPdfs(
        [{ localPath: '/tmp/a.pdf', repeat: 2 }],
        '/tmp/out.pdf'
      )
    ).rejects.toThrow('PDF merge failed: merge exploded');

    expect(s3Commands('delete')).toHaveLength(2);
    expect(holder.fsp.writeFile).not.toHaveBeenCalled();
  });
});

describe('pdf-lib backed helpers', () => {
  it('getPageDimensions converts the first page from points to millimeters', async () => {
    // Mock page is 100x200pt; 1pt = 0.352778mm.
    const dims = await pdf.getPageDimensions('/tmp/some.pdf');
    expect(dims.width).toBeCloseTo(35.2778, 4);
    expect(dims.height).toBeCloseTo(70.5556, 4);
    expect(holder.fsp.readFile).toHaveBeenCalledWith('/tmp/some.pdf');
  });

  it('countPDFPages returns the document page count', async () => {
    expect(await pdf.countPDFPages('/tmp/some.pdf')).toBe(6);
  });

  it('addBleed scales content into the bleed area and grows the page size', async () => {
    const fresh = new PDF();
    await fresh.addBleed('/tmp/bleed.pdf', 3);

    // 3mm = 8.50394pt of bleed on every side.
    const bleedPts = 3 * (72 / 25.4);
    const newWidth = 100 + 2 * bleedPts;
    const newHeight = 200 + 2 * bleedPts;

    const [scaleX, scaleY] = (holder.page.scaleContent as any).mock.calls[0];
    expect(scaleX).toBeCloseTo(newWidth / 100, 6);
    expect(scaleY).toBeCloseTo(newHeight / 200, 6);
    // Scaling already fills the new size exactly, so translation is 0/0.
    expect((holder.page.translateContent as any).mock.calls[0][0]).toBeCloseTo(0, 6);
    expect((holder.page.translateContent as any).mock.calls[0][1]).toBeCloseTo(0, 6);
    const [w, h] = (holder.page.setSize as any).mock.calls[0];
    expect(w).toBeCloseTo(newWidth, 4);
    expect(h).toBeCloseTo(newHeight, 4);

    // The modified document is written back to the same path.
    expect(holder.fsp.writeFile).toHaveBeenCalledWith(
      '/tmp/bleed.pdf',
      expect.anything()
    );
  });

  it('resizePDFPages scales content to the requested millimeter size', async () => {
    const fresh = new PDF();
    await fresh.resizePDFPages('/tmp/resize.pdf', 66, 66);

    const widthPts = 66 * 2.83465;
    const [scaleX, scaleY] = (holder.page.scaleContent as any).mock.calls[0];
    expect(scaleX).toBeCloseTo(widthPts / 100, 6);
    expect(scaleY).toBeCloseTo(widthPts / 200, 6);
    const [w, h] = (holder.page.setSize as any).mock.calls[0];
    expect(w).toBeCloseTo(widthPts, 4);
    expect(h).toBeCloseTo(widthPts, 4);
    expect(holder.fsp.writeFile).toHaveBeenCalledWith(
      '/tmp/resize.pdf',
      expect.anything()
    );
  });
});

describe('generatePDFViaConvertApi (legacy fallback, called directly)', () => {
  // generatePDF() hard-codes useLambda=true, so this provider is currently
  // unreachable from the public API; it is still exercised here because it
  // remains the documented ConvertAPI fallback.
  function installConvertApi() {
    holder.convertapiConvert.mockImplementation(async () => ({
      saveFiles: vi.fn(async () => undefined),
    }));
  }

  it('renders a digital playlist as one A4 chunk and renames instead of merging', async () => {
    installConvertApi();
    const result = await (pdf as any).generatePDFViaConvertApi(
      'ca.pdf',
      playlist10,
      payment,
      'digital',
      'sub',
      false,
      'printnbind'
    );

    expect(result).toBe('ca.pdf');
    expect(holder.convertapiConvert).toHaveBeenCalledTimes(1);
    const [target, options, source] = holder.convertapiConvert.mock.calls[0];
    expect(target).toBe('pdf');
    expect(source).toBe('htm');
    expect(options.File).toBe(`${API_URI}/qr/pdf/pl1/pay1/digital/0/9/sub/0/0/0`);
    expect(options.PageSize).toBe('a4');
    expect(options.PageWidth).toBeUndefined();

    // Single chunk: temp file renamed to the final path, nothing merged.
    expect(holder.fsp.rename).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/pdf/temp_0_ca.pdf`,
      `${PUBLIC_DIR}/pdf/ca.pdf`
    );
    expect(holder.fsp.unlink).not.toHaveBeenCalled();
    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it('uses US Letter page dimensions for _us digital templates', async () => {
    installConvertApi();
    await (pdf as any).generatePDFViaConvertApi(
      'us.pdf',
      playlist10,
      payment,
      'digital_us',
      'sub',
      false,
      'printnbind'
    );
    const options = holder.convertapiConvert.mock.calls[0][1];
    expect(options.PageWidth).toBe(215.9);
    expect(options.PageHeight).toBe(279.4);
    expect(options.PageSize).toBeUndefined();
  });

  it('applies printer page size, resize and bleed for printer templates', async () => {
    installConvertApi();
    await (pdf as any).generatePDFViaConvertApi(
      'pr.pdf',
      { playlistId: 'pl1', numberOfTracks: 4 } as any,
      payment,
      'schneiders',
      'sub',
      false,
      'schneiders'
    );
    const options = holder.convertapiConvert.mock.calls[0][1];
    expect(options.PageWidth).toBe(56);
    expect(options.PageHeight).toBe(56);
    expect(resizeSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/pr.pdf`, 56, 56);
    expect(bleedSpy).toHaveBeenCalledWith(`${PUBLIC_DIR}/pdf/pr.pdf`, 3);
  });

  it('merges multiple chunks via ConvertAPI and deletes the temp files', async () => {
    installConvertApi();
    const bigPlaylist = { playlistId: 'plBig', numberOfTracks: 1000 } as any;
    await (pdf as any).generatePDFViaConvertApi(
      'big.pdf',
      bigPlaylist,
      payment,
      'digital',
      'sub',
      false,
      'printnbind'
    );

    // 167 pages -> 2 render calls + 1 merge call.
    expect(holder.convertapiConvert).toHaveBeenCalledTimes(3);
    const mergeCall = holder.convertapiConvert.mock.calls[2];
    expect(mergeCall[0]).toBe('merge');
    expect(mergeCall[1].Files).toEqual([
      `${PUBLIC_DIR}/pdf/temp_0_big.pdf`,
      `${PUBLIC_DIR}/pdf/temp_100_big.pdf`,
    ]);
    expect(mergeCall[2]).toBe('pdf');

    // Temp chunks removed after the merge.
    expect(holder.fsp.unlink).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/pdf/temp_0_big.pdf`
    );
    expect(holder.fsp.unlink).toHaveBeenCalledWith(
      `${PUBLIC_DIR}/pdf/temp_100_big.pdf`
    );
    expect(holder.increaseCounter).toHaveBeenCalledWith('pdf', 'merged', 1);
  });
});
