import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/audio.ts (AudioClient).
 *
 * Mocks:
 *  - openai      → stub for audio.speech.create
 *  - fs/promises → stub mkdir + writeFile
 *  - src/utils   → generateRandomString returns fixed value
 *  - src/logger  → no-op
 *
 * AudioClient goes through the LLM layer, which reports a missing
 * OPENAI_API_KEY when a call is made. We set it before import.
 */

process.env['OPENAI_API_KEY'] = 'sk-test-key';
process.env['PRIVATE_DIR'] = '/tmp/qrhit-audio-test';

const speechCreate = vi.hoisted(() => vi.fn());
const mkdirSpy = vi.hoisted(() => vi.fn(async () => undefined));
const writeFileSpy = vi.hoisted(() => vi.fn(async () => undefined));
const generateRandomStringSpy = vi.hoisted(() => vi.fn(() => 'rand123'));

vi.mock('openai', () => ({
  default: class {
    audio = {
      speech: {
        create: speechCreate,
      },
    };
    // APIError shape used in catch block
    static APIError = class extends Error {
      status: number;
      code: string | null;
      type: string;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
        this.code = null;
        this.type = 'api_error';
      }
    };
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mkdirSpy,
    writeFile: writeFileSpy,
  },
  mkdir: mkdirSpy,
  writeFile: writeFileSpy,
}));

vi.mock('../../src/utils', () => ({
  default: class {
    generateRandomString = generateRandomStringSpy;
  },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

import AudioClient from '../../src/audio';
import { LlmUnavailableError } from '../../src/llm/errors';

// Reset the singleton so each test starts fresh
beforeEach(() => {
  vi.clearAllMocks();
  (AudioClient as any).instance = undefined;
});

// ──────────────────────────────────────────────
// Singleton behaviour
// ──────────────────────────────────────────────

describe('AudioClient singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const a = AudioClient.getInstance();
    const b = AudioClient.getInstance();
    expect(a).toBe(b);
  });
});

// ──────────────────────────────────────────────
// generateAudio – happy path
// ──────────────────────────────────────────────

describe('AudioClient.generateAudio – happy path', () => {
  beforeEach(() => {
    const fakeBuffer = Buffer.from('mp3-data');
    speechCreate.mockResolvedValueOnce({
      arrayBuffer: async () => fakeBuffer.buffer,
    });
  });

  it('returns the full path to the generated file', async () => {
    const client = AudioClient.getInstance();
    const result = await client.generateAudio('Hello world');
    expect(result).toContain('rand123.mp3');
    expect(result).toContain('/tmp/qrhit-audio-test/audio/');
  });

  it('calls OpenAI with the correct model, voice, and input', async () => {
    const client = AudioClient.getInstance();
    await client.generateAudio('Test text', 'Speak slowly');
    expect(speechCreate.mock.calls[0][0]).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'ash',
      input: 'Test text',
      instructions: 'Speak slowly',
    });
  });

  it('uses empty string for instructions when not provided', async () => {
    const client = AudioClient.getInstance();
    await client.generateAudio('Text only');
    expect(speechCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ instructions: '' })
    );
  });

  it('creates the output directory with recursive flag', async () => {
    const client = AudioClient.getInstance();
    await client.generateAudio('test');
    expect(mkdirSpy).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/qrhit-audio-test/audio'),
      { recursive: true }
    );
  });

  it('writes the file at the correct path', async () => {
    const client = AudioClient.getInstance();
    const result = await client.generateAudio('test');
    expect(writeFileSpy).toHaveBeenCalledWith(result, expect.any(Buffer));
  });

  it('uses generateRandomString for the filename', async () => {
    const client = AudioClient.getInstance();
    await client.generateAudio('test');
    expect(generateRandomStringSpy).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// generateAudio – PRIVATE_DIR missing
// ──────────────────────────────────────────────

describe('AudioClient.generateAudio – missing PRIVATE_DIR', () => {
  it('throws when PRIVATE_DIR is not set', async () => {
    const saved = process.env['PRIVATE_DIR'];
    delete process.env['PRIVATE_DIR'];
    // Note: generateAudio throws BEFORE calling OpenAI when PRIVATE_DIR is
    // missing, so no speechCreate mock needed here.
    const client = AudioClient.getInstance();
    await expect(client.generateAudio('test')).rejects.toThrow('PRIVATE_DIR');
    process.env['PRIVATE_DIR'] = saved;
  });
});

// ──────────────────────────────────────────────
// generateAudio – OpenAI error
// ──────────────────────────────────────────────

describe('AudioClient.generateAudio – OpenAI error', () => {
  it('re-throws error from OpenAI speech create', async () => {
    speechCreate.mockRejectedValueOnce(new Error('TTS failed'));
    const client = AudioClient.getInstance();
    await expect(client.generateAudio('Boom')).rejects.toThrow('TTS failed');
  });

  it('re-throws file write errors', async () => {
    const fakeBuffer = Buffer.from('mp3-data');
    speechCreate.mockResolvedValueOnce({
      arrayBuffer: async () => fakeBuffer.buffer,
    });
    writeFileSpy.mockRejectedValueOnce(new Error('Disk full'));
    const client = AudioClient.getInstance();
    await expect(client.generateAudio('Boom')).rejects.toThrow('Disk full');
  });
});

// ──────────────────────────────────────────────
// Missing OPENAI_API_KEY
// ──────────────────────────────────────────────

describe('AudioClient – missing API key', () => {
  it('rejects with LlmUnavailableError when no OpenAI key is set', async () => {
    const saved = process.env['OPENAI_API_KEY'];
    const savedToken = process.env['OPENAI_TOKEN'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_TOKEN'];
    try {
      await expect(AudioClient.getInstance().generateAudio('x')).rejects.toBeInstanceOf(
        LlmUnavailableError
      );
      expect(speechCreate).not.toHaveBeenCalled();
    } finally {
      process.env['OPENAI_API_KEY'] = saved;
      if (savedToken !== undefined) process.env['OPENAI_TOKEN'] = savedToken;
    }
  });
});
