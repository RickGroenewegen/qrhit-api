/**
 * src/printers/printerWaiting.ts: when the hourly tracking poll records that
 * Print&Bind has an order on "Wachten", and the one Pushover it sends.
 * Prisma is an in-memory stub; Pushover stays on the global recording proxy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { outbound } from '../../helpers/recording-mock';
import {
  PRINTER_WAITING_GRACE_MS,
  PrinterWaiting,
  printerWaitingDecision,
  printerWaitingDetail,
} from '../../../src/printers/printerWaiting';

const prismaMock = vi.hoisted(() => ({
  payment: { update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));
vi.mock('../../../src/logger', () => ({
  default: class {
    log(_m: string) {}
  },
}));

const NOW = new Date('2026-10-30T10:15:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000);

const state = (over: Partial<Parameters<typeof printerWaitingDecision>[0]> = {}) => ({
  sentToPrinterAt: minutesAgo(60 * 24 * 24),
  printApiWaitingAt: null,
  printApiWaitingDetail: null,
  ...over,
});

describe('printerWaitingDetail', () => {
  it('joins the sub statuses Print&Bind reports', () => {
    expect(printerWaitingDetail(['Verwerkingscontrole', 'Bestanden'])).toBe(
      'Verwerkingscontrole, Bestanden'
    );
    expect(printerWaitingDetail('Antwoord klant')).toBe('Antwoord klant');
  });

  it('is null when there is none (v1, or an empty list)', () => {
    expect(printerWaitingDetail(null)).toBeNull();
    expect(printerWaitingDetail(undefined)).toBeNull();
    expect(printerWaitingDetail([])).toBeNull();
    expect(printerWaitingDetail(['', '  '])).toBeNull();
  });
});

describe('printerWaitingDecision', () => {
  it('starts the first time an order is seen on Wachten', () => {
    expect(printerWaitingDecision(state(), 'Wachten', 'Bestanden', NOW)).toBe('start');
  });

  it('starts on Wachten without a sub status too (v1)', () => {
    expect(printerWaitingDecision(state(), 'Wachten', null, NOW)).toBe('start');
  });

  it('leaves an order sent moments ago to the next poll (file processing)', () => {
    const fresh = state({ sentToPrinterAt: minutesAgo(5) });
    expect(printerWaitingDecision(fresh, 'Wachten', 'Bestandsverwerking', NOW)).toBe('none');
    const past = state({
      sentToPrinterAt: new Date(NOW.getTime() - PRINTER_WAITING_GRACE_MS),
    });
    expect(printerWaitingDecision(past, 'Wachten', 'Bestandsverwerking', NOW)).toBe('start');
  });

  it('never starts twice while the order stays on Wachten', () => {
    const waiting = state({
      printApiWaitingAt: minutesAgo(60),
      printApiWaitingDetail: 'Bestanden',
    });
    expect(printerWaitingDecision(waiting, 'Wachten', 'Bestanden', NOW)).toBe('none');
    // v1 knows no sub status: what v2 stored stays
    expect(printerWaitingDecision(waiting, 'Wachten', null, NOW)).toBe('none');
  });

  it('updates a changed sub status without starting again', () => {
    const waiting = state({
      printApiWaitingAt: minutesAgo(60),
      printApiWaitingDetail: 'Bestanden',
    });
    expect(printerWaitingDecision(waiting, 'Wachten', 'Antwoord klant', NOW)).toBe('update');
  });

  it('clears once Print&Bind moves the order on', () => {
    const waiting = state({ printApiWaitingAt: minutesAgo(60) });
    for (const status of ['In opdracht', 'In productie', 'Verzonden', 'Geannuleerd']) {
      expect(printerWaitingDecision(waiting, status, null, NOW)).toBe('clear');
    }
  });

  it('does nothing for an order that is not and was not waiting', () => {
    expect(printerWaitingDecision(state(), 'In productie', null, NOW)).toBe('none');
    expect(printerWaitingDecision(state(), undefined, null, NOW)).toBe('none');
  });
});

describe('PrinterWaiting.observe', () => {
  const waiting = new PrinterWaiting();
  const payment = {
    id: 9123,
    orderId: '100009123',
    printApiOrderId: '1514036',
    sentToPrinterAt: new Date('2026-10-06T18:53:05Z'),
    printApiWaitingAt: null,
    printApiWaitingDetail: null,
  };

  beforeEach(() => {
    outbound.reset();
    prismaMock.payment.update.mockReset().mockResolvedValue({});
    prismaMock.payment.updateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it('stores the waiting state and sends one Pushover with the order and what it waits for', async () => {
    await waiting.observe(payment, 'Wachten', ['Verwerkingscontrole', 'Bestanden'], NOW);

    expect(prismaMock.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 9123, printApiWaitingAt: null },
      data: { printApiWaitingAt: NOW, printApiWaitingDetail: 'Verwerkingscontrole, Bestanden' },
    });
    const pushes = outbound.calls('PushoverClient', 'sendMessage');
    expect(pushes).toHaveLength(1);
    const [message, , force] = pushes[0].args;
    expect(message.title).toBe('Print&Bind order waiting');
    expect(message.message).toContain('100009123');
    expect(message.message).toContain('1514036');
    expect(message.message).toContain('Verwerkingscontrole, Bestanden');
    expect(message.message).toContain('2026-10-06');
    expect(force).toBe(true);
  });

  it('sends nothing when another poll claimed the order first', async () => {
    prismaMock.payment.updateMany.mockResolvedValue({ count: 0 });
    await waiting.observe(payment, 'Wachten', null, NOW);
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('sends nothing again on later polls of the same wait', async () => {
    await waiting.observe(
      { ...payment, printApiWaitingAt: minutesAgo(60), printApiWaitingDetail: 'Bestanden' },
      'Wachten',
      ['Antwoord klant'],
      NOW
    );
    expect(prismaMock.payment.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: 9123 },
      data: { printApiWaitingDetail: 'Antwoord klant' },
    });
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('clears the state once the order moves on', async () => {
    await waiting.observe({ ...payment, printApiWaitingAt: minutesAgo(60) }, 'In productie', [], NOW);
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: 9123 },
      data: { printApiWaitingAt: null, printApiWaitingDetail: null },
    });
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('never throws into the poll', async () => {
    prismaMock.payment.updateMany.mockRejectedValue(new Error('db down'));
    await expect(waiting.observe(payment, 'Wachten', null, NOW)).resolves.toBeUndefined();
  });
});
