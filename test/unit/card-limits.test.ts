import { describe, it, expect } from 'vitest';
import {
  MAX_CARDS,
  MAX_CARDS_PHYSICAL,
  maxCardsFor,
  EXTRA_TRACK_TIERS,
} from '../../src/config/constants';
import Upgrade from '../../src/upgrade';

describe('card limit constants', () => {
  it('caps digital orders higher than physical ones', () => {
    expect(MAX_CARDS).toBe(3000);
    expect(MAX_CARDS_PHYSICAL).toBe(2000);
    expect(MAX_CARDS).toBeGreaterThan(MAX_CARDS_PHYSICAL);
  });

  it('maxCardsFor picks the cap for the order type', () => {
    expect(maxCardsFor(true)).toBe(MAX_CARDS);
    expect(maxCardsFor(false)).toBe(MAX_CARDS_PHYSICAL);
  });
});

describe('Upgrade track capacity', () => {
  const upgrade = Upgrade.getInstance();

  it('reports the room left under the physical cap', () => {
    expect(upgrade.remainingTrackCapacity({ numberOfTracks: 0 })).toBe(
      MAX_CARDS_PHYSICAL
    );
    expect(
      upgrade.remainingTrackCapacity({ numberOfTracks: MAX_CARDS_PHYSICAL - 30 })
    ).toBe(30);
  });

  it('never reports negative capacity for an over-cap playlist', () => {
    expect(
      upgrade.remainingTrackCapacity({ numberOfTracks: MAX_CARDS_PHYSICAL + 500 })
    ).toBe(0);
    expect(upgrade.remainingTrackCapacity(null)).toBe(MAX_CARDS_PHYSICAL);
  });

  it('offers only the tiers that still fit', () => {
    expect(upgrade.availableTrackTiers({ numberOfTracks: 0 })).toEqual([
      ...EXTRA_TRACK_TIERS,
    ]);
    expect(
      upgrade.availableTrackTiers({ numberOfTracks: MAX_CARDS_PHYSICAL - 25 })
    ).toEqual([10, 25]);
    expect(
      upgrade.availableTrackTiers({ numberOfTracks: MAX_CARDS_PHYSICAL })
    ).toEqual([]);
  });
});

// Extra cards bought after the order went to the printer were booked and
// never printed: the corrections page's tracks routes now answer
// orderInProduction once the payment has sentToPrinter.
describe('Upgrade tracksUpgradeClosed', () => {
  const upgrade = Upgrade.getInstance();

  it('closes once the order has gone to the printer', () => {
    expect(upgrade.tracksUpgradeClosed({ sentToPrinter: true })).toBe(true);
  });

  it('stays open before that, whatever is missing', () => {
    expect(upgrade.tracksUpgradeClosed({ sentToPrinter: false })).toBe(false);
    expect(upgrade.tracksUpgradeClosed({ sentToPrinter: null })).toBe(false);
    expect(upgrade.tracksUpgradeClosed({})).toBe(false);
    expect(upgrade.tracksUpgradeClosed(null)).toBe(false);
    expect(upgrade.tracksUpgradeClosed(undefined)).toBe(false);
  });
});
