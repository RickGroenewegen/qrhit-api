import cluster from 'cluster';
import { CronJob } from 'cron';
import { color, white } from 'console-log-colors';
import type { PushSchedule as PushScheduleRow } from '@prisma/client';
import PrismaInstance from './prisma';
import Logger from './logger';
import Utils from './utils';
import Cache from './cache';
import Push from './push';
import PushoverClient from './pushover';

/**
 * Scheduled broadcasts: a push written now that goes out at a set moment,
 * like a scheduled EmailOctopus campaign (built 2026-11-19).
 *
 * A row in push_schedules waits until its sendAt. A cron every minute, on the
 * cluster primary of the main server only, sends what is due through
 * Push.broadcastNotification, which writes the usual push_messages row at
 * the real send moment (the statistics read push_messages.createdAt as the
 * send time, so nothing unsent may live there).
 *
 * - A row is claimed (scheduled → sending) by a conditional update before
 *   it is sent, on top of the Redis lock, so it can never go out twice.
 * - More than MAX_LATE_MS late (the server was down over the send time) it
 *   is not sent but marked `missed`: "ends tonight" must not arrive the next
 *   morning. Rick gets a Pushover for a missed or failed one.
 * - A row left in `sending` by a crash stays there for a person to look at;
 *   it is never retried by itself.
 * - In development the cron runs too, but every send is a dry run: the dev
 *   database lives on the production RDS server and may hold real phones'
 *   tokens. Anywhere else but the main server it does not start.
 */

export const TITLE_MAX = 50;
export const MESSAGE_MAX = 178;
export const NAME_MAX = 100;
// At least this far ahead when saved, so the cron cannot pass it while saving
export const MIN_LEAD_MS = 60 * 1000;
export const MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_LATE_MS = 2 * 60 * 60 * 1000;

export type ScheduleStatus = 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed' | 'missed';

const LOCK = 'push-schedule';
// An ISO time with an explicit zone: a bare "2026-11-27T10:00" would be read
// in the server's own zone (the discount form's one-hour bug)
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

export interface PushScheduleInput {
  name?: unknown;
  title?: unknown;
  message?: unknown;
  sendAt?: unknown;
  test?: unknown;
  dry?: unknown;
}

export interface PushScheduleData {
  name: string | null;
  title: string;
  message: string;
  sendAt: Date;
  test: boolean;
  dry: boolean;
}

export type Validated =
  | { ok: true; data: PushScheduleData }
  | { ok: false; error: string; message: string };

export type ScheduleResult =
  | { ok: true; row: PushScheduleRow }
  | { ok: false; status: 400 | 404 | 409; error: string; message: string };

export interface RunCounts {
  sent: number;
  missed: number;
  failed: number;
}

/** A send time from the API body: epoch milliseconds or ISO with a zone. */
export function parseSendAt(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && ISO_WITH_ZONE.test(value.trim())) {
    const date = new Date(value.trim());
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['true', 'yes', '1'].includes(value.trim().toLowerCase());
  return false;
}

/** The body of a create or an edit, checked against the dashboard's limits. */
export function validatePushInput(input: PushScheduleInput, now: Date): Validated {
  const fail = (error: string, message: string): Validated => ({ ok: false, error, message });
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null;

  if (!title) return fail('title_required', 'The title is empty');
  if (title.length > TITLE_MAX) return fail('title_too_long', `The title is longer than ${TITLE_MAX} characters`);
  if (!message) return fail('message_required', 'The message is empty');
  if (message.length > MESSAGE_MAX) {
    return fail('message_too_long', `The message is longer than ${MESSAGE_MAX} characters`);
  }
  if (name && name.length > NAME_MAX) return fail('name_too_long', `The name is longer than ${NAME_MAX} characters`);

  const sendAt = parseSendAt(input.sendAt);
  if (!sendAt) {
    return fail('send_at_invalid', 'The send time is missing or has no time zone (ISO with Z or an offset, or epoch ms)');
  }
  if (sendAt.getTime() < now.getTime() + MIN_LEAD_MS) {
    return fail('send_at_past', 'The send time must be at least a minute from now');
  }
  if (sendAt.getTime() > now.getTime() + MAX_AHEAD_MS) {
    return fail('send_at_too_far', 'The send time is more than 90 days away');
  }

  return { ok: true, data: { name, title, message, sendAt, test: toBool(input.test), dry: toBool(input.dry) } };
}

