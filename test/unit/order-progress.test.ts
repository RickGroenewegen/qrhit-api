import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * An order's live progress for the scan app's done screen
 * (src/orderProgress.ts) on the playlist progress socket
 * (src/progress-websocket.ts): how it is published from a process with and
 * without the socket server, the throttle on per-card counts, the bar's
 * percentages and that reporting never throws.
 */

const redis = vi.hoisted(() => ({
  executeCommand: vi.fn(async (..._args: any[]) => 1),
}));

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => redis },
}));

import OrderProgress, { ORDER_PROGRESS_THROTTLE_MS } from '../../src/orderProgress';
import ProgressWebSocketServer from '../../src/progress-websocket';

const ORIG_REDIS_URL = process.env['REDIS_URL'];

/** The events published to Redis, as the HTTP workers' subscribers read them. */
function published(): any[] {
  return redis.executeCommand.mock.calls.map(([command, channel, message]) => {
    expect(command).toBe('publish');
    expect(channel).toBe('progress-events');
    return JSON.parse(message);
  });
}

let paymentCounter = 0;
/** Every test its own payment: the throttle remembers payments. */
function newPayment(): string {
  paymentCounter += 1;
  return `store_test_${paymentCounter}`;
}

beforeEach(() => {
  redis.executeCommand.mockReset();
  redis.executeCommand.mockResolvedValue(1);
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  ProgressWebSocketServer.setInstance(null as any);
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIG_REDIS_URL === undefined) delete process.env['REDIS_URL'];
  else process.env['REDIS_URL'] = ORIG_REDIS_URL;
  ProgressWebSocketServer.setInstance(null as any);
});

describe('OrderProgress.report', () => {
  it('publishes to Redis from a process without the socket server (the queue workers)', () => {
    const paymentId = newPayment();

    OrderProgress.getInstance().report(paymentId, 'started');

    expect(published()).toEqual([
      {
        playlistId: paymentId,
        serviceType: 'order',
        requestId: paymentId,
        type: 'progress',
        data: { stage: 'started', percentage: 2 },
      },
    ]);
  });

  it('goes through the local socket server in an HTTP worker', () => {
    const paymentId = newPayment();
    const server = { publishProgressEvent: vi.fn() };
    ProgressWebSocketServer.setInstance(server as any);

    OrderProgress.getInstance().report(paymentId, 'pdf');

    expect(server.publishProgressEvent).toHaveBeenCalledWith(paymentId, 'order', paymentId, 'progress', {
      stage: 'pdf',
      percentage: 88,
    });
    expect(redis.executeCommand).not.toHaveBeenCalled();
  });

  it('does nothing without Redis or a socket server: nobody can be listening', () => {
    delete process.env['REDIS_URL'];

    expect(() => OrderProgress.getInstance().report(newPayment(), 'started')).not.toThrow();
    expect(redis.executeCommand).not.toHaveBeenCalled();
  });

  it('sends done as complete, with the PDF link, and error as error', () => {
    const done = newPayment();
    const failed = newPayment();

    OrderProgress.getInstance().report(done, 'done', { downloadUrl: 'https://api.test/download/x/digital' });
    OrderProgress.getInstance().report(failed, 'error');

    const [complete, error] = published();
    expect(complete).toMatchObject({
      type: 'complete',
      data: { stage: 'done', percentage: 100, downloadUrl: 'https://api.test/download/x/digital' },
    });
    expect(error).toMatchObject({ type: 'error', data: { stage: 'error' } });
  });

  it('sends the first and last card of a count and at most one in between per throttle window', () => {
    vi.useFakeTimers();
    const paymentId = newPayment();
    const progress = OrderProgress.getInstance();

    progress.report(paymentId, 'qr', { current: 0, total: 100 });
    for (let current = 1; current < 100; current++) {
      progress.report(paymentId, 'qr', { current, total: 100 });
    }
    vi.advanceTimersByTime(ORDER_PROGRESS_THROTTLE_MS);
    progress.report(paymentId, 'qr', { current: 99, total: 100 });
    progress.report(paymentId, 'qr', { current: 100, total: 100 });

    expect(published().map((event) => event.data.current)).toEqual([0, 99, 100]);
  });

  it('always sends a new stage, however soon after the last message', () => {
    vi.useFakeTimers();
    const paymentId = newPayment();
    const progress = OrderProgress.getInstance();

    progress.report(paymentId, 'years', { current: 0, total: 10 });
    progress.report(paymentId, 'qr', { current: 1, total: 10 });

    expect(published().map((event) => event.data.stage)).toEqual(['years', 'qr']);
  });

  it('fills the bar per stage, and splits the lines’ work between the lines', () => {
    const progress = OrderProgress.getInstance();
    const single = newPayment();
    const double = newPayment();

    progress.report(single, 'playlist', { line: 0, lines: 1 });
    progress.report(single, 'qr', { current: 50, total: 100 });
    progress.report(single, 'qr', { current: 100, total: 100 });
    progress.report(single, 'yearcheck');
    progress.report(double, 'playlist', { line: 1, lines: 2 });

    expect(published().map((event) => event.data.percentage)).toEqual([5, 63, 85, 85, 45]);
  });

  it('starts a payment afresh after its last stage (finalizing after the year check)', () => {
    vi.useFakeTimers();
    const paymentId = newPayment();
    const progress = OrderProgress.getInstance();

    progress.report(paymentId, 'playlist', { line: 1, lines: 2 });
    progress.report(paymentId, 'yearcheck');
    progress.report(paymentId, 'qr', { current: 0, total: 4 });

    // Line 1 of 1 again, not line 2 of 2
    expect(published()[2].data.percentage).toBe(41);
  });

  it('never throws when Redis refuses', async () => {
    redis.executeCommand.mockRejectedValue(new Error('Redis down'));

    expect(() => OrderProgress.getInstance().report(newPayment(), 'started')).not.toThrow();
    await Promise.resolve();
  });
});
