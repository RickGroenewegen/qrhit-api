import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

const { lambdaSend, invokeInputs } = vi.hoisted(() => ({
  lambdaSend: vi.fn(),
  invokeInputs: [] as any[],
}));

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    send = lambdaSend;
  }
  class InvokeCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
      invokeInputs.push(input);
    }
  }
  return { LambdaClient, InvokeCommand };
});

import Qr from '../../src/qr';

const OUT_DIR = path.resolve('test/.tmp/public/qr-tests');

function lambdaResponse(payload: any) {
  return { Payload: new TextEncoder().encode(JSON.stringify(payload)) };
}

describe('Qr.generateQR', () => {
  beforeEach(async () => {
    await fs.mkdir(OUT_DIR, { recursive: true });
  });

  it('writes a non-empty PNG QR code file', async () => {
    const out = path.join(OUT_DIR, 'test.png');
    await new Qr().generateQR('https://qrsong.io/qrlink/abc', out);
    const buf = await fs.readFile(out);
    expect(buf.length).toBeGreaterThan(100);
    // PNG magic bytes
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
  });

  it('writes an SVG when type=svg, using the given dark color', async () => {
    const out = path.join(OUT_DIR, 'test.svg');
    await new Qr().generateQR('https://qrsong.io/qrlink/abc', out, '#ff0000', 'svg');
    const svg = await fs.readFile(out, 'utf-8');
    expect(svg).toContain('<svg');
    expect(svg.toLowerCase()).toContain('#ff0000');
  });
});

describe('Qr.generateQRLambda', () => {
  beforeEach(() => {
    lambdaSend.mockReset();
    invokeInputs.length = 0;
  });

  it('invokes the Lambda with the qr action payload and defaults the color', async () => {
    lambdaSend.mockResolvedValue(lambdaResponse({ statusCode: 200 }));
    const qr = new Qr();
    const fallback = vi.spyOn(qr, 'generateQR').mockResolvedValue(undefined);

    await qr.generateQRLambda('https://qrsong.io/qrlink/x', '/tmp/out.png', '');

    expect(lambdaSend).toHaveBeenCalledTimes(1);
    expect(invokeInputs[0].FunctionName).toBe(
      'arn:aws:lambda:eu-west-1:071455255929:function:qrLambda'
    );
    const params = JSON.parse(new TextDecoder().decode(invokeInputs[0].Payload));
    expect(params).toEqual({
      action: 'qr',
      url: 'https://qrsong.io/qrlink/x',
      outputPath: '/tmp/out.png',
      qrColor: '#000000', // falsy color falls back to black
    });
    // Success: no local fallback
    expect(fallback).not.toHaveBeenCalled();
  });

  it('passes a custom qr color through to the Lambda payload', async () => {
    lambdaSend.mockResolvedValue(lambdaResponse({ statusCode: 200 }));
    await new Qr().generateQRLambda('link', 'out.png', '#123456');
    const params = JSON.parse(new TextDecoder().decode(invokeInputs[0].Payload));
    expect(params.qrColor).toBe('#123456');
  });

  it('falls back to local generation when the Lambda reports a 500', async () => {
    lambdaSend.mockResolvedValue(
      lambdaResponse({
        statusCode: 500,
        body: JSON.stringify({ error: 'lambda exploded' }),
      })
    );
    const qr = new Qr();
    const fallback = vi.spyOn(qr, 'generateQR').mockResolvedValue(undefined);

    await qr.generateQRLambda('https://qrsong.io/qrlink/y', '/tmp/y.png', '#000000');

    expect(fallback).toHaveBeenCalledWith('https://qrsong.io/qrlink/y', '/tmp/y.png');
  });

  it('swallows Lambda invocation errors (logs, does not throw)', async () => {
    lambdaSend.mockRejectedValue(new Error('network down'));
    const qr = new Qr();
    const fallback = vi.spyOn(qr, 'generateQR').mockResolvedValue(undefined);

    await expect(
      qr.generateQRLambda('link', 'out.png', '#000000')
    ).resolves.toBeUndefined();
    // No fallback on transport errors - only on explicit Lambda 500s
    expect(fallback).not.toHaveBeenCalled();
  });
});