/** What the scheduler does with a row whose turn may have come. */
export function dueAction(row: { status: string; sendAt: Date }, now: Date): 'wait' | 'send' | 'missed' {
  if (row.status !== 'scheduled') return 'wait';
  const late = now.getTime() - row.sendAt.getTime();
  if (late < 0) return 'wait';
  return late > MAX_LATE_MS ? 'missed' : 'send';
}

class PushSchedule {
  private static instance: PushSchedule;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private cache = Cache.getInstance();
  private pushover = new PushoverClient();
  private cronStarted = false;

  public static getInstance(): PushSchedule {
    if (!PushSchedule.instance) {
      PushSchedule.instance = new PushSchedule();
    }
    return PushSchedule.instance;
  }

  private log(message: string, tone: 'blue' | 'green' | 'yellow' | 'red' = 'blue') {
    this.logger.log(color[tone].bold(`[${white.bold('push-schedule')}] ${message}`));
  }

  private development(): boolean {
    return process.env['ENVIRONMENT'] === 'development';
  }

  /**
   * Called by Server.startCluster() only, never by the routes: building the
   * app (or a test of it) must not start a timer that sends.
   */
  public startCron() {
    if (!cluster.isPrimary || this.cronStarted) return;
    this.cronStarted = true;
    const start = () => {
      new CronJob(
        '* * * * *',
        async () => {
          try {
            await this.run();
          } catch (error) {
            this.log(`run crashed: ${(error as Error)?.message || error}`, 'red');
          }
        },
        null,
        true,
        'Europe/Amsterdam'
      );
      this.log(
        `scheduled broadcasts checked ${white.bold('every minute')}` +
          (this.development() ? ` (${white.bold('development: every send is a dry run')})` : '')
      );
    };
    if (this.development()) {
      start();
      return;
    }
    this.utils
      .isMainServer()
      .then((isMain) => {
        if (isMain) start();
      })
      .catch(() => {});
  }

  /** Waiting and sending ones first (soonest first), then the last 100 others. */
  public async list(): Promise<PushScheduleRow[]> {
    const active: ScheduleStatus[] = ['scheduled', 'sending'];
    const [upcoming, done] = await Promise.all([
      this.prisma.pushSchedule.findMany({ where: { status: { in: active } }, orderBy: { sendAt: 'asc' } }),
      this.prisma.pushSchedule.findMany({
        where: { status: { notIn: active } },
        orderBy: { sendAt: 'desc' },
        take: 100,
      }),
    ]);
    return [...upcoming, ...done];
  }

