import { describe, it, expect, beforeAll } from 'vitest';
import { chatToken, isChatToken, parseChatId } from '../../src/chatToken';

/**
 * The secret that goes with a chat id: the id is a counted number, so the
 * socket and the chat routes ask for the token too.
 */
beforeAll(() => {
  process.env['JWT_SECRET'] = 'test-secret';
});

describe('chatToken', () => {
  it('is 64 hex characters, the same for one chat and different per chat', () => {
    expect(chatToken(7)).toMatch(/^[0-9a-f]{64}$/);
    expect(chatToken(7)).toBe(chatToken(7));
    expect(chatToken(7)).not.toBe(chatToken(8));
  });

  it('accepts only the chat\'s own token', () => {
    expect(isChatToken(7, chatToken(7))).toBe(true);
    expect(isChatToken(8, chatToken(7))).toBe(false);
  });

  it('refuses anything that is not a token', () => {
    for (const value of [undefined, null, '', 'abc', 7, { startsWith: 'a' }, ['a'], chatToken(7).toUpperCase()]) {
      expect(isChatToken(7, value)).toBe(false);
    }
  });
});

describe('parseChatId', () => {
  it('reads a positive whole number, as a number or as digits', () => {
    expect(parseChatId(42)).toBe(42);
    expect(parseChatId('42')).toBe(42);
  });

  it('refuses objects and everything else', () => {
    for (const value of [undefined, null, '', 0, -1, 1.5, '4a', '1e3', { gt: 0 }, [1], true, NaN]) {
      expect(parseChatId(value)).toBeNull();
    }
  });
});
