import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  setAuthCookie,
  clearAuthCookie,
  getTokenFromRequest,
} from '../../src/cookieAuth';

const origEnv = process.env['ENVIRONMENT'];

afterEach(() => {
  process.env['ENVIRONMENT'] = origEnv;
});

describe('setAuthCookie', () => {
  it('sets a lax, non-secure cookie outside production', () => {
    process.env['ENVIRONMENT'] = 'development';
    const reply = { setCookie: vi.fn() };
    setAuthCookie(reply, 'tok-123');
    expect(reply.setCookie).toHaveBeenCalledWith('qrhit_auth', 'tok-123', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
    });
  });

  it('sets a secure, sameSite=lax cookie in production', () => {
    process.env['ENVIRONMENT'] = 'production';
    const reply = { setCookie: vi.fn() };
    setAuthCookie(reply, 'tok-456');
    expect(reply.setCookie).toHaveBeenCalledWith(
      'qrhit_auth',
      'tok-456',
      expect.objectContaining({ secure: true, sameSite: 'lax' })
    );
  });
});

describe('clearAuthCookie', () => {
  it('clears the cookie with matching attributes (dev)', () => {
    process.env['ENVIRONMENT'] = 'test';
    const reply = { clearCookie: vi.fn() };
    clearAuthCookie(reply);
    expect(reply.clearCookie).toHaveBeenCalledWith('qrhit_auth', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('clears with secure/lax in production', () => {
    process.env['ENVIRONMENT'] = 'production';
    const reply = { clearCookie: vi.fn() };
    clearAuthCookie(reply);
    expect(reply.clearCookie).toHaveBeenCalledWith(
      'qrhit_auth',
      expect.objectContaining({ secure: true, sameSite: 'lax' })
    );
  });
});

describe('getTokenFromRequest', () => {
  it('prefers the Authorization Bearer header over the cookie', () => {
    const token = getTokenFromRequest({
      headers: { authorization: 'Bearer header-token' },
      cookies: { qrhit_auth: 'cookie-token' },
    });
    expect(token).toBe('header-token');
  });

  it('ignores non-Bearer authorization headers and falls back to cookie', () => {
    const token = getTokenFromRequest({
      headers: { authorization: 'Basic dXNlcjpwdw==' },
      cookies: { qrhit_auth: 'cookie-token' },
    });
    expect(token).toBe('cookie-token');
  });

  it('reads the qrhit_auth cookie when there is no header', () => {
    expect(
      getTokenFromRequest({ headers: {}, cookies: { qrhit_auth: 'c-tok' } })
    ).toBe('c-tok');
  });

  it('returns null when neither header nor cookie is present', () => {
    expect(getTokenFromRequest({ headers: {} })).toBeNull();
    expect(getTokenFromRequest({ headers: {}, cookies: {} })).toBeNull();
  });

  it('reads the cookie for requests from the site itself', () => {
    process.env['ENVIRONMENT'] = 'production';
    expect(
      getTokenFromRequest({
        headers: { origin: 'https://www.qrsong.io', 'sec-fetch-site': 'same-site' },
        cookies: { qrhit_auth: 'c-tok' },
      })
    ).toBe('c-tok');
  });

  it('ignores the cookie when another site started the request', () => {
    process.env['ENVIRONMENT'] = 'production';
    expect(
      getTokenFromRequest({
        headers: { 'sec-fetch-site': 'cross-site' },
        cookies: { qrhit_auth: 'c-tok' },
      })
    ).toBeNull();
  });

  it('ignores the cookie for a foreign Origin (browsers without Sec-Fetch-Site)', () => {
    process.env['ENVIRONMENT'] = 'production';
    expect(
      getTokenFromRequest({
        headers: { origin: 'https://evil.example' },
        cookies: { qrhit_auth: 'c-tok' },
      })
    ).toBeNull();
  });

  it('still accepts a Bearer header from another origin', () => {
    process.env['ENVIRONMENT'] = 'production';
    expect(
      getTokenFromRequest({
        headers: {
          origin: 'capacitor://localhost',
          'sec-fetch-site': 'cross-site',
          authorization: 'Bearer app-token',
        },
        cookies: { qrhit_auth: 'c-tok' },
      })
    ).toBe('app-token');
  });
});
