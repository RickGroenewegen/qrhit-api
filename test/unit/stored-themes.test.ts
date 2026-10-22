import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import StoredThemes, {
  checkThemeAsset,
  checkThemeManifest,
  parseStoredSlug,
  servedStoredTheme,
  StoredThemeError,
  StoredThemeVersion,
  storedSlugProblem,
} from '../../src/storedThemes';
import { resolveLineTheme, servedStoredSlug } from '../../src/apptheme';
import { validateCssVariables } from '../../src/appDesign';

/**
 * Scan-app themes stored as data (src/storedThemes.ts): which slugs may be
 * pushed, what a theme JSON may hold, and how a stored theme is served.
 */

const FOLDERS = path.join(__dirname, '../../src/_data/themes');

const theme = (over: Record<string, unknown> = {}) => ({
  id: 'ignored',
  name: 'Melkunie Breaker',
  version: 7,
  showRecord: false,
  cacheTTL: 86400,
  cssVariables: {
    '--app-background': '#492bf5',
    '--app-text-color': '#ffffff',
    '--app-text-shadow': '0 1px 2px rgba(17, 25, 77, 0.35)',
  },
  assets: { logo: null, background: null },
  fonts: { family: 'Nunito, system-ui, sans-serif', url: 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;700&display=swap' },
  helpText: "<h2>Welkom!</h2><p style='text-align: center; margin-top: 24px;'><em>Veel plezier</em></p>",
  ...over,
});

describe('stored theme slugs', () => {
  it('takes words joined by single hyphens, leaving room for the version', () => {
    for (const ok of ['arla-breaker', 'vanharen', '9x', 'a'.repeat(56)]) expect(storedSlugProblem(ok)).toBeNull();
    for (const bad of ['Arla', 'arla--breaker', '-arla', 'arla-', 'arla_breaker', '', 'a'.repeat(57)]) {
      expect(storedSlugProblem(bad)).toMatch(/1-56 characters/);
    }
  });

  it('refuses the built-in look and the App Designer slug shape', () => {
    expect(storedSlugProblem('default')).toMatch(/built-in/);
    expect(storedSlugProblem('cabcdefghij')).toMatch(/App Designer/);
  });

  it('reads the slug a scanned card carries back to the theme', () => {
    expect(servedStoredSlug('arla-breaker', 3)).toBe('arla-breaker--v3');
    expect(parseStoredSlug('arla-breaker--v3')).toEqual({ base: 'arla-breaker', version: 3 });
    expect(parseStoredSlug('arla-breaker')).toEqual({ base: 'arla-breaker', version: null });
    expect(parseStoredSlug('van-haren-2026')).toEqual({ base: 'van-haren-2026', version: null });
    expect(parseStoredSlug('arla--breaker--v3')).toBeNull();
    expect(parseStoredSlug('../etc')).toBeNull();
  });
});

describe('the scan map', () => {
  const stored = new Map([['arla-breaker', 2]]);

  it('gives a stored theme its versioned slug and leaves folder themes alone', () => {
    expect(resolveLineTheme({ theme: 'arla-breaker', themeName: 'Breaker' }, stored)).toEqual({ s: 'arla-breaker--v2', n: 'Breaker' });
    expect(resolveLineTheme({ theme: 'vanharen', themeName: 'Van Haren' }, stored)).toEqual({ s: 'vanharen', n: 'Van Haren' });
    expect(resolveLineTheme({ theme: 'vanharen' })).toEqual({ s: 'vanharen', n: 'vanharen' });
  });
});

describe('checkThemeManifest', () => {
  it('accepts every hand-made theme in src/_data/themes as it is', () => {
    const slugs = fs.readdirSync(FOLDERS).filter((s) => fs.existsSync(path.join(FOLDERS, s, `${s}.json`)));
    expect(slugs.length).toBeGreaterThanOrEqual(7);
    for (const slug of slugs) {
      const json = JSON.parse(fs.readFileSync(path.join(FOLDERS, slug, `${slug}.json`), 'utf8'));
      const { config, warnings } = checkThemeManifest(json);
      expect(config.cssVariables, slug).toEqual(json.cssVariables);
      expect(warnings.filter((w) => w.startsWith('the help text')), slug).toEqual([]);
      expect(config.name, slug).toBe(json.name);
    }
  });

  it('keeps the theme and leaves out what is set when it is served', () => {
    const { config, warnings } = checkThemeManifest(theme());
    expect(config).toEqual({
      name: 'Melkunie Breaker',
      showRecord: false,
      cacheTTL: 86400,
      cssVariables: theme().cssVariables,
      fonts: theme().fonts,
      helpText: '<h2>Welkom!</h2><p style="text-align:center;margin-top:24px"><em>Veel plezier</em></p>',
    });
    expect(warnings).toEqual([]);
  });

  it('names every problem at once', () => {
    let error: StoredThemeError | null = null;
    try {
      checkThemeManifest(
        theme({
          name: '',
          showRecord: 'no',
          cacheTTL: 5,
          cssVariables: { '--app-text-color': 'url(https://evil.example/x.png)', '--app-backgruond': '#000', color: 'red' },
          fonts: { family: 'Nunito', url: 'https://evil.example/font.css' },
        })
      );
    } catch (e: any) {
      error = e;
    }
    expect(error).toBeInstanceOf(StoredThemeError);
    const lines = error!.message.split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/"name" is required/),
        expect.stringMatching(/"showRecord" must be true or false/),
        expect.stringMatching(/"cacheTTL"/),
        expect.stringMatching(/--app-text-color .* is not a value the app accepts/),
        expect.stringMatching(/--app-backgruond/),
        expect.stringMatching(/"color" is not a variable the app reads/),
        expect.stringMatching(/fonts\.url must be a Google Fonts stylesheet/),
      ])
    );
  });

  it('cuts the help text down to what the app shows, and says so', () => {
    const { config, warnings } = checkThemeManifest(theme({ helpText: '<p>Hi<script>alert(1)</script></p><img src=x onerror=alert(1)>' }));
    expect(config.helpText).toBe('<p>Hi</p>');
    expect(warnings).toEqual([expect.stringMatching(/help text lost something/)]);
    expect(() => checkThemeManifest(theme({ helpText: '<p><br></p>' }))).toThrow(/no text the app can show/);
  });

  it('warns about fields that are not part of a theme', () => {
    expect(checkThemeManifest(theme({ colour: 'red' })).warnings).toEqual(['left out, not part of a theme: colour']);
  });
});

