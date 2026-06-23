import { describe, it, expect, afterEach } from 'vitest';
import Utils from '../../src/utils';

const utils = new Utils();

describe('cleanTrackName', () => {
  it('strips " - Remastered"-style suffixes', () => {
    expect(utils.cleanTrackName('Hotel California - 2013 Remaster')).toBe(
      'Hotel California'
    );
  });

  it('strips (feat. ...) credits', () => {
    expect(utils.cleanTrackName('Song (feat. Someone Else)')).toBe('Song');
  });

  it('strips video and lyric tags', () => {
    expect(utils.cleanTrackName('Track (Official Video)')).toBe('Track');
    expect(utils.cleanTrackName('Track (Official Music Video)')).toBe('Track');
    expect(utils.cleanTrackName('Track (Lyrics)')).toBe('Track');
    expect(utils.cleanTrackName('Track (Official Audio)')).toBe('Track');
  });

  it('collapses whitespace left by removals', () => {
    expect(utils.cleanTrackName('A  (Lyrics)  B')).toBe('A B');
  });

  it('caps titles at 70 chars with ellipsis', () => {
    const long = 'x'.repeat(100);
    const cleaned = utils.cleanTrackName(long);
    expect(cleaned.length).toBe(70);
    expect(cleaned.endsWith('...')).toBe(true);
  });

  it('leaves normal titles untouched', () => {
    expect(utils.cleanTrackName('Bohemian Rhapsody')).toBe('Bohemian Rhapsody');
  });
});

describe('getClientIp', () => {
  it('prefers request.clientIp (ipPlugin)', () => {
    expect(
      utils.getClientIp({
        clientIp: '1.1.1.1',
        headers: { 'x-forwarded-for': '2.2.2.2' },
      })
    ).toBe('1.1.1.1');
  });

  it('falls back to cf-connecting-ip, then first XFF hop, then socket', () => {
    expect(
      utils.getClientIp({ headers: { 'cf-connecting-ip': '3.3.3.3' } })
    ).toBe('3.3.3.3');
    expect(
      utils.getClientIp({
        headers: { 'x-forwarded-for': '4.4.4.4, 10.0.0.1' },
      })
    ).toBe('4.4.4.4');
    expect(
      utils.getClientIp({ headers: {}, socket: { remoteAddress: '5.5.5.5' } })
    ).toBe('5.5.5.5');
    expect(utils.getClientIp({})).toBe('');
  });
});

describe('resolveTrustedClientIp', () => {
  it('uses CloudFront-Viewer-Address over spoofable XFF', () => {
    expect(
      utils.resolveTrustedClientIp({
        headers: {
          'cloudfront-viewer-address': '6.6.6.6:51234',
          'x-forwarded-for': 'spoofed',
        },
      })
    ).toBe('6.6.6.6');
  });

  it('handles bracketed IPv6 with port', () => {
    expect(
      utils.resolveTrustedClientIp({
        headers: { 'cloudfront-viewer-address': '[2001:db8::1]:443' },
      })
    ).toBe('2001:db8::1');
  });

  it('falls back to getClientIp without the CloudFront header', () => {
    expect(
      utils.resolveTrustedClientIp({
        headers: { 'x-forwarded-for': '7.7.7.7' },
      })
    ).toBe('7.7.7.7');
  });
});

describe('trusted IP / email lists', () => {
  const origIps = process.env['TRUSTED_IPS'];
  const origEmails = process.env['TRUSTED_EMAILS'];

  afterEach(() => {
    process.env['TRUSTED_IPS'] = origIps;
    process.env['TRUSTED_EMAILS'] = origEmails;
  });

  it('matches exact entries from the comma-separated env lists', () => {
    process.env['TRUSTED_IPS'] = '1.2.3.4,5.6.7.8';
    process.env['TRUSTED_EMAILS'] = 'a@b.com';
    expect(utils.isTrustedIp('5.6.7.8')).toBe(true);
    expect(utils.isTrustedIp('9.9.9.9')).toBe(false);
    expect(utils.isTrustedEmail('a@b.com')).toBe(true);
    expect(utils.isTrustedEmail('x@y.com')).toBe(false);
  });

  it('treats unset lists as nothing trusted', () => {
    delete process.env['TRUSTED_IPS'];
    delete process.env['TRUSTED_EMAILS'];
    expect(utils.isTrustedIp('1.2.3.4')).toBe(false);
    expect(utils.isTrustedEmail('a@b.com')).toBe(false);
  });
});

describe('parseAcceptLanguage', () => {
  it('returns the primary subtag of the best supported language', () => {
    expect(utils.parseAcceptLanguage('nl-NL,nl;q=0.9,en;q=0.8')).toBe('nl');
  });

  it('falls back to en for unsupported or empty headers', () => {
    expect(utils.parseAcceptLanguage('zz-ZZ')).toBe('en');
    expect(utils.parseAcceptLanguage('')).toBe('en');
  });
});
