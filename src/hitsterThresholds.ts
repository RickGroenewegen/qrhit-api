/**
 * The scores at which the Hitster detector's verdict counts. Two, because a
 * wrong warning in the designer costs a customer a second look, while a wrong
 * hit in finalCheck puts a paid order on hold (Rick, 2026-10-07).
 *
 * Measured on the v3 model's test set (93 Hitster pictures, 541 clean ones;
 * an order line carries 1.8 pictures on average):
 *   0.5  catches 95%, holds about 1.7% of clean orders for nothing
 *   0.7  catches 91%, about 1.0%
 *   0.8  catches 88%, about 0.3% (one wrong picture in the test set)
 */

function fromEnv(name: string, fallback: number): number {
  const value = parseFloat(process.env[name] || '');
  return value > 0 && value < 1 ? value : fallback;
}

/** The designer's warning (POST /designer/screen): HITSTER_THRESHOLD, default 0.5. */
export function hitsterThreshold(): number {
  return fromEnv('HITSTER_THRESHOLD', 0.5);
}

/** finalCheck's hold: HITSTER_HOLD_THRESHOLD, default 0.7. */
export function hitsterHoldThreshold(): number {
  return fromEnv('HITSTER_HOLD_THRESHOLD', 0.7);
}
