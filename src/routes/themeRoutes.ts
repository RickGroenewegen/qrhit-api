import { FastifyInstance } from 'fastify';
import AppTheme from '../apptheme';
import Logger from '../logger';
import fs from 'fs/promises';
import path from 'path';

export default async function themeRoutes(
  fastify: FastifyInstance,
  getAuthHandler: any
) {
  const appTheme = AppTheme.getInstance();
  const logger = new Logger();

  // Get theme configuration JSON file
  fastify.get('/theme/:slug', async (request: any, reply) => {
    const { slug } = request.params;

    try {
      // Read theme JSON file from src/_data/themes/{slug}/{slug}.json
      const themePath = `${process.env['APP_ROOT']}/_data/themes/${slug}/${slug}.json`;
      const themeContent = await fs.readFile(themePath, 'utf-8');
      const themeData = JSON.parse(themeContent);

      // Cache-buster tied to the theme version so the asset URL changes
      // whenever the theme is updated, defeating WebView/CloudFront caching.
      const cacheBuster = themeData.version ?? Date.now();

      // Check if logo exists and update URL
      const logoPath = `${process.env['APP_ROOT']}/_data/themes/${slug}/logo.png`;
      try {
        await fs.access(logoPath);
        themeData.assets.logo = `${process.env['API_URI']}/theme/${slug}/logo?v=${cacheBuster}`;
      } catch {
        themeData.assets.logo = null;
      }

      // Check if background exists and update URL
      const backgroundPath = `${process.env['APP_ROOT']}/_data/themes/${slug}/background.png`;
      try {
        await fs.access(backgroundPath);
        themeData.assets.background = `${process.env['API_URI']}/theme/${slug}/background?v=${cacheBuster}`;
      } catch {
        themeData.assets.background = null;
      }

      return { success: true, data: themeData };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        reply.code(404);
        return { success: false, error: 'Theme not found' };
      }

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

  // Get theme logo asset
  fastify.get('/theme/:slug/logo', async (request: any, reply) => {
    const { slug } = request.params;

    try {
      const logoPath = `${process.env['APP_ROOT']}/_data/themes/${slug}/logo.png`;

      // Check if file exists
      await fs.access(logoPath);

      // Stream the file. The URL is version-busted by /theme/:slug, so the
      // asset itself can be cached aggressively.
      const file = await fs.readFile(logoPath);
      reply.type('image/png');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return file;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        reply.code(404);
        return { success: false, error: 'Logo not found' };
      }

      console.error(`Error loading logo for theme ${slug}: ${error.message}`);
      reply.code(500);
      return { success: false, error: 'Failed to load logo' };
    }
  });

  // Get theme background asset
  fastify.get('/theme/:slug/background', async (request: any, reply) => {
    const { slug } = request.params;

    try {
      const backgroundPath = `${process.env['APP_ROOT']}/_data/themes/${slug}/background.png`;

      // Check if file exists
      await fs.access(backgroundPath);

      // Stream the file. The URL is version-busted by /theme/:slug, so the
      // asset itself can be cached aggressively.
      const file = await fs.readFile(backgroundPath);
      reply.type('image/png');
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return file;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        reply.code(404);
        return { success: false, error: 'Background not found' };
      }

      console.error(`Error loading background for theme ${slug}: ${error.message}`);
      reply.code(500);
      return { success: false, error: 'Failed to load background' };
    }
  });
}
