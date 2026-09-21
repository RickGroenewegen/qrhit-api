import fs from 'fs';
import os from 'os';
import path from 'path';
import { PostHog } from 'posthog-node';
import { color, white } from 'console-log-colors';
import Logger from './logger';

// The frontend's PostHog project, so API and site errors land in one error
// tracking list. Every exception carries `app`: `backend` here, `frontend`
// from the site (ErrorTrackingService there); `service` says which backend
// process. A public project key: every page of the site carries it too.
const DEFAULT_KEY = 'phc_6RRGQ0TXOX7K4fsOyNCeWEEhefLPVD2gtf7mcOWsiTj';
const DEFAULT_HOST = 'https://us.i.posthog.com';

// posthog-node rate-limits only its own autocapture, not captureException, so
// this caps what an outage failing every request can send.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_KEY = 10;
const RATE_MAX_TOTAL = 100;
const SHUTDOWN_TIMEOUT_MS = 3000;

export type ErrorTrackingService = 'api' | 'worker';

/**
 * Sends API errors to PostHog error tracking. Production only; a no-op
 * everywhere else, tests included.
 *
 * Nothing is instrumented: Sentry's 100% tracing and profiling is what pegged
 * the cluster primary, see git dded4cec. Errors are captured at four places:
 *
 * - uncaught exceptions, and unhandled rejections (Node's default `throw` mode
 *   raises those as uncaught exceptions): reported, printed and flushed, then
 *   the process exits 1 exactly as it did without a handler;
 * - the Fastify error handler, for errors that are not a 4xx;
 * - failed queue jobs and queue worker errors;
 * - any `console.error` call that is handed an Error. Most failures are caught
 *   where they happen (hundreds of catch blocks that log and answer 500), and
 *   this is the one place they all pass through.
 */
class ErrorTracking {
  private static instance: ErrorTracking;
  private logger = new Logger();
  private client: PostHog | null = null;
  private service: ErrorTrackingService = 'api';
  private baseProperties: Record<string, unknown> = {};
  // Errors already sent (or deliberately skipped), so an error that is
  // captured with context and then logged is not sent twice.
  private handled = new WeakSet<object>();
  private windowStart = 0;
  private windowTotal = 0;
  private windowCounts = new Map<string, number>();
  private exiting = false;

  static getInstance(): ErrorTracking {
    if (!ErrorTracking.instance) ErrorTracking.instance = new ErrorTracking();
    return ErrorTracking.instance;
  }

  init(service: ErrorTrackingService, client?: PostHog): void {
    if (this.client) return;
    if (!client && process.env['ENVIRONMENT'] !== 'production') return;

    this.service = service;
    this.client =
      client ??
      new PostHog(process.env['POSTHOG_KEY'] || DEFAULT_KEY, {
        host: process.env['POSTHOG_HOST'] || DEFAULT_HOST,
        // Errors are rare; send each one right away rather than lose a batch
        // when pm2 restarts the process.
        flushAt: 1,
        flushInterval: 5000,
      });
    this.baseProperties = {
      app: 'backend',
      service,
      worker_id: process.env['WORKER_ID'] ?? null,
      hostname: os.hostname(),
      release: readBuildCommit(),
      $process_person_profile: false,
    };
    this.hookConsoleError();
    this.hookUncaughtException();
    this.logger.log(
      color.blue.bold(`Error tracking enabled for ${white.bold(service)}`)
    );
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  capture(error: unknown, properties: Record<string, unknown> = {}): void {
    const client = this.client;
    if (!client || !isErrorLike(error) || this.handled.has(error)) return;
    this.handled.add(error);
    if (this.isRateLimited(error)) return;
    try {
      client.captureException(error, `qrsong-${this.service}`, {
        ...this.baseProperties,
        ...properties,
      });
    } catch {
      // Reporting must never throw into the code that reports.
    }
  }

  /** Marks an error as not worth reporting, for when it is logged anyway. */
  ignore(error: unknown): void {
    if (isErrorLike(error)) this.handled.add(error);
  }

  private isRateLimited(error: Error): boolean {
    const now = Date.now();
    if (now - this.windowStart > RATE_WINDOW_MS) {
      this.windowStart = now;
      this.windowTotal = 0;
      this.windowCounts.clear();
    }
    const key = `${error.name}:${String(error.message).slice(0, 80)}`;
    const count = (this.windowCounts.get(key) ?? 0) + 1;
    this.windowCounts.set(key, count);
    this.windowTotal++;
    return count > RATE_MAX_PER_KEY || this.windowTotal > RATE_MAX_TOTAL;
  }

  private hookConsoleError(): void {
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      original(...args);
      const error = args.find(isErrorLike);
      if (!error || isFromPostHog(error, args)) return;
      const message = args
        .filter((arg): arg is string => typeof arg === 'string')
        .join(' ')
        .slice(0, 300);
      this.capture(error, message ? { log_message: message } : {});
    };
  }

  private hookUncaughtException(): void {
    process.on('uncaughtException', (error, origin) => {
      this.capture(error, { fatal: true, origin });
      // What Node prints without a handler; already captured, so not resent.
      console.error(error);
      if (this.exiting) return;
      this.exiting = true;
      const exit = () => process.exit(1);
      Promise.resolve(this.client?.shutdown(SHUTDOWN_TIMEOUT_MS)).then(exit, exit);
    });
  }
}

function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['message'] === 'string' && typeof v['stack'] === 'string';
}

// posthog-node logs its own failures (PostHog unreachable, say) with
// console.error; reporting those would loop.
function isFromPostHog(error: Error, args: unknown[]): boolean {
  return (
    String(error.stack ?? '').includes('posthog-node') ||
    args.some((arg) => typeof arg === 'string' && arg.startsWith('[PostHog'))
  );
}

// `npm run build` stamps the commit it built into build/.build-commit
// (_scripts/build-stamp.sh); this file runs from build/src.
function readBuildCommit(): string | null {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.build-commit'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export default ErrorTracking;
