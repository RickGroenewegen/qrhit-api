/**
 * Scheduled broadcasts (src/pushSchedule.ts).
 *
 * The database is a small in-memory push_schedules table that answers the
 * service's queries; Push and Pushover are the global recording mocks
 * (test/setup.ts), so nothing is sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { outbound } from '../helpers/recording-mock';

const h = vi.hoisted(() => {
  const db = { rows: [] as any[], nextId: 1 };
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([field, condition]: [string, any]) => {
      const value = row[field];
      if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
        if ('in' in condition) return condition.in.includes(value);
        if ('notIn' in condition) return !condition.notIn.includes(value);
        if ('lte' in condition) return value <= condition.lte;
      }
      return value === condition;
    });
  const prisma = {
    pushSchedule: {
      findMany: vi.fn(async ({ where, orderBy, take }: any) => {
        let rows = db.rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
        if (orderBy?.sendAt) {
          const dir = orderBy.sendAt === 'asc' ? 1 : -1;
          rows.sort((a, b) => dir * (a.sendAt.getTime() - b.sendAt.getTime()));
        }
        if (take) rows = rows.slice(0, take);
        return rows;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = db.rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: db.nextId++, pushMessageId: null, sentAt: null, error: null, ...data };
        db.rows.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = db.rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = db.rows.filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
    },
  };
  return { db, prisma, locked: { value: true }, logs: [] as string[] };
});

vi.mock('../../src/prisma', () => ({ default: { getInstance: () => h.prisma } }));
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({ acquireLock: async () => h.locked.value, releaseLock: async () => {} }),
  },
}));
vi.mock('../../src/utils', () => ({
  default: class Utils {
    isMainServer = async () => false;
  },
}));
vi.mock('../../src/logger', () => ({
  default: class Logger {
    log = (message: string) => h.logs.push(message);
  },
}));

import PushSchedule, {
  dueAction,
  parseSendAt,
  validatePushInput,
  MAX_LATE_MS,
} from '../../src/pushSchedule';

const service = PushSchedule.getInstance();
const NOW = new Date('2026-11-19T09:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60 * 1000);
const valid = (over: Record<string, any> = {}) => ({
  title: 'Black Friday: 50% off digital cards',
  message: 'Use code BF2026 for 50% off digital cards.',
  sendAt: '2026-11-27T10:00:00+01:00',
  ...over,
});
const row = (over: Record<string, any> = {}) => {
  const r = {
    id: h.db.nextId++,
    name: null,
    title: 'Last day',
    message: 'Code BF2026 works until 23:59 tonight.',
    sendAt: minutes(-1),
    test: false,
    dry: false,
    status: 'scheduled',
    pushMessageId: null,
    sentAt: null,
    error: null,
    ...over,
  };
  h.db.rows.push(r);
  return r;
};

let environment: string | undefined;
beforeEach(() => {
  h.db.rows = [];
  h.db.nextId = 1;
  h.locked.value = true;
  h.logs.length = 0;
  outbound.reset();
  outbound.respondWith('Push', 'broadcastNotification', async () => 4321);
  environment = process.env['ENVIRONMENT'];
  process.env['ENVIRONMENT'] = 'test';
});
afterEach(() => {
  process.env['ENVIRONMENT'] = environment;
});

describe('parseSendAt', () => {
  it('takes ISO with Z or an offset, and epoch milliseconds', () => {
    expect(parseSendAt('2026-11-27T09:00:00Z')?.toISOString()).toBe('2026-11-27T09:00:00.000Z');
    expect(parseSendAt('2026-11-27T10:00+01:00')?.toISOString()).toBe('2026-11-27T09:00:00.000Z');
    expect(parseSendAt('2026-11-27T09:00:00.000Z')?.toISOString()).toBe('2026-11-27T09:00:00.000Z');
    expect(parseSendAt(Date.parse('2026-11-27T09:00:00Z'))?.toISOString()).toBe('2026-11-27T09:00:00.000Z');
  });

  it('refuses a time without a zone, and anything else', () => {
    expect(parseSendAt('2026-11-27T10:00')).toBeNull();
    expect(parseSendAt('2026-11-27 10:00')).toBeNull();
    expect(parseSendAt('tomorrow')).toBeNull();
    expect(parseSendAt('2026-13-45T10:00:00Z')).toBeNull();
    expect(parseSendAt(undefined)).toBeNull();
    expect(parseSendAt(NaN)).toBeNull();
  });
});

describe('validatePushInput', () => {
  it('accepts a good body, trims, and reads the flags as booleans', () => {
    const result = validatePushInput(valid({ title: '  Hi  ', name: ' ', test: '1', dry: 0 }), NOW);
    expect(result).toEqual({
      ok: true,
      data: {
        name: null,
        title: 'Hi',
        message: 'Use code BF2026 for 50% off digital cards.',
        sendAt: new Date('2026-11-27T09:00:00Z'),
        test: true,
        dry: false,
      },
    });
  });

  it('holds the dashboard limits: title 50, message 178', () => {
    expect(validatePushInput(valid({ title: 'x'.repeat(50) }), NOW).ok).toBe(true);
    expect(validatePushInput(valid({ title: 'x'.repeat(51) }), NOW)).toMatchObject({ error: 'title_too_long' });
    expect(validatePushInput(valid({ message: 'x'.repeat(178) }), NOW).ok).toBe(true);
    expect(validatePushInput(valid({ message: 'x'.repeat(179) }), NOW)).toMatchObject({ error: 'message_too_long' });
    expect(validatePushInput(valid({ title: '' }), NOW)).toMatchObject({ error: 'title_required' });
    expect(validatePushInput(valid({ message: '  ' }), NOW)).toMatchObject({ error: 'message_required' });
    expect(validatePushInput(valid({ name: 'x'.repeat(101) }), NOW)).toMatchObject({ error: 'name_too_long' });
  });

  it('wants the send time at least a minute ahead and at most 90 days', () => {
    expect(validatePushInput(valid({ sendAt: minutes(0.5).toISOString() }), NOW)).toMatchObject({
      error: 'send_at_past',
    });
    expect(validatePushInput(valid({ sendAt: minutes(1).toISOString() }), NOW).ok).toBe(true);
    expect(validatePushInput(valid({ sendAt: minutes(91 * 24 * 60).toISOString() }), NOW)).toMatchObject({
      error: 'send_at_too_far',
    });
    expect(validatePushInput(valid({ sendAt: '2026-11-27T10:00' }), NOW)).toMatchObject({
      error: 'send_at_invalid',
    });
  });
});

describe('dueAction', () => {
  it('waits, sends, or gives up after two hours', () => {
    expect(dueAction({ status: 'scheduled', sendAt: minutes(1) }, NOW)).toBe('wait');
    expect(dueAction({ status: 'scheduled', sendAt: NOW }, NOW)).toBe('send');
    expect(dueAction({ status: 'scheduled', sendAt: new Date(NOW.getTime() - MAX_LATE_MS) }, NOW)).toBe('send');
    expect(dueAction({ status: 'scheduled', sendAt: new Date(NOW.getTime() - MAX_LATE_MS - 1) }, NOW)).toBe(
      'missed'
    );
    expect(dueAction({ status: 'sending', sendAt: minutes(-1) }, NOW)).toBe('wait');
    expect(dueAction({ status: 'cancelled', sendAt: minutes(-1) }, NOW)).toBe('wait');
  });
});

describe('create, update, cancel', () => {
  it('stores a valid schedule and refuses a bad one with 400', async () => {
    const created = await service.create(valid({ name: 'Black Friday: start' }), NOW);
    expect(created).toMatchObject({ ok: true, row: { status: 'scheduled', name: 'Black Friday: start' } });
    const bad = await service.create(valid({ title: '' }), NOW);
    expect(bad).toMatchObject({ ok: false, status: 400, error: 'title_required' });
    expect(h.db.rows).toHaveLength(1);
  });

  it('edits a waiting one, but not one the scheduler took (409) or one that is gone (404)', async () => {
    const waiting = row({ sendAt: minutes(60) });
    const edited = await service.update(waiting.id, valid({ title: 'New title' }), NOW);
    expect(edited).toMatchObject({ ok: true, row: { title: 'New title', status: 'scheduled' } });

    const sent = row({ status: 'sent' });
    expect(await service.update(sent.id, valid(), NOW)).toMatchObject({ ok: false, status: 409 });
    expect(await service.update(999, valid(), NOW)).toMatchObject({ ok: false, status: 404 });
  });

  it('cancels a waiting one only', async () => {
    const waiting = row({ sendAt: minutes(60) });
    expect(await service.cancel(waiting.id)).toMatchObject({ ok: true, row: { status: 'cancelled' } });
    expect(await service.cancel(waiting.id)).toMatchObject({ ok: false, status: 409 });
    expect(await service.cancel(999)).toMatchObject({ ok: false, status: 404 });
  });

  it('lists waiting ones soonest first, then the rest newest first', async () => {
    const later = row({ sendAt: minutes(120) });
    const done = row({ status: 'sent', sendAt: minutes(-600) });
    const sooner = row({ sendAt: minutes(30) });
    const cancelled = row({ status: 'cancelled', sendAt: minutes(-60) });
    const ids = (await service.list()).map((r) => r.id);
    expect(ids).toEqual([sooner.id, later.id, cancelled.id, done.id]);
  });
});

describe('run', () => {
  it('sends a due row once and records the push_messages id', async () => {
    const due = row({ test: true });
    row({ sendAt: minutes(5) });
    expect(await service.run(NOW)).toEqual({ sent: 1, missed: 0, failed: 0 });

    const calls = outbound.calls('Push', 'broadcastNotification');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([due.title, due.message, true, false]);
    expect(h.db.rows[0]).toMatchObject({ status: 'sent', pushMessageId: 4321, dry: false });
    expect(h.db.rows[0].sentAt).toBeInstanceOf(Date);

    // The next minute finds nothing to send
    expect(await service.run(new Date(NOW.getTime() + 60000))).toEqual({ sent: 0, missed: 0, failed: 0 });
    expect(outbound.calls('Push', 'broadcastNotification')).toHaveLength(1);
  });

  it('skips a row another run claimed between the query and the claim', async () => {
    const due = row();
    h.prisma.pushSchedule.findMany.mockImplementationOnce(async () => {
      const copy = { ...due };
      due.status = 'sending';
      return [copy];
    });
    expect(await service.run(NOW)).toEqual({ sent: 0, missed: 0, failed: 0 });
    expect(outbound.calls('Push', 'broadcastNotification')).toHaveLength(0);
  });

  it('does nothing without the lock', async () => {
    row();
    h.locked.value = false;
    expect(await service.run(NOW)).toEqual({ sent: 0, missed: 0, failed: 0 });
    expect(outbound.calls('Push', 'broadcastNotification')).toHaveLength(0);
    expect(h.db.rows[0].status).toBe('scheduled');
  });

  it('marks one more than two hours late as missed, unsent, and tells Rick', async () => {
    row({ sendAt: new Date(NOW.getTime() - MAX_LATE_MS - 60000) });
    expect(await service.run(NOW)).toEqual({ sent: 0, missed: 1, failed: 0 });
    expect(outbound.calls('Push', 'broadcastNotification')).toHaveLength(0);
    expect(h.db.rows[0].status).toBe('missed');
    expect(h.db.rows[0].error).toMatch(/121 minutes late/);
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(1);
  });

  it('records a failed send with its reason', async () => {
    row();
    outbound.respondWith('Push', 'broadcastNotification', async () => {
      throw new Error('firebase down');
    });
    expect(await service.run(NOW)).toEqual({ sent: 0, missed: 0, failed: 1 });
    expect(h.db.rows[0]).toMatchObject({ status: 'failed', error: 'firebase down' });
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(1);
  });

  it('sends every broadcast as a dry run in development', async () => {
    process.env['ENVIRONMENT'] = 'development';
    row();
    expect(await service.run(NOW)).toEqual({ sent: 1, missed: 0, failed: 0 });
    expect(outbound.calls('Push', 'broadcastNotification')[0].args[3]).toBe(true);
    expect(h.db.rows[0]).toMatchObject({ status: 'sent', dry: true });
  });
});
