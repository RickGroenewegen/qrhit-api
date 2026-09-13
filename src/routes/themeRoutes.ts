import { FastifyInstance } from 'fastify';
import AppTheme from '../apptheme';
import AppDesign, { isValidThemeSlug } from '../appDesign';
import Logger from '../logger';
import fs from 'fs/promises';
import path from 'path';

/**
 * Themes for the scan app. Two sources, tried in this order:
 *
 * 1. Hand-made B2B themes: `src/_data/themes/<slug>/<slug>.json` plus
 *    optional `logo.png` / `background.png` next to it.
 * 2. Customer designs from the App Designer: rows in `app_designs`, assets
 *    under `PUBLIC_DIR/app-theme/`.
 *
 * The app cannot tell the two apart and does not need to.
 */
export default async function themeRoutes(
  fastify: FastifyInstance,
  getAuthHandler: any
) {
  const appTheme = AppTheme.getInstance();
  const appDesign = AppDesign.getInstance();
  const logger = new Logger();

  const fileThemeDir = (slug: string) =>
    `${process.env['APP_ROOT']}/_data/themes/${slug}`;

  // Get theme configuration JSON file
  fastify.get('/theme/:slug', async (request: any, reply) => {
    const { slug } = request.params;

    if (!isValidThemeSlug(slug)) {
      reply.code(404);
      return { success: false, error: 'Theme not found' };
    }

    try {
      // Read theme JSON file from src/_data/themes/{slug}/{slug}.json
      const themePath = `${fileThemeDir(slug)}/${slug}.json`;
      const themeContent = await fs.readFile(themePath, 'utf-8');
      const themeData = JSON.parse(themeContent);

      // Cache-buster tied to the theme version so the asset URL changes
      // whenever the theme is updated, defeating WebView/CloudFront caching.
      const cacheBuster = themeData.version ?? Date.now();

      // Check if logo exists and update URL
      const logoPath = `${fileThemeDir(slug)}/logo.png`;
      try {
        await fs.access(logoPath);
        themeData.assets.logo = `${process.env['API_URI']}/theme/${slug}/logo?v=${cacheBuster}`;
      } catch {
        themeData.assets.logo = null;
      }

      // Check if background exists and update URL
      const backgroundPath = `${fileThemeDir(slug)}/background.png`;
      try {
        await fs.access(backgroundPath);
        themeData.assets.background = `${process.env['API_URI']}/theme/${slug}/background?v=${cacheBuster}`;
      } catch {
        themeData.assets.background = null;
      }

      return { success: true, data: themeData };
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error(`Error loading theme ${slug}: ${error.message}`);
        reply.code(500);
        return { success: false, error: 'Failed to load theme' };
      }
    }

    // No file: a customer design from the App Designer.
    try {
      const row = await appDesign.getBySlug(slug);
      if (!row) {
        reply.code(404);
        return { success: false, error: 'Theme not found' };
      }
      return { success: true, data: appDesign.buildThemeResponse(row) };
    } catch (error: any) {
      console.error(`Error loading app design ${slug}: ${error.message}`);
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

  // Get all app themes (debugging endpoint)
  fastify.get('/theme/debug/all', async (_request: any, _reply) => {
    const allThemes = appTheme.getAllThemes();
    const themesArray = Array.from(allThemes.entries()).map(([id, theme]) => ({
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
   * Stream a theme asset. File-based themes keep their fixed names; DB-backed
   * designs resolve the filename through the row. The URL is version-busted
   * by /theme/:slug, so the asset itself can be cached aggressively.
   */
  const sendAsset = async (
    slug: string,
    kind: 'logo' | 'background',
    reply: any
  ) => {
    if (!isValidThemeSlug(slug)) {
      reply.code(404);
      return { success: false, error: `${kind === 'logo' ? 'Logo' : 'Background'} not found` };
    }
    let filePath: string | null = path.join(fileThemeDir(slug), `${kind}.png`);
    try {
      await fs.access(filePath);
    } catch {
      filePath = await appDesign.resolveAssetPath(slug, kind);
    }
    if (!filePath) {
      reply.code(404);
      return { success: false, error: `${kind === 'logo' ? 'Logo' : 'Background'} not found` };
    }
    try {
      const file = await fs.readFile(filePath);
      reply.type('image/png');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return file;
    } catch (error: any) {
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
