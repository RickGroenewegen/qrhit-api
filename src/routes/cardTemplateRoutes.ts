import { FastifyInstance } from 'fastify';
import CardTemplates, {
  assetUrl,
  CardTemplateError,
  CardTemplateVersion,
  printerCardSizeMm,
  proofQuery,
  QR_COLOUR,
  sampleQrSubdir,
  sampleDesign,
  SAMPLE_TRACKS,
  sendStoredPage,
  UploadedAsset,
  verifyProof,
} from '../cardTemplates';
import { deckDesigns, designIndexForCard, getExtraDesigns } from '../cardDesigns';
import { getFontWeight, getGoogleFontName, getYearFontSize } from '../fonts';
import GoogleFonts from '../googleFonts';
import { resolveQrSubDir } from '../qrPaths';
import Translation from '../translation';
import PrismaInstance from '../prisma';
import Data from '../data';
import PDF from '../pdf';

/**
 * Card templates stored as data (src/cardTemplates.ts), for Rick's qrsong
 * toolkit (`qrsong template …`). Admin only, except the signed proof page
 * the PDF Lambda prints.
 *
 * - GET  /admin/card-templates                         stored templates (latest version) and the file templates
 * - GET  /admin/card-templates/:name                   versions and the order lines that use it
 * - GET  /admin/card-templates/:name/:version          the source and assets of one version (`latest` works)
 * - POST /admin/card-templates/:name                   push a new version (multipart: `manifest` JSON + `asset` files);
 *                                                      ?check=1 runs every check and stores nothing
 * - POST /admin/card-templates/:name/:version/proof    a proof PDF: sample cards, or an order line's own cards and design
 * - GET  /card-templates/proof/:name/:version          PUBLIC but signed (proofQuery): the page the Lambda prints
 *
 * Setting a template on an order line stays where it was: POST /php/:id
 * (production settings) and the toolkit order routes, which now also accept
 * a stored template's name and pin its version.
 */

const MAX_PROOF_CARDS = 24;

function versionParam(raw: string): number | null | 'bad' {
  if (raw === 'latest') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 'bad';
}

function sendError(reply: any, error: any) {
  if (error instanceof CardTemplateError) return reply.status(error.status).send({ success: false, error: error.message });
  if (error?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ success: false, error: 'an asset is larger than 15 MB' });
  console.error('card template route failed', error);
  return reply.status(500).send({ success: false, error: error?.message || 'failed' });
}

