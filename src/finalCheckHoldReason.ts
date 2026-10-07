import type { FinalCheckProblem, FinalCheckResult } from './finalCheck';

/**
 * What Payment.printerHoldDetails holds next to the short reason code: the
 * order line the check stopped on, how many designs it alternates, and every
 * problem pinned to its design and side. The dashboard lists them under the
 * hold pill and marks the designs in the line's design overview.
 */
export interface FinalCheckHoldDetails {
  reason: Extract<FinalCheckResult, { ok: false }>['reason'];
  paymentHasPlaylistId: number;
  designCount: number;
  problems: FinalCheckProblem[];
  details: string;
  checkedAt: string;
}

export function finalCheckHoldDetails(
  check: Extract<FinalCheckResult, { ok: false }>
): FinalCheckHoldDetails {
  return {
    reason: check.reason,
    paymentHasPlaylistId: check.paymentHasPlaylistId,
    designCount: check.designCount,
    problems: check.problems,
    details: check.details,
    checkedAt: new Date().toISOString(),
  };
}

// Short code stored in Payment.printerHoldReason when a failed finalCheck puts
// the order on hold; the admin dashboard turns it into a status pill. Kept out
// of finalCheck.ts so it can be used without loading the checker itself.
export type FinalCheckHoldReason =
  | 'hitster-card'
  | 'hitster-box'
  | 'hitster-card-box'
  | 'unreadable'
  | 'pdf-missing'
  | 'design-mismatch'
  | 'picture-unchecked';

export function finalCheckHoldReason(
  check: Extract<FinalCheckResult, { ok: false }>
): FinalCheckHoldReason {
  if (check.reason !== 'hitster') return check.reason;

  // A visual hit names the flagged pages, a textual hit only its tab
  const keys = (check.flaggedImages || []).map((image) => image.key);
  const card =
    keys.some((key) => key === 'cardFront' || key === 'cardBack') ||
    (keys.length === 0 && check.correctionTab !== 'box');
  const box =
    keys.some((key) => key === 'boxFront' || key === 'boxBack') ||
    (keys.length === 0 && check.correctionTab === 'box');

  if (card && box) return 'hitster-card-box';
  return box ? 'hitster-box' : 'hitster-card';
}
