import fs from 'fs';
import { LEDGER_FILE, REPORTS_DIR } from './config';
import type { EnvName } from './types';

export type LedgerEvent =
  | 'placing'
  | 'placed'
  | 'deleted'
  | 'delete-failed'
  | 'verified'
  | 'not-cancelled'
  | 'orphan';

export interface LedgerEntry {
  at: string;
  runId: string;
  env: EnvName;
  /** the host the order went to; cleanup only looks there */
  baseUrl: string;
  caseId: string;
  reference: string | null;
  event: LedgerEvent;
  orderId?: string;
  status?: string | null;
  detail?: string;
}

/**
 * Append-only record of every order the harness tried to place, written
 * synchronously before and after each step, so a crash or Ctrl-C still
 * leaves the references `cleanup` needs.
 */
export function record(entry: Omit<LedgerEntry, 'at'>): void {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.appendFileSync(
    LEDGER_FILE,
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
  );
}

export function readLedger(): LedgerEntry[] {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  return fs
    .readFileSync(LEDGER_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}