export default async function cardTemplateRoutes(fastify: FastifyInstance, getAuthHandler: any) {
  const adminOnly = getAuthHandler(['admin']);
  const templates = CardTemplates.getInstance();
  const prisma = PrismaInstance.getInstance();
  const data = Data.getInstance();
  const translation = new Translation();
  const apiUri = () => process.env['API_URI'] as string;

  const withUrls = (t: CardTemplateVersion) => ({
    ...t,
    assetUrls: Object.fromEntries(Object.entries(t.assets).map(([name, file]) => [name, assetUrl(apiUri(), t.name, file)])),
  });

  fastify.get('/admin/card-templates', adminOnly, async () => ({ success: true, ...(await templates.list()) }));

  fastify.get('/admin/card-templates/:name', adminOnly, async (request: any, reply: any) => {
    const history = await templates.history(String(request.params.name));
    if (!history) return reply.status(404).send({ success: false, error: 'no stored template with that name' });
    return { success: true, ...history };
  });

  fastify.get('/admin/card-templates/:name/:version', adminOnly, async (request: any, reply: any) => {
    const version = versionParam(String(request.params.version));
    if (version === 'bad') return reply.status(400).send({ success: false, error: 'version must be a number or latest' });
    const template = await templates.get(String(request.params.name), version);
    if (!template) return reply.status(404).send({ success: false, error: 'not found' });
    return { success: true, template: withUrls(template) };
  });

  fastify.post('/admin/card-templates/:name', adminOnly, async (request: any, reply: any) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ success: false, error: 'send multipart/form-data: a manifest field and asset files' });
    }
    try {
      let manifest: any = null;
      const uploads: UploadedAsset[] = [];
      for await (const part of request.parts({ limits: { fileSize: 15 * 1024 * 1024, files: 41 } })) {
        if (part.type === 'file') {
          const bytes = await part.toBuffer();
          if (part.fieldname !== 'asset') throw new CardTemplateError(`unexpected file field "${part.fieldname}" (use asset)`);
          uploads.push({ name: String(part.filename || ''), bytes });
        } else if (part.fieldname === 'manifest') {
          try {
            manifest = JSON.parse(String(part.value));
          } catch {
            throw new CardTemplateError('manifest is not valid JSON');
          }
        }
      }
      if (!manifest || typeof manifest !== 'object') throw new CardTemplateError('manifest is missing');
      const createdBy = request.user?.displayName || request.user?.userId || null;
      const checkOnly = request.query?.check === '1' || request.query?.check === 'true';
      const { template, warnings, fontFiles, stored } = await templates.push(
        String(request.params.name),
        {
          cardSizeMm: manifest.cardSizeMm === 'printer' || manifest.cardSizeMm === null ? null : Number(manifest.cardSizeMm),
          css: manifest.css,
          front: manifest.front,
          back: manifest.back,
          data: manifest.data ?? null,
          designFont: manifest.designFont,
          fonts: manifest.fonts ?? null,
          note: manifest.note ?? null,
        },
        uploads,
        createdBy ? String(createdBy) : null,
        { checkOnly }
      );
      if (!stored) return { success: true, checked: true, name: template.name, fonts: template.fonts, fontFiles, warnings };
      return {
        success: true,
        name: template.name,
        version: template.version,
        assets: withUrls(template).assetUrls,
        fonts: template.fonts,
        fontFiles,
        warnings,
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * A proof PDF of one version, printed by the PDF Lambda like an order's
   * cards. With `paymentId` (payments.paymentId or orderId) or `paymentHasPlaylistId`
   * it uses that order line's design and first cards; without, the sample
   * cards in the default design, their QR codes in `qrColor` (#rrggbb, default
   * black). `{ url: true }` returns the signed page URL (valid an hour)
   * instead, to look at in a browser.
   */
  fastify.post('/admin/card-templates/:name/:version/proof', adminOnly, async (request: any, reply: any) => {
    try {
      const name = String(request.params.name);
      const version = versionParam(String(request.params.version));
      if (version === 'bad') throw new CardTemplateError('version must be a number or latest');
      const template = await templates.get(name, version);
      if (!template) throw new CardTemplateError('no stored template with that name and version', 404);
      const body = request.body ?? {};
      const count = Math.min(MAX_PROOF_CARDS, Math.max(1, parseInt(body.count) || 6));
      const qrColor = String(body.qrColor || '#000000');
      if (!QR_COLOUR.test(qrColor)) throw new CardTemplateError('qrColor must be #rrggbb');
      let phpId = 0;
      if (body.paymentHasPlaylistId) {
        phpId = parseInt(body.paymentHasPlaylistId) || 0;
      } else if (body.paymentId) {
        const payment = await prisma.payment.findFirst({
          where: { OR: [{ paymentId: String(body.paymentId) }, { orderId: String(body.paymentId) }] },
          select: { PaymentHasPlaylist: { select: { id: true }, orderBy: { id: 'asc' } } },
        });
        if (!payment) throw new CardTemplateError('order not found', 404);
        if (payment.PaymentHasPlaylist.length !== 1) {
          throw new CardTemplateError(`the order has ${payment.PaymentHasPlaylist.length} lines; pass paymentHasPlaylistId`);
        }
        phpId = payment.PaymentHasPlaylist[0].id;
      }
      if (phpId && !(await prisma.paymentHasPlaylist.findUnique({ where: { id: phpId }, select: { id: true } }))) {
        throw new CardTemplateError('order line not found', 404);
      }
      const url = `${apiUri()}/card-templates/proof/${name}/${template.version}?${proofQuery(name, template.version, phpId, count, qrColor)}`;
      if (body.url) return { success: true, url, version: template.version };
      const printerType = phpId
        ? (await prisma.paymentHasPlaylist.findUnique({ where: { id: phpId }, select: { printerType: true } }))?.printerType
        : sampleDesign().printerType;
      const sizeMm = template.cardSizeMm ?? printerCardSizeMm(printerType);
      const pdf = await new PDF().renderUrlToPdfBuffer(url, {
        width: sizeMm,
        height: sizeMm,
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
      });
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="proof_${name}_v${template.version}.pdf"`);
      return reply.send(pdf);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get('/card-templates/proof/:name/:version', async (request: any, reply: any) => {
    const name = String(request.params.name);
    const version = parseInt(request.params.version);
    const phpId = parseInt(request.query.php) || 0;
    const count = parseInt(request.query.n) || 0;
    const exp = parseInt(request.query.exp) || 0;
    const qrColor = String(request.query.qc || '');
    if (!verifyProof(name, version, phpId, count, qrColor, exp, request.query.sig) || count < 1 || count > MAX_PROOF_CARDS) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const template = await templates.get(name, version);
    if (!template) return reply.status(404).send({ error: 'Not found' });

    try {
      let php: Record<string, any> = { ...sampleDesign(), qrColor };
      let designs: Record<string, any>[] = [php];
      let tracks: Record<string, any>[] = SAMPLE_TRACKS.slice(0, count);
      let subdir: string | null = phpId ? null : await sampleQrSubdir(apiUri(), qrColor);
      if (phpId) {
        const line: any = await prisma.paymentHasPlaylist.findUnique({
          where: { id: phpId },
          include: { payment: { select: { userId: true, qrSubDir: true } } },
        });
        if (!line) return reply.status(404).send({ error: 'Not found' });
        php = { ...line, paymentHasPlaylistId: line.id };
        designs = deckDesigns(php as any, await getExtraDesigns(line.id));
        tracks = (await data.getTracks(line.playlistId, line.payment.userId, line.id)).slice(0, count);
        subdir = await resolveQrSubDir(line.payment.qrSubDir, line.id);
      }
      const cardDesignIndexes = tracks.map((_: any, i: number) => designIndexForCard(designs.length, i));
      const howtoTranslations = php.addHowToCard
        ? await translation.getTranslationsByPrefix(php.addHowToCardLocale || 'en', 'howto')
        : null;
      await sendStoredPage(
        reply,
        template,
        {
          php,
          designs,
          cardDesignIndexes,
          tracks,
          subdir,
          eco: !!php.eco,
          startIndex: 0,
          batchNumber: String(phpId || 0),
          apiUri: apiUri(),
        },
        {
          php,
          designs,
          howtoTranslations,
          getYearFontSize,
          getGoogleFontWeights: await GoogleFonts.getInstance().weightsHelperForFonts(
            designs.map((design: any) => design.selectedFont)
          ),
          getGoogleFontName,
          getFontWeight,
        }
      );
    } catch (error: any) {
      if (!(error instanceof CardTemplateError)) throw error;
      reply.status(500).send({ error: `card template ${name}: ${error.message}` });
    }
  });
}
