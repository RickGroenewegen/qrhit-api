import { describe, it, expect } from 'vitest';

/**
 * Unit tests for the pure helpers in src/appDesign.ts: the CSS variable
 * whitelist/grammar, help-text sanitizing, slug and asset checks, and the
 * server-built font block.
 */

import {
  APP_THEME_VARIABLE_KEYS,
  validateCssVariables,
  sanitizeHelpText,
  sanitizeAssetFilename,
  isValidThemeSlug,
  slugForPaymentHasPlaylist,
  fontsForId,
} from '../../src/appDesign';

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
  it('escapes markup and wraps paragraphs', () => {
    const out = sanitizeHelpText('Hi <b>there</b>\n\nSecond "para"\nline two');
    expect(out).toBe(
      '<p>Hi &lt;b&gt;there&lt;/b&gt;</p><p>Second &quot;para&quot;<br>line two</p>'
    );
  });

  it('returns null for empty or non-string input', () => {
    expect(sanitizeHelpText('   ')).toBeNull();
    expect(sanitizeHelpText(undefined)).toBeNull();
    expect(sanitizeHelpText(42)).toBeNull();
  });
});

describe('slugs and asset names', () => {
  it('derives the slug from the order line id', () => {
    expect(slugForPaymentHasPlaylist(1234)).toBe('u1234');
    expect(isValidThemeSlug('u1234')).toBe(true);
    expect(isValidThemeSlug('acme')).toBe(true);
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
