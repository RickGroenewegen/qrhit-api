import { FastifyInstance } from 'fastify';
import { readFile } from 'fs/promises';
import StoredThemes, { StoredThemeError, THEME_ASSET_KINDS, ThemeAssetKind, themeAssetPath } from '../storedThemes';
import { servedStoredSlug } from '../apptheme';

/**
 * Scan-app themes stored as data (src/storedThemes.ts), for Rick's qrsong
 * toolkit (`qrsong theme check|push|pull|list|history`). Admin only; the app
 * itself keeps reading GET /theme/:slug (themeRoutes.ts).
 *
 * - GET  /admin/app-themes                             stored themes (newest version) and the folder themes
 * - GET  /admin/app-themes/:slug                       versions and the order lines that use it
 * - GET  /admin/app-themes/:slug/:version              the JSON of one version (`latest` works)
 * - GET  /admin/app-themes/:slug/:version/:kind        its logo or background (PNG)
 * - POST /admin/app-themes/:slug                       push a new version (multipart: `manifest` JSON, optional
 *                                                      `note`, files `logo` and `background`); ?check=1 runs every
 *                                                      check and stores nothing
 *
 * Linking a theme to an order line stays POST /php/:id (production
 * settings, `qrsong theme set`).
 */

function versionParam(raw: string): number | null | 'bad' {
  if (raw === 'latest') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 'bad';
}

function sendError(reply: any, error: any) {
  if (error instanceof StoredThemeError) return reply.status(error.status).send({ success: false, error: error.message });
  if (error?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ success: false, error: 'a picture is larger than 15 MB' });
  console.error('app theme route failed', error);
  return reply.status(500).send({ success: false, error: error?.message || 'failed' });
}

export default async function appThemeRoutes(fastify: FastifyInstance, getAuthHandler: any) {
  const adminOnly = getAuthHandler(['admin']);
  const themes = StoredThemes.getInstance();

  fastify.get('/admin/app-themes', adminOnly, async () => ({ success: true, ...(await themes.list()) }));

  fastify.get('/admin/app-themes/:slug', adminOnly, async (request: any, reply: any) => {
    const history = await themes.history(String(request.params.slug));
    if (!history) return reply.status(404).send({ success: false, error: 'no stored theme with that slug' });
    return { success: true, ...history };
  });

  fastify.get('/admin/app-themes/:slug/:version', adminOnly, async (request: any, reply: any) => {
    const version = versionParam(String(request.params.version));
    if (version === 'bad') return reply.status(400).send({ success: false, error: 'version must be a number or latest' });
    const theme = await themes.get(String(request.params.slug), version);
    if (!theme) return reply.status(404).send({ success: false, error: 'not found' });
    return {
      success: true,
      theme: {
        slug: theme.slug,
        version: theme.version,
        name: theme.name,
        note: theme.note,
        createdBy: theme.createdBy,
        createdAt: theme.createdAt,
        config: theme.config,
        files: { logo: theme.logo, background: theme.background },
      },
    };
  });

  fastify.get('/admin/app-themes/:slug/:version/:kind', adminOnly, async (request: any, reply: any) => {
    const version = versionParam(String(request.params.version));
    const kind = String(request.params.kind) as ThemeAssetKind;
    if (version === 'bad' || !THEME_ASSET_KINDS.includes(kind)) {
      return reply.status(400).send({ success: false, error: 'GET /admin/app-themes/:slug/:version/logo|background' });
    }
    const theme = await themes.get(String(request.params.slug), version);
    const file = theme?.[kind];
    if (!theme || !file) return reply.status(404).send({ success: false, error: `no ${kind}` });
    try {
      const bytes = await readFile(themeAssetPath(theme.slug, file));
      return reply.type('image/png').send(bytes);
    } catch {
      return reply.status(404).send({ success: false, error: `the ${kind} file is missing on this server` });
    }
  });

  fastify.post('/admin/app-themes/:slug', adminOnly, async (request: any, reply: any) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ success: false, error: 'send multipart/form-data: a manifest field and the logo/background files' });
    }
    try {
      let manifest: unknown = null;
      let note: string | null = null;
      const uploads: Partial<Record<ThemeAssetKind, Buffer>> = {};
      for await (const part of request.parts({ limits: { fileSize: 15 * 1024 * 1024, files: 2 } })) {
        if (part.type === 'file') {
          const bytes = await part.toBuffer();
          const kind = part.fieldname as ThemeAssetKind;
          if (!THEME_ASSET_KINDS.includes(kind)) throw new StoredThemeError(`unexpected file field "${part.fieldname}" (use logo or background)`);
          if (uploads[kind]) throw new StoredThemeError(`${kind} is in the push twice`);
          uploads[kind] = bytes;
        } else if (part.fieldname === 'manifest') {
          try {
            manifest = JSON.parse(String(part.value));
          } catch {
            throw new StoredThemeError('manifest is not valid JSON');
          }
        } else if (part.fieldname === 'note') {
          note = String(part.value || '') || null;
        }
      }
      if (manifest === null) throw new StoredThemeError('manifest is missing');
      const slug = String(request.params.slug);
      const checkOnly = request.query?.check === '1' || request.query?.check === 'true';
      const createdBy = request.user?.displayName || request.user?.userId || null;
      const { theme, name, warnings } = await themes.push(slug, manifest, uploads, {
        note,
        createdBy: createdBy ? String(createdBy) : null,
        checkOnly,
      });
      if (!theme) return { success: true, checked: true, slug, name, warnings };
      const apiUri = process.env['API_URI'] as string;
      const served = servedStoredSlug(theme.slug, theme.version);
      return {
        success: true,
        slug: theme.slug,
        version: theme.version,
        servedSlug: served,
        name: theme.name,
        warnings,
        assets: {
          logo: theme.logo ? `${apiUri}/theme/${served}/logo?v=${theme.version}` : null,
          background: theme.background ? `${apiUri}/theme/${served}/background?v=${theme.version}` : null,
        },
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
