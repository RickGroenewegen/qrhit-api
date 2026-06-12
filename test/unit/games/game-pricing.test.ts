import { describe, it, expect } from 'vitest';
import {
  calculateGamesUpgradePrice,
  QRGAMES_UPGRADE_PRICE,
  QRGAMES_DISCOUNT_TIERS,
} from '../../../src/game';

describe('calculateGamesUpgradePrice', () => {
  it('charges full price for a single playlist', () => {
    expect(calculateGamesUpgradePrice(1)).toEqual({
      pricePerPlaylist: 5.0,
      totalPrice: 5.0,
      originalTotal: 5.0,
      discount: 0,
      savings: 0,
    });
  });

  it('applies 10% off for 2 playlists', () => {
    expect(calculateGamesUpgradePrice(2)).toEqual({
      pricePerPlaylist: 4.5,
      totalPrice: 9.0,
      originalTotal: 10.0,
      discount: 10,
      savings: 1.0,
    });
  });

  it('applies 20% off for 3 playlists', () => {
    expect(calculateGamesUpgradePrice(3)).toEqual({
      pricePerPlaylist: 4.0,
      totalPrice: 12.0,
      originalTotal: 15.0,
      discount: 20,
      savings: 3.0,
    });
  });

  it('applies 30% off for 4 playlists', () => {
    expect(calculateGamesUpgradePrice(4)).toEqual({
      pricePerPlaylist: 3.5,
      totalPrice: 14.0,
      originalTotal: 20.0,
      discount: 30,
      savings: 6.0,
    });
  });

  it('keeps the 30% tier for large quantities (tiers are a cap, not progressive)', () => {
    const result = calculateGamesUpgradePrice(10);
    expect(result.discount).toBe(30);
    expect(result.pricePerPlaylist).toBe(3.5);
    expect(result.totalPrice).toBe(35.0);
    expect(result.savings).toBe(15.0);
  });

  it('rounds all monetary values to 2 decimals', () => {
    const result = calculateGamesUpgradePrice(7);
    for (const value of [
      result.pricePerPlaylist,
      result.totalPrice,
      result.originalTotal,
      result.savings,
    ]) {
      expect(Math.round(value * 100) / 100).toBe(value);
    }
  });

  it('exports the base price and descending discount tiers', () => {
    expect(QRGAMES_UPGRADE_PRICE).toBe(5.0);
    // Tier matching breaks on first hit, so tiers must be ordered by
    // minCount descending or lower tiers would shadow higher ones.
    const minCounts = QRGAMES_DISCOUNT_TIERS.map((t) => t.minCount);
    expect(minCounts).toEqual([...minCounts].sort((a, b) => b - a));
  });

  it('zero quantity yields zero totals without discount', () => {
    expect(calculateGamesUpgradePrice(0)).toEqual({
      pricePerPlaylist: 5.0,
      totalPrice: 0,
      originalTotal: 0,
      discount: 0,
      savings: 0,
    });
  });
});
