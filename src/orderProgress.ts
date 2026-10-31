import Cache from './cache';
import ProgressWebSocketServer, { ProgressData } from './progress-websocket';

/**
 * What generating an order is doing right now, for whoever watches it: the
 * scan app's "your cards are being made" screen after a store purchase
 * (2.1.0). It rides on the playlist progress socket (/progress-ws): the
 * client connects with `playlistId` and `requestId` both the payment id and
 * `serviceType` 'order'.
 *
 * Generation runs in a queue worker (the cluster primary or worker.ts),
 * which has no socket server: there the event goes to Redis, which every
 * HTTP worker relays to its connections. Nobody watching costs one PUBLISH.
 * Reporting never throws and is never awaited, so it cannot slow down or
 * break generation.
 *
 * The stages, in order:
 * - `started`: the job picked the paid order up
 * - `playlist`: reading a line's playlist from its music service
 * - `songs`: storing its songs
 * - `years`: looking up the release years nobody knew yet (current/total)
 * - `qr`: making its QR codes (current/total)
 * - `yearcheck`: done for now; the PDF waits for the year check (POST
 *   /yearcheck finalizes it later, and reports pdf, mail and done then)
 * - `pdf`: building the PDFs (finalizeOrder)
 * - `mail`: mailing the digital PDF
 * - `done`: `downloadUrl` is the first digital line's PDF
 * - `error`: the job's last attempt failed
 */

export type OrderStage =
  | 'started'
  | 'playlist'
  | 'songs'
  | 'years'
  | 'qr'
  | 'yearcheck'
  | 'pdf'
  | 'mail'
  | 'done'
  | 'error';

/** The `serviceType` an order's progress is published under. */
export const ORDER_PROGRESS_SERVICE = 'order';

// Per-card counts: the first, the last and at most one in between this often
export const ORDER_PROGRESS_THROTTLE_MS = 500;

// Where the bar stands at each stage. The lines' own work (playlist to QR
// codes) fills LINES_FROM..LINES_TO, split evenly between the order's lines.
const AT_STAGE: Partial<Record<OrderStage, number>> = {
  started: 2,
  yearcheck: 85,
  pdf: 88,
  mail: 96,
  done: 100,
  error: 0,
};
const LINES_FROM = 5;
const LINES_TO = 85;
// Within one line: the share each stage starts and ends at
const WITHIN_LINE: Partial<Record<OrderStage, [number, number]>> = {
  playlist: [0, 0.1],
  songs: [0.1, 0.2],
  years: [0.2, 0.45],
  qr: [0.45, 1],
};

// After these the job is over; finalizing after the year check starts afresh
const LAST_STAGES = new Set<OrderStage>(['yearcheck', 'done', 'error']);
// A job that died without a last stage leaves its entry; this caps them
const MAX_TRACKED = 1000;

export interface OrderProgressDetail {
  current?: number;
  total?: number;
  /** The order line being worked on (0-based) and how many there are. */
  line?: number;
  lines?: number;
  downloadUrl?: string;
}

interface Tracked {
  stage: OrderStage;
  line: number;
  lines: number;
  sentAt: number;
}

class OrderProgress {
  private static instance: OrderProgress;
  private tracked = new Map<string, Tracked>();

  public static getInstance(): OrderProgress {
    if (!OrderProgress.instance) {
      OrderProgress.instance = new OrderProgress();
    }
    return OrderProgress.instance;
  }

  public report(
    paymentId: string,
    stage: OrderStage,
    detail: OrderProgressDetail = {}
  ): void {
    try {
      const now = Date.now();
      const tracked = this.tracked.get(paymentId) ?? {
        stage,
        line: 0,
        lines: 1,
        sentAt: 0,
      };
      if (detail.lines) {
        tracked.lines = detail.lines;
        tracked.line = detail.line ?? 0;
      }

      const counting =
        typeof detail.current === 'number' && typeof detail.total === 'number';
      if (
        counting &&
        tracked.stage === stage &&
        detail.current! > 0 &&
        detail.current! < detail.total! &&
        now - tracked.sentAt < ORDER_PROGRESS_THROTTLE_MS
      ) {
        return;
      }
      tracked.stage = stage;
      tracked.sentAt = now;

      if (LAST_STAGES.has(stage)) {
        this.tracked.delete(paymentId);
      } else {
        if (this.tracked.size >= MAX_TRACKED && !this.tracked.has(paymentId)) {
          this.tracked.clear();
        }
        this.tracked.set(paymentId, tracked);
      }

      const data: ProgressData = {
        stage,
        percentage: this.percentage(stage, tracked, detail),
      };
      if (counting) {
        data.current = detail.current;
        data.total = detail.total;
      }
      if (detail.downloadUrl) {
        data.downloadUrl = detail.downloadUrl;
      }

      ProgressWebSocketServer.publishEvent(
        paymentId,
        ORDER_PROGRESS_SERVICE,
        paymentId,
        stage === 'done' ? 'complete' : stage === 'error' ? 'error' : 'progress',
        data,
        process.env['REDIS_URL']
          ? (channel, message) =>
              Cache.getInstance().executeCommand('publish', channel, message)
          : undefined
      );
    } catch {
      // Progress is a nicety; generation goes on without it
    }
  }

  private percentage(
    stage: OrderStage,
    tracked: Tracked,
    detail: OrderProgressDetail
  ): number {
    const within = WITHIN_LINE[stage];
    if (!within) {
      return AT_STAGE[stage] ?? 0;
    }
    const counted =
      detail.total && detail.total > 0
        ? Math.min(1, Math.max(0, (detail.current ?? 0) / detail.total))
        : 0;
    const inLine = within[0] + (within[1] - within[0]) * counted;
    const lines = Math.max(1, tracked.lines);
    const line = Math.min(Math.max(0, tracked.line), lines - 1);
    return Math.round(
      LINES_FROM + ((LINES_TO - LINES_FROM) * (line + inLine)) / lines
    );
  }
}

export default OrderProgress;
