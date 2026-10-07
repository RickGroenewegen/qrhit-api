import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { promises as fs } from 'fs';

// In-memory stand-in for the Redis-backed cache (unit tests: no Redis).
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
      },
    }),
  },
}));

// The model itself is tested in hitster-detector.test.ts; here it answers
// what a test tells it to.
const detector = vi.hoisted(() => ({
  detect: vi.fn(),
  modelPath: vi.fn(),
}));
vi.mock('../../src/hitsterDetector', () => ({
  default: { getInstance: () => detector },
}));

import DesignScreen, { designScreenMode } from '../../src/designScreen';
import { hitsterHoldThreshold, hitsterThreshold } from '../../src/hitsterThresholds';

const screen = DesignScreen.getInstance();
const JPEG = `data:image/jpeg;base64,${Buffer.from('a picture').toString('base64')}`;
const CLEAN = { scores: { word: 0.1, rings: 0.02, speaker: 0.01, pill: 0.01 }, marks: [] };
const FLAGGED = {
  scores: { word: 0.93, rings: 0.02, speaker: 0.01, pill: 0.01 },
  marks: [{ class: 'word', score: 0.93, box: { x: 10, y: 20, width: 300, height: 80 } }],
};

describe('DesignScreen', () => {
  const env = { ...process.env };
  let modelFile: string;

  beforeEach(async () => {
    store.clear();
    detector.detect.mockReset();
    modelFile = path.join(process.env['ASSETS_DIR']!, 'design-screen-test.onnx');
    await fs.writeFile(modelFile, 'model');
    detector.modelPath.mockReturnValue(modelFile);
    process.env['DESIGN_SCREEN_MODE'] = 'warn';
    process.env['ENVIRONMENT'] = 'development';
    delete process.env['HITSTER_THRESHOLD'];
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('reads the mode and threshold from the environment, with safe defaults', () => {
    delete process.env['DESIGN_SCREEN_MODE'];
    expect(designScreenMode()).toBe('warn');
    process.env['DESIGN_SCREEN_MODE'] = 'BLOCK';
    expect(designScreenMode()).toBe('block');
    process.env['DESIGN_SCREEN_MODE'] = 'nonsense';
    expect(designScreenMode()).toBe('warn');
    expect(hitsterThreshold()).toBe(0.5);
    process.env['HITSTER_THRESHOLD'] = '0.35';
    expect(hitsterThreshold()).toBe(0.35);
    process.env['HITSTER_THRESHOLD'] = '7';
    expect(hitsterThreshold()).toBe(0.5);
    // finalCheck holds an order from a higher score than the designer warns at
    delete process.env['HITSTER_HOLD_THRESHOLD'];
    expect(hitsterHoldThreshold()).toBe(0.7);
    process.env['HITSTER_HOLD_THRESHOLD'] = '0.85';
    expect(hitsterHoldThreshold()).toBe(0.85);
  });

  it('screens nothing when the mode is off', async () => {
    process.env['DESIGN_SCREEN_MODE'] = 'off';
    expect(await screen.screen({ image: JPEG }, '1.2.3.4')).toEqual({ status: 'unchecked', mode: 'off' });
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it('has no opinion on input it cannot read', async () => {
    for (const input of [{}, { image: 'data:text/html;base64,AAAA' }, { image: 'x'.repeat(1_000_001) }, { type: 'logo', filename: '../../etc/passwd' }, { type: 'pdf', filename: 'abcdefgh12.png' }]) {
      expect((await screen.screen(input, '1.2.3.4')).status).toBe('unchecked');
    }
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it('flags a Hitster picture, says what and where, and remembers it', async () => {
    detector.detect.mockResolvedValue(FLAGGED);
    const answer = await screen.screen({ image: JPEG }, '1.2.3.4');
    expect(answer).toEqual({ status: 'flagged', mode: 'warn', marks: [{ class: 'word', box: { x: 10, y: 20, width: 300, height: 80 } }] });
    expect(detector.detect).toHaveBeenCalledWith(Buffer.from('a picture'), 0.5);

    // The same picture again: from the cache, with the mode of now
    process.env['DESIGN_SCREEN_MODE'] = 'block';
    expect(await screen.screen({ image: JPEG }, '5.6.7.8')).toEqual({ ...answer, mode: 'block' });
    expect(detector.detect).toHaveBeenCalledTimes(1);
  });

  it('passes a clean picture', async () => {
    detector.detect.mockResolvedValue(CLEAN);
    expect(await screen.screen({ image: JPEG }, '1.2.3.4')).toEqual({ status: 'clean', mode: 'warn' });
  });

  it('screens an upload already stored, by its name', async () => {
    detector.detect.mockResolvedValue(CLEAN);
    await fs.mkdir(path.join(process.env['PUBLIC_DIR']!, 'logo'), { recursive: true });
    await fs.writeFile(path.join(process.env['PUBLIC_DIR']!, 'logo', 'abcdefgh12.png'), 'stored');
    expect((await screen.screen({ type: 'logo', filename: 'abcdefgh12.png' }, '1.2.3.4')).status).toBe('clean');
    expect(detector.detect).toHaveBeenCalledWith(Buffer.from('stored'), 0.5);
    expect((await screen.screen({ type: 'logo', filename: 'missing123.png' }, '1.2.3.4')).status).toBe('unchecked');
  });

  it('has no opinion when the model fails', async () => {
    detector.detect.mockRejectedValue(new Error('model missing'));
    expect(await screen.screen({ image: JPEG }, '1.2.3.4')).toEqual({ status: 'unchecked', mode: 'warn' });
  });

  it('asks the model again after a new model is installed', async () => {
    detector.detect.mockResolvedValue(CLEAN);
    await screen.screen({ image: JPEG }, '1.2.3.4');
    // A new screen instance reads the stamp afresh, as a restarted worker would
    const fresh = new (DesignScreen as any)();
    await fs.writeFile(modelFile, 'a bigger model');
    await fresh.screen({ image: JPEG }, '1.2.3.4');
    expect(detector.detect).toHaveBeenCalledTimes(2);
  });

  it('stops an address at its daily cap', async () => {
    process.env['ENVIRONMENT'] = 'production';
    process.env['TRUSTED_IPS'] = '';
    detector.detect.mockResolvedValue(CLEAN);
    const today = new Date().toISOString().slice(0, 10);
    store.set(`designscreen:ip:9.9.9.9:${today}`, '400');
    expect((await screen.screen({ image: JPEG }, '9.9.9.9')).status).toBe('unchecked');
    expect((await screen.screen({ image: JPEG }, '8.8.8.8')).status).toBe('clean');
  });
});