  public async create(input: PushScheduleInput, now = new Date()): Promise<ScheduleResult> {
    const checked = validatePushInput(input, now);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error, message: checked.message };
    const row = await this.prisma.pushSchedule.create({ data: { ...checked.data, status: 'scheduled' } });
    this.log(
      `${row.test ? 'test' : 'live'}${row.dry ? ' dry' : ''} broadcast #${white.bold(row.id)} ` +
        `"${white.bold(row.title)}" scheduled for ${white.bold(row.sendAt.toISOString())}`
    );
    return { ok: true, row };
  }

  /** Rewrites a waiting one; one the scheduler already took is left alone. */
  public async update(id: number, input: PushScheduleInput, now = new Date()): Promise<ScheduleResult> {
    const existing = await this.prisma.pushSchedule.findUnique({ where: { id } });
    if (!existing) return { ok: false, status: 404, error: 'not_found', message: 'No such scheduled broadcast' };
    if (existing.status !== 'scheduled') return this.notScheduled(existing.status);
    const checked = validatePushInput(input, now);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error, message: checked.message };
    const { count } = await this.prisma.pushSchedule.updateMany({
      where: { id, status: 'scheduled' },
      data: checked.data,
    });
    const row = await this.prisma.pushSchedule.findUnique({ where: { id } });
    if (!count || !row) return this.notScheduled(row?.status ?? 'gone');
    this.log(`broadcast #${white.bold(id)} changed, now for ${white.bold(row.sendAt.toISOString())}`);
    return { ok: true, row };
  }

  public async cancel(id: number): Promise<ScheduleResult> {
    const { count } = await this.prisma.pushSchedule.updateMany({
      where: { id, status: 'scheduled' },
      data: { status: 'cancelled' },
    });
    const row = await this.prisma.pushSchedule.findUnique({ where: { id } });
    if (!row) return { ok: false, status: 404, error: 'not_found', message: 'No such scheduled broadcast' };
    if (!count) return this.notScheduled(row.status);
    this.log(`broadcast #${white.bold(id)} cancelled`, 'yellow');
    return { ok: true, row };
  }

  private notScheduled(status: string): ScheduleResult {
    return {
      ok: false,
      status: 409,
      error: 'not_scheduled',
      message: `This broadcast is ${status}, so it can no longer be changed`,
    };
  }

  /** One pass: send what is due, mark what is too late. */
  public async run(now = new Date()): Promise<RunCounts> {
    const counts: RunCounts = { sent: 0, missed: 0, failed: 0 };
    const locked = await this.cache.acquireLock(LOCK, 1800).catch(() => false);
    if (!locked) return counts;
    try {
      const due = await this.prisma.pushSchedule.findMany({
        where: { status: 'scheduled', sendAt: { lte: now } },
        orderBy: { sendAt: 'asc' },
      });
      for (const row of due) {
        const action = dueAction(row, now);
        if (action === 'missed') {
          if (await this.markMissed(row, now)) counts.missed++;
        } else if (action === 'send') {
          const outcome = await this.send(row);
          if (outcome === 'sent') counts.sent++;
          if (outcome === 'failed') counts.failed++;
        }
      }
    } finally {
      await this.cache.releaseLock(LOCK).catch(() => {});
    }
    return counts;
  }

  private async markMissed(row: PushScheduleRow, now: Date): Promise<boolean> {
    const minutes = Math.round((now.getTime() - row.sendAt.getTime()) / 60000);
    const { count } = await this.prisma.pushSchedule.updateMany({
      where: { id: row.id, status: 'scheduled' },
      data: { status: 'missed', error: `Not sent: the scheduler reached it ${minutes} minutes late` },
    });
    if (!count) return false;
    this.log(`broadcast #${white.bold(row.id)} "${white.bold(row.title)}" missed (${minutes} minutes late)`, 'red');
    await this.alert(row, `is niet verstuurd: de planner kwam ${minutes} minuten te laat`);
    return true;
  }

  private async send(row: PushScheduleRow): Promise<'sent' | 'failed' | 'skipped'> {
    const claimed = await this.prisma.pushSchedule.updateMany({
      where: { id: row.id, status: 'scheduled' },
      data: { status: 'sending' },
    });
    if (claimed.count !== 1) return 'skipped';

    const forcedDry = !row.dry && this.development();
    const dry = row.dry || forcedDry;
    if (forcedDry) this.log(`broadcast #${white.bold(row.id)}: development, sent as a dry run`, 'yellow');

    try {
      const pushMessageId = await Push.getInstance().broadcastNotification(row.title, row.message, row.test, dry);
      await this.prisma.pushSchedule.update({
        where: { id: row.id },
        data: { status: 'sent', sentAt: new Date(), pushMessageId: pushMessageId ?? null, dry },
      });
      this.log(
        `broadcast #${white.bold(row.id)} "${white.bold(row.title)}" sent` +
          ` (${row.test ? 'test' : 'live'}${dry ? ', dry' : ''}, push_messages #${white.bold(pushMessageId)})`,
        'green'
      );
      return 'sent';
    } catch (error) {
      const reason = (error as Error)?.message || String(error);
      await this.prisma.pushSchedule
        .update({ where: { id: row.id }, data: { status: 'failed', error: reason.slice(0, 2000) } })
        .catch(() => {});
      this.log(`broadcast #${white.bold(row.id)} failed: ${reason}`, 'red');
      await this.alert(row, `is mislukt: ${reason}`);
      return 'failed';
    }
  }

  private async alert(row: PushScheduleRow, what: string) {
    if (row.test || row.dry) return;
    await this.pushover
      .sendMessage(
        {
          title: '📣 Geplande push niet verstuurd',
          message: `Broadcast #${row.id} "${row.title}" (gepland ${row.sendAt.toISOString()}) ${what}.`,
          sound: 'falling',
        },
        ''
      )
      .catch(() => {});
  }
}

export default PushSchedule;
