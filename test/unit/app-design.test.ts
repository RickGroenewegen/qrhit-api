import { describe, it, expect } from 'vitest';

/**
 * Unit tests for the pure helpers in src/appDesign.ts (the CSS variable
 * whitelist/grammar, help-text sanitizing, customer slugs, asset checks, the
 * server-built font block) and for the scan-time precedence in
 * src/apptheme.ts.
 */

import {
  APP_BUNDLED_BACKGROUND_URL,
  APP_THEME_VARIABLE_KEYS,
  validateCssVariables,
  sanitizeHelpText,
  sanitizeAssetFilename,
  isValidThemeSlug,
  newCustomerSlug,
  parseCustomerSlug,
  servedCustomerSlug,
  scopeKeyFor,
  fontsForId,
  appDesignLineError,
} from '../../src/appDesign';
import { resolveLineTheme } from '../../src/apptheme';

describe('appDesignLineError (who may design an order line)', () => {
  const line = (over: { userId?: number; status?: string; type?: string | null } = {}) => ({
    payment: { userId: over.userId ?? 7, status: over.status ?? 'paid' },
    playlist: { type: over.type === undefined ? 'cards' : over.type },
  });

  it("lets the customer design their own paid card line", () => {
    expect(appDesignLineError(line(), 7)).toBeNull();
  });

  it("refuses another customer's line", () => {
    expect(appDesignLineError(line(), 8)).toEqual({ status: 403, error: 'Unauthorized' });
  });

  it('lets an admin (no requester) design any customer line', () => {
    expect(appDesignLineError(line({ userId: 8 }), null)).toBeNull();
  });

  it('404s a missing line for customers and admins alike', () => {
    expect(appDesignLineError(null, 7)?.status).toBe(404);
    expect(appDesignLineError(null, null)?.status).toBe(404);
  });

  it('keeps the paid card order rule for admins too', () => {
    for (const requester of [7, null]) {
      expect(appDesignLineError(line({ status: 'open' }), requester)?.status).toBe(400);
      expect(appDesignLineError(line({ type: 'giftcard' }), requester)?.status).toBe(400);
    }
  });

  it('checks ownership before the order rule, so a stranger learns nothing about the order', () => {
    expect(appDesignLineError(line({ status: 'open' }), 8)?.status).toBe(403);
  });
});

describe('validateCssVariables', () => {
  it('keeps known keys with plain colors', () => {
    const { cssVariables, rejected } = validateCssVariables({
      '--app-text-color': '#feefe5',
      '--app-button-background': 'rgba(254, 239, 229, 0.16)',
      '--app-scan-button-background': '#F79677',
    });
    expect(rejected).toEqual([]);
    expect(cssVariables['--app-text-color']).toBe('#feefe5');
    expect(cssVariables['--app-button-background']).toBe('rgba(254, 239, 229, 0.16)');
  });

  it('accepts gradients for background keys only', () => {
    const grad = 'linear-gradient(135deg, #18565e, #0b2c31)';
    const ok = validateCssVariables({
      '--app-background': grad,
      '--app-modal-content-background': grad,
      '--app-vinyl-gradient':
        'radial-gradient(circle at 30% 30%, #2f2f2f 40%, #1d1d1d 70%, #101010 100%)',
    });
    expect(ok.rejected).toEqual([]);
    const bad = validateCssVariables({ '--app-text-color': grad });
    expect(bad.rejected).toEqual(['--app-text-color']);
  });

  it('drops unknown keys and anything that smells like an injection', () => {
    const { cssVariables, rejected } = validateCssVariables({
      '--app-background': 'url(https://evil.example/x.png)',
      '--app-text-color': '#fff; background: url(x)',
      '--not-ours': '#fff',
      'color': 'red',
      '--app-logo-filter': 'brightness(1.1) contrast(1.05)',
    });
    expect(Object.keys(cssVariables)).toEqual(['--app-logo-filter']);
    expect(rejected).toEqual(
      expect.arrayContaining(['--app-background', '--app-text-color', '--not-ours', 'color'])
    );
  });

  it('accepts the photo bundled in the app, in exactly the built-in theme\'s form', () => {
    const bundled = '#18565e url("assets/images/bg-disco.webp") center / cover no-repeat';
    expect(validateCssVariables({ '--app-background': bundled }).cssVariables).toEqual({
      '--app-background': bundled,
    });
    expect(APP_BUNDLED_BACKGROUND_URL).toBe('assets/images/bg-disco.webp');

    for (const value of [
      '#18565e url("https://evil.example/bg-disco.webp") center / cover no-repeat',
      '#18565e url("assets/images/other.webp") center / cover no-repeat',
      '#18565e url("assets/images/bg-disco.webp") center / cover no-repeat; color: red',
      'url("assets/images/bg-disco.webp")',
    ]) {
      expect(validateCssVariables({ '--app-background': value }).rejected).toEqual([
        '--app-background',
      ]);
    }
    // Only the page background may carry it.
    expect(
      validateCssVariables({ '--app-modal-content-background': bundled }).rejected
    ).toEqual(['--app-modal-content-background']);
  });

  it('accepts text shadows, offsets and font families', () => {
    const { rejected } = validateCssVariables({
      '--app-text-shadow': '1px 1px 2px rgba(0, 0, 0, 0.35)',
      '--app-musical-note-shadow': 'none',
      '--app-camera-icon-offset-y': '-12px',
      '--app-display-font-family': "'Bebas Neue', Arial, sans-serif",
    });
    expect(rejected).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateCssVariables(null).rejected).toEqual(['cssVariables']);
    expect(validateCssVariables('x').rejected).toEqual(['cssVariables']);
  });

  it('exposes the full key set the scan app reads', () => {
    expect(APP_THEME_VARIABLE_KEYS).toContain('--app-background');
    expect(APP_THEME_VARIABLE_KEYS).toContain('--app-scan-button-background');
    expect(APP_THEME_VARIABLE_KEYS.length).toBeGreaterThan(40);
  });
});

