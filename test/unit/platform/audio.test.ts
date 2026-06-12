import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// ---------------------------------------------------------------------------
// Collaborator mocks (no network, no real OpenAI)
//
//  - openai      → audio.speech.create recorded; APIError preserved as a
//                  real class so the `instanceof OpenAI.APIError` branch works
//  - src/logger  → log lines captured for assertions
//  - src/utils   → deterministic generateRandomString (controls the filename)
//  - fs/promises → left REAL: writes land in the scratch PRIVATE_DIR created
//                  by test/setup.ts, matching the source behavior exactly
// ---------------------------------------------------------------------------

const { speechCreateMock, randomStringMock, logLines } = vi.hoisted(() => ({
  speechCreateMock: vi.fn(),
  randomStringMock: vi.fn(),
  logLines: [] as string[],
}));

vi.mock('openai', () => {
  class APIError extends Error {
    status?: number;
    code?: string | null;
    type?: string;
    constructor(message: string) {
      super(message);
    }
  }
  class OpenAIMock {
    static APIError = APIError;
    audio = { speech: { create: speechCreateMock } };
  }
  return { default: OpenAIMock };
});

vi.mock('../../../src/logger', () => ({
  default: class {
    log(message: string) {
      logLines.push(message);
    }
    logDev() {}
  },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    generateRandomString = randomStringMock;
  },
}));

import OpenAI from 'openai';
import AudioClient from '../../../src/audio';

/** A fake TTS response whose body decodes to `bytes`. */
function mp3Response(bytes: string) {
  return {
    arrayBuffer: async () => new TextEncoder().encode(bytes).buffer,
  };
}

const audioDir = path.resolve(process.env['PRIVATE_DIR']!, 'audio');

beforeEach(() => {
  speechCreateMock.mockReset();
  randomStringMock.mockReset();
  randomStringMock.mockReturnValue('testrandom');
  logLines.length = 0;
});

// ---------------------------------------------------------------------------
// getInstance
// ---------------------------------------------------------------------------

describe('AudioClient.getInstance', () => {
  it('returns the same singleton instance on every call', () => {
    expect(AudioClient.getInstance()).toBe(AudioClient.getInstance());
  });

  it('throws at construction when OPENAI_API_KEY is missing', async () => {
    const saved = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      // Fresh module copy so the cached singleton does not mask the check.
      vi.resetModules();
      const FreshAudioClient = (await import('../../../src/audio')).default;
      expect(() => FreshAudioClient.getInstance()).toThrow(
        'OPENAI_API_KEY environment variable is not defined'
      );
    } finally {
      process.env['OPENAI_API_KEY'] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// generateAudio — success path
// ---------------------------------------------------------------------------

describe('AudioClient.generateAudio', () => {
  it('calls the OpenAI TTS endpoint with the hardcoded model/voice and writes the mp3', async () => {
    speechCreateMock.mockResolvedValueOnce(mp3Response('fake-mp3-bytes'));

    const client = AudioClient.getInstance();
    const filePath = await client.generateAudio('Hello world');

    // Exact request payload: model and voice are hardcoded in the source,
    // instructions defaults to the empty string.
    expect(speechCreateMock).toHaveBeenCalledTimes(1);
    expect(speechCreateMock).toHaveBeenCalledWith({
      model: 'gpt-4o-mini-tts',
      voice: 'ash',
      input: 'Hello world',
      instructions: '',
    });

    // File lands in PRIVATE_DIR/audio/<randomString>.mp3
    expect(filePath).toBe(path.resolve(audioDir, 'testrandom.mp3'));
    expect(randomStringMock).toHaveBeenCalledTimes(1);
    expect((await fs.readFile(filePath)).toString()).toBe('fake-mp3-bytes');
  });

  it('passes explicit instructions through to the API', async () => {
    speechCreateMock.mockResolvedValueOnce(mp3Response('x'));

    await AudioClient.getInstance().generateAudio('Bonjour', 'Speak slowly');

    expect(speechCreateMock).toHaveBeenCalledWith({
      model: 'gpt-4o-mini-tts',
      voice: 'ash',
      input: 'Bonjour',
      instructions: 'Speak slowly',
    });
  });

  it('generates a new random filename on every call (no caching / reuse)', async () => {
    // audio.ts has no skip-if-exists logic: each call gets a fresh random
    // name and always invokes the TTS API.
    randomStringMock
      .mockReturnValueOnce('firstname1')
      .mockReturnValueOnce('secondname2');
    speechCreateMock
      .mockResolvedValueOnce(mp3Response('one'))
      .mockResolvedValueOnce(mp3Response('two'));

    const client = AudioClient.getInstance();
    const first = await client.generateAudio('Same text');
    const second = await client.generateAudio('Same text');

    expect(first).toBe(path.resolve(audioDir, 'firstname1.mp3'));
    expect(second).toBe(path.resolve(audioDir, 'secondname2.mp3'));
    expect(speechCreateMock).toHaveBeenCalledTimes(2);
    expect((await fs.readFile(first)).toString()).toBe('one');
    expect((await fs.readFile(second)).toString()).toBe('two');
  });

  // -------------------------------------------------------------------------
  // generateAudio — error paths
  // -------------------------------------------------------------------------

  it('throws when PRIVATE_DIR is not defined, without calling OpenAI', async () => {
    const saved = process.env['PRIVATE_DIR'];
    delete process.env['PRIVATE_DIR'];
    try {
      await expect(
        AudioClient.getInstance().generateAudio('Hello')
      ).rejects.toThrow('PRIVATE_DIR environment variable is not defined');
      expect(speechCreateMock).not.toHaveBeenCalled();
    } finally {
      process.env['PRIVATE_DIR'] = saved;
    }
  });

  it('logs and re-throws generic API failures, writing no file', async () => {
    randomStringMock.mockReturnValue('failedcall');
    speechCreateMock.mockRejectedValueOnce(new Error('TTS exploded'));

    await expect(
      AudioClient.getInstance().generateAudio('Hello')
    ).rejects.toThrow('TTS exploded');

    expect(logLines).toContain('Error generating audio: TTS exploded');
    // No OpenAI-specific detail lines for a plain Error
    expect(logLines.some((l) => l.startsWith('OpenAI API Error'))).toBe(false);
    await expect(
      fs.access(path.resolve(audioDir, 'failedcall.mp3'))
    ).rejects.toThrow();
  });

  it('logs status/message/code/type details for OpenAI APIError instances', async () => {
    const apiError = new (OpenAI as any).APIError('rate limited');
    apiError.status = 429;
    apiError.code = 'rate_limit_exceeded';
    apiError.type = 'requests';
    speechCreateMock.mockRejectedValueOnce(apiError);

    await expect(
      AudioClient.getInstance().generateAudio('Hello')
    ).rejects.toBe(apiError);

    expect(logLines).toContain('Error generating audio: rate limited');
    expect(logLines).toContain('OpenAI API Error Status: 429');
    expect(logLines).toContain('OpenAI API Error Message: rate limited');
    expect(logLines).toContain('OpenAI API Error Code: rate_limit_exceeded');
    expect(logLines).toContain('OpenAI API Error Type: requests');
  });
});
