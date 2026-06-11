import { describe, it, expect } from 'vitest';
import Formatters from '../../src/formatters';

const { euroFormatter, currencyFormatter, dateFormatter, firstLetterUppercaseFormatter } =
  new Formatters().getFormatters();

describe('Formatters', () => {
  it('formats euros in Dutch locale', () => {
    const out = euroFormatter.format(1234.5);
    expect(out).toContain('€');
    expect(out).toContain('1.234,50');
  });

  it('formats arbitrary currencies', () => {
    expect(currencyFormatter('USD').format(10)).toMatch(/US\$\s?10,00/);
    expect(currencyFormatter().format(10)).toContain('€');
  });

  it('formats dates in Dutch', () => {
    expect(dateFormatter.format(new Date('2026-06-11T12:00:00Z'))).toBe(
      '11 juni 2026'
    );
  });

  it('uppercases the first letter only', () => {
    expect(firstLetterUppercaseFormatter('hallo wereld')).toBe('Hallo wereld');
    expect(firstLetterUppercaseFormatter('')).toBe('');
  });
});
