import { describe, it, expect } from 'vitest';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
} from '../../src/auth';

// Low iteration count keeps PBKDF2 tests fast; the iteration parameter is
// part of the public API and production paths pass the stored count.
const FAST = 1000;

describe('password hashing', () => {
  it('generates unique 32-char hex salts', () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('verifies a correct password', () => {
    const salt = generateSalt();
    const hash = hashPassword('s3cret!', salt, FAST);
    expect(verifyPassword('s3cret!', hash, salt, FAST)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const salt = generateSalt();
    const hash = hashPassword('s3cret!', salt, FAST);
    expect(verifyPassword('not-it', hash, salt, FAST)).toBe(false);
  });

  it('rejects the right password with the wrong salt', () => {
    const hash = hashPassword('s3cret!', generateSalt(), FAST);
    expect(verifyPassword('s3cret!', hash, generateSalt(), FAST)).toBe(false);
  });

  it('produces different hashes for different iteration counts', () => {
    const salt = generateSalt();
    expect(hashPassword('pw', salt, 1000)).not.toBe(
      hashPassword('pw', salt, 2000)
    );
  });
});

describe('JWT tokens', () => {
  it('round-trips the full claim set', () => {
    const token = generateToken('user-123', ['users', 'admin'], 7, 42, 'Rick');
    const decoded = verifyToken(token);
    expect(decoded).toMatchObject({
      userId: 'user-123',
      userGroups: ['users', 'admin'],
      companyId: 7,
      id: 42,
      displayName: 'Rick',
    });
    // jsonwebtoken's '1y' is 365.25 days
    expect(decoded.exp - decoded.iat).toBe(365.25 * 24 * 3600);
  });

  it('defaults userGroups to empty', () => {
    const decoded = verifyToken(generateToken('u'));
    expect(decoded.userGroups).toEqual([]);
  });

  it('returns null for a tampered token', () => {
    const token = generateToken('user-123', ['users']);
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ userId: 'user-123', userGroups: ['admin'] })
    ).toString('base64url');
    expect(verifyToken(`${h}.${forged}.${s}`)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(verifyToken('')).toBeNull();
    expect(verifyToken('not.a.jwt')).toBeNull();
  });
});
