import type { FinalCheckResult } from './finalCheck';

// Short code stored in Payment.printerHoldReason when a failed finalCheck puts
// the order on hold; the admin dashboard turns it into a status pill. Kept out
// of finalCheck.ts so it can be used without loading the checker itself.
export type FinalCheckHoldReason =
  | 'hitster-card'
  | 'hitster-box'
  | 'hitster-card-box'
  | 'unreadable'
  | 'pdf-missing'
  | 'design-mismatch';

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
