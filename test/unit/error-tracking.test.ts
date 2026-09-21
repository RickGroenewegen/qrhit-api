import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ErrorTracking from '../../src/errorTracking';

/**
 * Unit tests for src/errorTracking.ts.
 *
 * The PostHog client is a fake handed to init(); nothing is sent. init() wraps
 * console.error and adds an uncaughtException listener, so both are put back
 * after every test.
 *  - src/logger → no-op
 */

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

function fakeClient() {
  return {
    captureException: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ErrorTracking', () => {
  let originalConsoleError: typeof console.error;
  let listenersBefore: Function[];
  let originalEnvironment: string | undefined;

  beforeEach(() => {
    originalConsoleError = console.error;
    console.error = vi.fn();
    listenersBefore = process.listeners('uncaughtException');
    originalEnvironment = process.env['ENVIRONMENT'];
  });

  afterEach(() => {
    console.error = originalConsoleError;
    for (const listener of process.listeners('uncaughtException')) {
      if (!listenersBefore.includes(listener)) {
        process.removeListener('uncaughtException', listener as any);
      }
    }
    if (originalEnvironment === undefined) delete process.env['ENVIRONMENT'];
    else process.env['ENVIRONMENT'] = originalEnvironment;
    vi.restoreAllMocks();
  });

  function enabled(service: 'api' | 'worker' = 'api') {
    const client = fakeClient();
    const tracking = new ErrorTracking();
    tracking.init(service, client as any);
    return { tracking, client };
  }

  describe('outside production', () => {
    it.each(['development', 'test', undefined])(
      'stays off when ENVIRONMENT is %s: no client, no console hook, no crash handler',
      (environment) => {
        if (environment === undefined) delete process.env['ENVIRONMENT'];
        else process.env['ENVIRONMENT'] = environment;
        const hookedConsole = console.error;
        const tracking = new ErrorTracking();

        tracking.init('api');
        tracking.capture(new Error('boom'));

        expect(tracking.enabled).toBe(false);
        expect(console.error).toBe(hookedConsole);
        expect(process.listeners('uncaughtException')).toEqual(listenersBefore);
      }
    );
  });

  describe('capture', () => {
    it('tags every exception as backend, with the process it came from', () => {
      const { tracking, client } = enabled('worker');
      const error = new Error('boom');

      tracking.capture(error, { queue: 'asset' });

      expect(client.captureException).toHaveBeenCalledTimes(1);
      const [sent, distinctId, properties] = client.captureException.mock.calls[0];
      expect(sent).toBe(error);
      expect(distinctId).toBe('qrsong-worker');
      expect(properties).toMatchObject({
        app: 'backend',
        service: 'worker',
        queue: 'asset',
        $process_person_profile: false,
      });
    });

    it('sends an error once, however often it is captured or logged', () => {
      const { tracking, client } = enabled();
      const error = new Error('boom');

      tracking.capture(error, { route: '/x' });
      tracking.capture(error);
      console.error(error);

      expect(client.captureException).toHaveBeenCalledTimes(1);
    });

    it('does not send an error marked with ignore(), even when it is logged', () => {
      const { tracking, client } = enabled();
      const error = new Error('Bad request body');

      tracking.ignore(error);
      console.error(error);

      expect(client.captureException).not.toHaveBeenCalled();
    });

    it('skips values that are not errors', () => {
      const { tracking, client } = enabled();

      tracking.capture('a string');
      tracking.capture({ message: 'no stack' });
      tracking.capture(null);

      expect(client.captureException).not.toHaveBeenCalled();
    });

    it('never throws into the caller when the client does', () => {
      const { tracking, client } = enabled();
      client.captureException.mockImplementation(() => {
        throw new Error('client broke');
      });

      expect(() => tracking.capture(new Error('boom'))).not.toThrow();
    });

    it('caps one kind of error at 10 per minute', () => {
      const { tracking, client } = enabled();

      for (let i = 0; i < 15; i++) tracking.capture(new Error('database down'));
      tracking.capture(new Error('something else'));

      expect(client.captureException).toHaveBeenCalledTimes(11);
    });
  });

  describe('console.error hook', () => {
    it('still logs, and reports an Error with the text logged next to it', () => {
      const logged = console.error as ReturnType<typeof vi.fn>;
      const { client } = enabled();
      const error = new Error('Spotify down');

      console.error('Error fetching playlist:', error);

      expect(logged).toHaveBeenCalledWith('Error fetching playlist:', error);
      expect(client.captureException).toHaveBeenCalledTimes(1);
      expect(client.captureException.mock.calls[0][2]).toMatchObject({
        log_message: 'Error fetching playlist:',
      });
    });

    it('ignores a log without an Error in it', () => {
      const { client } = enabled();

      console.error('Something failed:', 'just a message', 42);

      expect(client.captureException).not.toHaveBeenCalled();
    });

    it("ignores PostHog's own failures, which would loop", () => {
      const { client } = enabled();

      console.error('[PostHog] Error while flushing', new Error('fetch failed'));

      expect(client.captureException).not.toHaveBeenCalled();
    });
  });

  describe('uncaught exceptions', () => {
    it('reports the crash, flushes and exits 1 like Node does without a handler', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const logged = console.error as ReturnType<typeof vi.fn>;
      const { client } = enabled();
      const handler = process
        .listeners('uncaughtException')
        .find((listener) => !listenersBefore.includes(listener))!;
      const error = new Error('crash');

      handler(error, 'unhandledRejection');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

      expect(client.captureException).toHaveBeenCalledTimes(1);
      expect(client.captureException.mock.calls[0][2]).toMatchObject({
        fatal: true,
        origin: 'unhandledRejection',
      });
      expect(client.shutdown).toHaveBeenCalledWith(3000);
      expect(logged).toHaveBeenCalledWith(error);
    });
  });
});
