import { FastifyInstance } from 'fastify';
import {
  buildDefaultPlaylistsView,
  DefaultPlaylistError,
  defaultPlaylistsFileName,
  defaultPlaylistsViewQuery,
  deleteDefaultPlaylist,
  getDefaultPlaylistsByIds,
  getDefaultPlaylistsTranslator,
  listDefaultPlaylists,
  parseDefaultPlaylistIds,
  parseDefaultPlaylistsBody,
  upsertDefaultPlaylists,
} from '../defaultPlaylists';
import Translation from '../translation';
import PDF from '../pdf';

/**
 * The default playlists (src/defaultPlaylists.ts): the catalogue behind the
 * dashboard's Companies → Default playlists page and Rick's toolkit
 * (`qrsong default-playlists …`), and the brochure of a selection.
 *
 * - GET    /business/default-playlists        every row, by sortOrder, themeKey, cardCount
 * - PUT    /business/default-playlists        upsert rows on (themeKey, cardCount); the toolkit fills the catalogue
 * - DELETE /business/default-playlists/:id    one row; the Spotify playlist stays
 * - POST   /business/default-playlists/pdf    { locale, ids } → the brochure PDF (PDF Lambda)
 * - GET    /business/default-playlists/view   PUBLIC: the brochure HTML the Lambda prints (?locale=&ids=1,2,3)
 *
 * The view needs no session or signature, like the playlist suggestions view
 * it replaced: it shows no prices, only playlists that are public on Spotify.
 */
export default async function defaultPlaylistRoutes(fastify: FastifyInstance, getAuthHandler: any) {
  const adminOnly = getAuthHandler(['admin']);
  const translation = new Translation();
  const apiUri = () => process.env['API_URI'] || 'http://localhost:3004';

  const fail = (reply: any, error: any, context: string) => {
    if (error instanceof DefaultPlaylistError) return reply.status(error.status).send({ success: false, error: error.message });
    console.error(`${context}:`, error);
    return reply.status(500).send({ success: false, error: `${context} failed` });
  };

  fastify.get('/business/default-playlists', adminOnly, async (_request: any, reply: any) => {
    try {
      return { success: true, playlists: await listDefaultPlaylists() };
    } catch (error) {
      return fail(reply, error, 'Listing default playlists');
    }
  });

  fastify.put('/business/default-playlists', adminOnly, async (request: any, reply: any) => {
    try {
      const input = parseDefaultPlaylistsBody(request.body);
      return { success: true, playlists: await upsertDefaultPlaylists(input) };
    } catch (error) {
      return fail(reply, error, 'Saving default playlists');
    }
  });

  fastify.delete('/business/default-playlists/:id', adminOnly, async (request: any, reply: any) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return reply.status(400).send({ success: false, error: 'invalid id' });
    try {
      if (!(await deleteDefaultPlaylist(id))) return reply.status(404).send({ success: false, error: 'no default playlist with that id' });
      return { success: true };
    } catch (error) {
      return fail(reply, error, 'Deleting a default playlist');
    }
  });

  fastify.post('/business/default-playlists/pdf', adminOnly, async (request: any, reply: any) => {
    try {
      const body = request.body ?? {};
      const locale = translation.resolveBusinessLocale(typeof body.locale === 'string' ? body.locale : null);
      const ids = parseDefaultPlaylistIds(body.ids);
      const rows = await getDefaultPlaylistsByIds(ids);
      if (rows.length === 0) throw new DefaultPlaylistError('none of these ids is a default playlist');

      const url = `${apiUri()}/business/default-playlists/view?${defaultPlaylistsViewQuery(
        locale,
        rows.map((row) => row.id)
      )}`;
      const pdf = await new PDF().renderUrlToPdfBuffer(url, {
        format: 'a4',
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
      });

      const t = await getDefaultPlaylistsTranslator(translation, locale);
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${defaultPlaylistsFileName(t)}"`);
      return reply.send(pdf);
    } catch (error) {
      return fail(reply, error, 'Generating the default playlists PDF');
    }
  });

  fastify.get('/business/default-playlists/view', async (request: any, reply: any) => {
    try {
      const query = request.query ?? {};
      const locale = translation.resolveBusinessLocale(typeof query.locale === 'string' ? query.locale : null);
      const ids = parseDefaultPlaylistIds(typeof query.ids === 'string' ? query.ids : '');
      const rows = await getDefaultPlaylistsByIds(ids);
      if (rows.length === 0) return reply.status(404).send({ success: false, error: 'none of these ids is a default playlist' });

      const view = buildDefaultPlaylistsView(rows, {
        locale,
        t: await getDefaultPlaylistsTranslator(translation, locale),
        intlTag: translation.getIntlTag(locale),
        baseUrl: apiUri(),
      });
      await reply.view('default_playlists.ejs', view);
      return reply;
    } catch (error) {
      return fail(reply, error, 'Rendering the default playlists brochure');
    }
  });
}
