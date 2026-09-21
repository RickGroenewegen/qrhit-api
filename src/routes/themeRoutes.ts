import { FastifyInstance } from 'fastify';
import AppTheme from '../apptheme';
import AppDesign, {
  isValidThemeSlug,
  parseCustomerSlug,
  ThemeSource,
} from '../appDesign';
import Logger from '../logger';
import fs from 'fs/promises';
import path from 'path';

/**
 * Themes for the scan app, from two directories with the same layout
 * (`<slug>/<slug>.json` plus optional `logo.png` / `background.png`), tried
 * in this order:
 *
 * 1. Hand-made B2B themes: `src/_data/themes/<slug>/` (source `business`).
 * 2. Customer designs from the App Designer: `PUBLIC_DIR/customer-themes/
 *    <slug>/` (source `customer`), written by src/appDesign.ts on every save.
 *
 * The response carries `source` so a client can tell the two apart; the
 * released app ignores fields it does not know. Customer themes are served
 * under `<slug>-<version>` (see src/appDesign.ts): whatever version a request
 * names, it gets the current file, with `id` set to the slug it asked for,
 * because the app caches a theme under its id.
 */
export default async function themeRoutes(
  fastify: FastifyInstance,
  getAuthHandler: any
) {
  const appTheme = AppTheme.getInstance();
  const appDesign = AppDesign.getInstance();
  const logger = new Logger();

  const businessThemeDir = (slug: string) =>
    `${process.env['APP_ROOT']}/_data/themes/${slug}`;

  /**
   * Where a requested slug lives: the directory, the file slug inside it and
   * its source. `_data` wins, so a hand-made theme can never be shadowed.
   */
  const locate = async (
    slug: string
  ): Promise<{ dir: string; fileSlug: string; source: ThemeSource } | null> => {
    const businessDir = businessThemeDir(slug);
    try {
      await fs.access(path.join(businessDir, `${slug}.json`));
      return { dir: businessDir, fileSlug: slug, source: 'business' };
    } catch {
      // not a hand-made theme
    }
    const customer = parseCustomerSlug(slug);
    if (!customer) return null;
    const customerDir = appDesign.customerThemeDir(customer.base);
    try {
      await fs.access(path.join(customerDir, `${customer.base}.json`));
      return { dir: customerDir, fileSlug: customer.base, source: 'customer' };
    } catch {
      return null;
    }
  };

  // Get theme configuration JSON file
  fastify.get('/theme/:slug', async (request: any, reply) => {
    const { slug } = request.params;

    if (!isValidThemeSlug(slug)) {
      reply.code(404);
      return { success: false, error: 'Theme not found' };
    }

    try {
      const found = await locate(slug);
      if (!found) {
        reply.code(404);
        return { success: false, error: 'Theme not found' };
      }
      const themeContent = await fs.readFile(
        path.join(found.dir, `${found.fileSlug}.json`),
        'utf-8'
      );
      const themeData = JSON.parse(themeContent);
      themeData.id = slug;
      themeData.source = found.source;
      themeData.assets = themeData.assets || {};

      // Cache-buster tied to the theme version so the asset URL changes
      // whenever the theme is updated, defeating WebView/CloudFront caching.
      const cacheBuster = themeData.version ?? Date.now();

      for (const kind of ['logo', 'background'] as const) {
        try {
          await fs.access(path.join(found.dir, `${kind}.png`));
          themeData.assets[kind] = `${process.env['API_URI']}/theme/${slug}/${kind}?v=${cacheBuster}`;
        } catch {
          themeData.assets[kind] = null;
        }
      }

      return { success: true, data: themeData };
    } catch (error: any) {
      console.error(`Error loading theme ${slug}: ${error.message}`);
      reply.code(500);
      return { success: false, error: 'Failed to load theme' };
    }
  });

  // Reload app themes (admin only)
  fastify.post(
    '/theme/reload',
    getAuthHandler(['admin']),
    async (_request: any, _reply) => {
      try {
        await appTheme.reload();
        return { success: true, message: 'App themes reloaded successfully' };
      } catch (error: any) {
        console.error(`Error reloading app themes: ${error.message}`);
        return { success: false, error: 'Failed to reload app themes' };
      }
    }
  );

  // Every theme in use, for the app's dev-mode theme picker. Customer slugs
  // are random so nobody can walk through other people's photos; outside
  // development they are left out of this public list.
  fastify.get('/theme/debug/all', async (_request: any, _reply) => {
    const includeCustomer = process.env['ENVIRONMENT'] === 'development';
    const allThemes = appTheme.getAllThemes();
    const themesArray = Array.from(allThemes.entries())
      .filter(([, theme]) => includeCustomer || !parseCustomerSlug(theme.s))
      .map(([id, theme]) => ({
        paymentHasPlaylistId: id,
        slug: theme.s,
        name: theme.n,
      }));

    return {
      success: true,
      count: themesArray.length,
      themes: themesArray,
    };
  });

  /**
   * Stream a theme asset from the same directory the theme came from. The
   * URL is version-busted by /theme/:slug, so the asset itself can be cached
   * aggressively.
   */
  const sendAsset = async (
    slug: string,
    kind: 'logo' | 'background',
    reply: any
  ) => {
    const label = kind === 'logo' ? 'Logo' : 'Background';
    if (!isValidThemeSlug(slug)) {
      reply.code(404);
      return { success: false, error: `${label} not found` };
    }
    const found = await locate(slug);
    const filePath = found ? path.join(found.dir, `${kind}.png`) : null;
    try {
      if (!filePath) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const file = await fs.readFile(filePath);
      reply.type('image/png');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return file;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        reply.code(404);
        return { success: false, error: `${label} not found` };
      }
      logger.log(`Error loading ${kind} for theme ${slug}: ${error.message}`);
      reply.code(500);
      return { success: false, error: `Failed to load ${kind}` };
    }
  };

  // Get theme logo asset
  fastify.get('/theme/:slug/logo', async (request: any, reply) => {
    return sendAsset(request.params.slug, 'logo', reply);
  });

  // Get theme background asset
  fastify.get('/theme/:slug/background', async (request: any, reply) => {
    return sendAsset(request.params.slug, 'background', reply);
  });
}