describe('sanitizeHelpText', () => {
  it('escapes plain text (designs saved before the editor) and wraps paragraphs', () => {
    const out = sanitizeHelpText('Hi & welcome\n\nSecond "para"\nline two');
    expect(out).toBe('<p>Hi &amp; welcome</p><p>Second &quot;para&quot;<br>line two</p>');
  });

  it('keeps the formats the editor offers, as the app styles them', () => {
    const html =
      '<h2>Welcome</h2><p><strong>Scan</strong> a card, <em>guess</em> the <u>year</u>.</p>' +
      '<ol><li>One</li></ol><ul><li>Two</li></ul><h3>More</h3>';
    expect(sanitizeHelpText(html)).toBe(html);
  });

  it('opens links outside the app and drops unsafe ones', () => {
    expect(sanitizeHelpText('<p><a href="https://qrsong.io">site</a></p>')).toBe(
      '<p><a href="https://qrsong.io" target="_blank" rel="noopener noreferrer">site</a></p>'
    );
    expect(sanitizeHelpText('<p><a href="javascript:alert(1)">x</a></p>')).toBe(
      '<p><a target="_blank" rel="noopener noreferrer">x</a></p>'
    );
  });

  it('strips everything else: scripts, handlers, images, styles, classes', () => {
    const out = sanitizeHelpText(
      '<p class="ql-align-center" style="color:red" onclick="x()">Hi<script>alert(1)</script>' +
        '<img src="x" onerror="y()"><span>there</span></p>'
    );
    expect(out).toBe('<p>Hithere</p>');
  });

  it('maps other headings and tags onto the allowed ones', () => {
    expect(sanitizeHelpText('<h1>A</h1><h4>B</h4><b>C</b><i>D</i><div>E</div>')).toBe(
      '<h2>A</h2><h3>B</h3><strong>C</strong><em>D</em><p>E</p>'
    );
  });

  it('turns the non-breaking spaces Quill writes back into spaces and trims empty lines', () => {
    expect(sanitizeHelpText('<p><br></p><p>Scan&nbsp;a&nbsp;card</p><p><br></p><p></p>')).toBe(
      '<p>Scan a card</p>'
    );
    expect(sanitizeHelpText('<p><br></p>')).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(sanitizeHelpText('   ')).toBeNull();
    expect(sanitizeHelpText(undefined)).toBeNull();
    expect(sanitizeHelpText(42)).toBeNull();
  });
});