describe('theme values written by hand', () => {
  it('accepts unitless zero in shadows and a drop-shadow on the logo', () => {
    const { rejected } = validateCssVariables({
      '--app-musical-note-shadow': '0 0 8px rgba(242, 112, 34, 0.40)',
      '--app-text-shadow': '0 1px 2px rgba(255, 255, 255, 0.7)',
      '--app-logo-filter': 'drop-shadow(0 2px 4px rgba(80, 25, 0, 0.4))',
    });
    expect(rejected).toEqual([]);
    expect(validateCssVariables({ '--app-logo-filter': 'drop-shadow(0 2px 4px url(x))' }).rejected).toEqual(['--app-logo-filter']);
  });
});

describe('checkThemeAsset', () => {
  it('takes a PNG and names it by its content', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#00000000' } }).png().toBuffer();
    const name = await checkThemeAsset('logo', png);
    expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(await checkThemeAsset('logo', png)).toBe(name);
  });

  it('refuses anything else', async () => {
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    await expect(checkThemeAsset('background', jpeg)).rejects.toThrow(/must be a PNG/);
    await expect(checkThemeAsset('logo', Buffer.alloc(0))).rejects.toThrow(/empty/);
  });
});

describe('serving a stored theme', () => {
  const stored: StoredThemeVersion = {
    slug: 'arla-breaker',
    version: 3,
    name: 'Melkunie Breaker',
    config: checkThemeManifest(theme()).config,
    logo: 'a'.repeat(32) + '.png',
    background: null,
    note: null,
    createdBy: null,
    createdAt: new Date(),
  };

  it('looks like a folder theme, under the slug that was asked for', () => {
    const served = servedStoredTheme(stored, 'arla-breaker--v2', 'https://api.example.test');
    expect(served).toMatchObject({
      id: 'arla-breaker--v2',
      name: 'Melkunie Breaker',
      version: 3,
      source: 'business',
      showRecord: false,
      assets: { logo: 'https://api.example.test/theme/arla-breaker--v2/logo?v=3', background: null },
    });
  });

  it('falls back to the folders when the store cannot be read', async () => {
    const themes = StoredThemes.getInstance() as any;
    const prisma = themes.prisma;
    themes.prisma = { appThemeVersion: { findFirst: () => Promise.reject(new Error("Table 'app_theme_versions' doesn't exist")) } };
    try {
      expect(await themes.forServe('vanharen')).toBeNull();
    } finally {
      themes.prisma = prisma;
    }
  });
});
