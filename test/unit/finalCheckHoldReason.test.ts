import { describe, it, expect } from 'vitest';
import { finalCheckHoldReason } from '../../src/finalCheckHoldReason';
import type {
  FinalCheckFlaggedImage,
  FinalCheckResult,
} from '../../src/finalCheck';

type Failure = Extract<FinalCheckResult, { ok: false }>;

function failure(overrides: Partial<Failure>): Failure {
  return {
    ok: false,
    reason: 'hitster',
    userActionable: true,
    details: '',
    paymentHasPlaylistId: 1,
    playlistDbId: 2,
    playlistId: 'pl',
    ...overrides,
  };
}

function flagged(...keys: FinalCheckFlaggedImage['key'][]) {
  return keys.map((key) => ({
    key,
    filename: `${key}.png`,
    buffer: Buffer.from(''),
  }));
}

describe('finalCheckHoldReason()', () => {
  it('passes the non-Hitster reasons through', () => {
    for (const reason of ['unreadable', 'pdf-missing', 'design-mismatch'] as const) {
      expect(finalCheckHoldReason(failure({ reason }))).toBe(reason);
    }
  });

  it('names the flagged side of a visual Hitster hit', () => {
    expect(
      finalCheckHoldReason(failure({ flaggedImages: flagged('cardBack') }))
    ).toBe('hitster-card');
    expect(
      finalCheckHoldReason(
        failure({ flaggedImages: flagged('boxFront', 'boxBack') })
      )
    ).toBe('hitster-box');
    expect(
      finalCheckHoldReason(
        failure({
          flaggedImages: flagged('cardFront', 'boxBack'),
          // both flagged sends the customer to the card tab
          correctionTab: 'card',
        })
      )
    ).toBe('hitster-card-box');
  });

  it('falls back to the correction tab for a textual Hitster hit', () => {
    expect(finalCheckHoldReason(failure({ correctionTab: 'box' }))).toBe(
      'hitster-box'
    );
    expect(finalCheckHoldReason(failure({ correctionTab: 'card' }))).toBe(
      'hitster-card'
    );
    expect(finalCheckHoldReason(failure({}))).toBe('hitster-card');
  });
});