describe('slugs and asset names', () => {
  it('makes random customer slugs that the theme route accepts', () => {
    const a = newCustomerSlug();
    const b = newCustomerSlug();
    expect(a).toMatch(/^c[a-z0-9]{10}$/);
    expect(a).not.toBe(b);
    expect(isValidThemeSlug(a)).toBe(true);
    expect(isValidThemeSlug(servedCustomerSlug(a, 12))).toBe(true);
    expect(isValidThemeSlug('acme')).toBe(true);
  });

  it('puts the version in the served slug and reads it back', () => {
    expect(servedCustomerSlug('cabcdefghij', 3)).toBe('cabcdefghij-3');
    expect(parseCustomerSlug('cabcdefghij-3')).toEqual({ base: 'cabcdefghij', version: 3 });
    expect(parseCustomerSlug('cabcdefghij')).toEqual({ base: 'cabcdefghij', version: null });
  });

  it('never mistakes a hand-made theme slug for a customer one', () => {
    for (const slug of ['acme', 'ahaieee', 'cannock', 'default', 'derby', 'gebo', 'cannock-2']) {
      expect(parseCustomerSlug(slug)).toBeNull();
    }
  });

  it('keys the account default and each playlist override apart', () => {
    expect(scopeKeyFor({ userId: 7 })).toBe('u7');
    expect(scopeKeyFor({ userId: 7, paymentHasPlaylistId: 42 })).toBe('p42');
  });

  it('refuses slugs that could escape the theme directory', () => {
    expect(isValidThemeSlug('../etc')).toBe(false);
    expect(isValidThemeSlug('a/b')).toBe(false);
    expect(isValidThemeSlug('')).toBe(false);
    expect(isValidThemeSlug(null)).toBe(false);
  });

  it('only accepts bare upload filenames', () => {
    expect(sanitizeAssetFilename('abcdefgh12345678abcdefgh12345678.png')).toBe(
      'abcdefgh12345678abcdefgh12345678.png'
    );
    expect(sanitizeAssetFilename('../x.png')).toBeNull();
    expect(sanitizeAssetFilename('short.png')).toBeNull();
    expect(sanitizeAssetFilename('abcdefgh12345678abcdefgh12345678.svg')).toBeNull();
    expect(sanitizeAssetFilename(null)).toBeNull();
  });
});

describe('fontsForId', () => {
  it('builds a Google Fonts css2 URL for a known font', () => {
    const fonts = fontsForId('Bebas Neue');
    expect(fonts.family).toContain('Bebas Neue');
    expect(fonts.url).toBe(
      'https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&display=swap'
    );
  });

  it('falls back to the system stack for unknown ids and "system"', () => {
    expect(fontsForId('system').url).toBeNull();
    expect(fontsForId('Not A Font').url).toBeNull();
    expect(fontsForId(undefined).family).toContain('system-ui');
  });
});

describe('resolveLineTheme (which theme a scanned card gets)', () => {
  const entitled = { entitledUserId: 7 };
  const withDefault = { dfSlug: 'cdefault000', dfVersion: 4, dfName: 'Party', dfHasTheme: 1 };
  const withOwn = { ovMode: 'custom', ovSlug: 'cplaylist00', ovVersion: 2, ovName: 'Wedding', ovHasTheme: 1 };

  it('gives an admin-assigned B2B theme precedence over everything', () => {
    expect(
      resolveLineTheme({ theme: 'acme', themeName: 'Acme', ...entitled, ...withDefault, ...withOwn })
    ).toEqual({ s: 'acme', n: 'Acme' });
  });

  it('serves nothing before the account owns the upgrade', () => {
    expect(resolveLineTheme({ entitledUserId: null, ...withDefault, ...withOwn })).toEqual({
      s: '',
      n: '',
    });
  });

  it("uses the playlist's own design, then the account default", () => {
    expect(resolveLineTheme({ ...entitled, ...withDefault, ...withOwn })).toEqual({
      s: 'cplaylist00-2',
      n: 'Wedding',
    });
    expect(resolveLineTheme({ ...entitled, ...withDefault, ovMode: 'default' })).toEqual({
      s: 'cdefault000-4',
      n: 'Party',
    });
    expect(resolveLineTheme({ ...entitled, ...withDefault })).toEqual({
      s: 'cdefault000-4',
      n: 'Party',
    });
  });

  it('shows the plain app for a playlist set to standard', () => {
    expect(
      resolveLineTheme({ ...entitled, ...withDefault, ovMode: 'standard', ovSlug: 'cplaylist00' })
    ).toEqual({ s: '', n: '' });
  });

  it('reads BigInt flags and versions from MySQL', () => {
    expect(
      resolveLineTheme({
        entitledUserId: BigInt(7),
        dfSlug: 'cdefault000',
        dfVersion: BigInt(9),
        dfName: 'Party',
        dfHasTheme: BigInt(1),
      })
    ).toEqual({ s: 'cdefault000-9', n: 'Party' });
  });

  it('skips a default that was never saved', () => {
    expect(resolveLineTheme({ ...entitled, dfSlug: 'cdefault000', dfVersion: 1, dfHasTheme: 0 })).toEqual({
      s: '',
      n: '',
    });
  });
});
