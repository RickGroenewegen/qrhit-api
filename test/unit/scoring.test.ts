import { describe, it, expect } from 'vitest';
import { calculateWilsonScore } from '../../src/data/scoring';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

describe('calculateWilsonScore', () => {
  it('returns an integer between 0 and 100', () => {
    for (const [downloads, age] of [
      [0, 0],
      [1, 1],
      [1000, 30],
      [5, 2000],
    ] as const) {
      const score = calculateWilsonScore(downloads, daysAgo(age));
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('scores more downloads higher at equal age', () => {
    const few = calculateWilsonScore(1, daysAgo(10));
    const many = calculateWilsonScore(1000, daysAgo(10));
    expect(many).toBeGreaterThan(few);
  });

  it('decays with age at equal downloads (1-year half-life)', () => {
    const fresh = calculateWilsonScore(500, daysAgo(1));
    const yearOld = calculateWilsonScore(500, daysAgo(366));
    const twoYearsOld = calculateWilsonScore(500, daysAgo(731));
    expect(fresh).toBeGreaterThan(yearOld);
    expect(yearOld).toBeGreaterThan(twoYearsOld);
    // Half-life sanity: one year ≈ 61% (e^-0.5), not a cliff to zero.
    expect(yearOld).toBeGreaterThan(0);
  });

  it('treats zero downloads as one (no division by zero)', () => {
    expect(calculateWilsonScore(0, daysAgo(1))).toBe(
      calculateWilsonScore(1, daysAgo(1))
    );
  });
});
