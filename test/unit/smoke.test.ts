import { describe, it, expect } from 'vitest';

describe('test harness', () => {
  it('runs with the test environment', () => {
    expect(process.env['ENVIRONMENT']).toBe('test');
    expect(process.env['DATABASE_URL']).toContain('/qrhit_test');
    expect(process.env['REDIS_DB']).toBe('9');
  });
});
