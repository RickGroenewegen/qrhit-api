import { FastifyInstance } from 'fastify';
import PrismaInstance from '../prisma';
import Mail from '../mail';
import { ChatGPT } from '../chatgpt';
import Translation from '../translation';
import {
  ADMIN_EXTENSIONS,
  IncomingFile,
  MAIL_ATTACHMENT_LIMIT_BYTES,
  MAX_ADMIN_FILE_BYTES,
  companyFileThumb,
  contentDisposition,
  deleteCompanyFile,
  findCompanyFile,
  findCompanyList,
  isAllowedExtension,
  readCompanyFile,
  saveCompanyFile,
  toFileDto,
  updateCompanyFile,
} from '../companyFiles';
import QuoteRequests, {
  BRAND_KIT_MAX_BYTES,
  BRAND_KIT_MAX_FILES,
  QuoteRequestError,
} from '../quoteRequests';

/**
 * Business quote requests and the company asset store: the public /business
 * form, the admin store behind the company Assets tab, mailing files to a
 * company contact, and the song-year lookup boxd uses for the sample cards on
 * its flyer. Machine clients (boxd, qquote) use the same admin bearer token as
 * the dashboard. The three-size quotation (48, 96 and 192 side by side) and
 * its routes were removed on 2026-10-06 at Rick's request.
 */
export default async function businessRoutes(
  fastify: FastifyInstance,
  getAuthHandler: any
) {
  const prisma = PrismaInstance.getInstance();
  const quoteRequests = QuoteRequests.getInstance();
  const translation = new Translation();
  const chatgpt = new ChatGPT();
  const staff = getAuthHandler(['admin']);

  const companyIdOf = (request: any): number => parseInt(request.params.companyId, 10);

  async function findCompany(companyId: number, reply: any): Promise<any | null> {
    if (!Number.isInteger(companyId)) {
      reply.status(400).send({ success: false, error: 'Invalid company ID' });
      return null;
    }
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      reply.status(404).send({ success: false, error: 'Company not found' });
      return null;
    }
    return company;
  }

  function sendQuoteRequestError(reply: any, error: unknown): void {
    if (error instanceof QuoteRequestError) {
      reply.status(error.statusCode).send({ success: false, error: error.message, code: error.code });
      return;
    }
    console.error('Quote request error:', error);
    reply.status(500).send({ success: false, error: 'Something went wrong' });
  }

  // ---- Public: the /business form ----

  fastify.post('/business/quote-request', async (request: any, reply: any) => {
    const fields: Record<string, string> = {};
    const files: IncomingFile[] = [];
    let fileParts = 0;
    try {
      if (request.isMultipart()) {
        const parts = request.parts({
          limits: { fileSize: BRAND_KIT_MAX_BYTES, files: 20, fields: 30, fieldSize: 20_000 },
        });
        for await (const part of parts) {
          if (part.type === 'file') {
            // Counted here rather than by the plugin's files limit, which
            // aborts the request mid-part. Files over the limit are drained
            // unread.
            fileParts++;
            if (fileParts > BRAND_KIT_MAX_FILES || part.fieldname !== 'brandKit' || !part.filename) {
              part.file.resume();
              continue;
            }
            const buffer = await part.toBuffer();
            files.push({ buffer, originalName: part.filename, mimeType: part.mimetype });
          } else if (typeof part.value === 'string') {
            fields[part.fieldname] = part.value;
          }
        }
      } else {
        Object.assign(fields, request.body || {});
      }
    } catch (error: any) {
      if (error?.code === 'FST_REQ_FILE_TOO_LARGE') {
        reply.status(400).send({ success: false, error: 'File larger than 20 MB', code: 'file_size' });
        return;
      }
      console.error('Quote request upload error:', error);
      reply.status(400).send({ success: false, error: 'Upload failed' });
      return;
    }
    if (fileParts > BRAND_KIT_MAX_FILES) {
      reply.status(400).send({ success: false, error: `At most ${BRAND_KIT_MAX_FILES} files`, code: 'too_many_files' });
      return;
    }

    try {
      const result = await quoteRequests.createFromForm(fields, files, request.clientIp);
      reply.send({ success: true, requestId: result.requestId });
    } catch (error) {
      sendQuoteRequestError(reply, error);
    }
  });

  // ---- Asset store ----

  /**
   * The list a request names (`listId` in the query or a form field), or
   * null for the company's own files. `false` when it is not this company's
   * list; the reply has been sent then.
   */
  async function listScope(companyId: number, raw: unknown, reply: any): Promise<number | null | false> {
    if (raw === undefined || raw === null || raw === '') return null;
    const list = await findCompanyList(companyId, parseInt(String(raw), 10));
    if (!list) {
      reply.status(400).send({ success: false, error: 'listId does not belong to this company' });
      return false;
    }
    return list.id;
  }

  // Newest first. Without listId: the company's own files; ?listId=<id>: that
  // list's; ?listId=all: both.
  fastify.get('/business/companies/:companyId/files', staff, async (request: any, reply: any) => {
    const company = await findCompany(companyIdOf(request), reply);
    if (!company) return;
    const all = request.query.listId === 'all';
    const listId = all ? null : await listScope(company.id, request.query.listId, reply);
    if (listId === false) return;
    const files = await prisma.companyFile.findMany({
      where: all ? { companyId: company.id } : { companyId: company.id, companyListId: listId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    reply.send({
      success: true,
      files: files.map(toFileDto),
      mailLimitBytes: MAIL_ATTACHMENT_LIMIT_BYTES,
    });
  });

  fastify.post('/business/companies/:companyId/files', staff, async (request: any, reply: any) => {
    const company = await findCompany(companyIdOf(request), reply);
    if (!company) return;
    if (!request.isMultipart()) {
      reply.status(400).send({ success: false, error: 'Send the files as multipart/form-data' });
      return;
    }

    const fields: Record<string, string> = {};
    const incoming: IncomingFile[] = [];
    try {
      const parts = request.parts({ limits: { fileSize: MAX_ADMIN_FILE_BYTES, files: 50 } });
      for await (const part of parts) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          if (part.fieldname === 'file' && part.filename) {
            incoming.push({ buffer, originalName: part.filename, mimeType: part.mimetype });
          }
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (error: any) {
      const tooLarge = error?.code === 'FST_REQ_FILE_TOO_LARGE';
      reply.status(tooLarge ? 413 : 400).send({
        success: false,
        error: tooLarge ? 'A file is larger than 100 MB' : 'Upload failed',
      });
      return;
    }

    if (!incoming.length) {
      reply.status(400).send({ success: false, error: 'No file uploaded' });
      return;
    }
    const refused = incoming.filter((f) => !isAllowedExtension(f.originalName, ADMIN_EXTENSIONS));
    if (refused.length) {
      reply.status(400).send({
        success: false,
        error: `Not an accepted file type: ${refused.map((f) => f.originalName).join(', ')}`,
      });
      return;
    }

    let quoteRequestId: number | null = null;
    if (fields['quoteRequestId']) {
      const id = parseInt(fields['quoteRequestId'], 10);
      const owned = Number.isInteger(id)
        ? await prisma.companyQuoteRequest.findFirst({ where: { id, companyId: company.id } })
        : null;
      if (!owned) {
        reply.status(400).send({ success: false, error: 'quoteRequestId does not belong to this company' });
        return;
      }
      quoteRequestId = id;
    }
    const companyListId = await listScope(company.id, fields['listId'], reply);
    if (companyListId === false) return;

    const saved = [];
    for (const file of incoming) {
      saved.push(
        await saveCompanyFile(company.id, file, {
          category: fields['category'],
          source: fields['source'],
          note: fields['note'],
          companyListId,
          quoteRequestId,
        })
      );
    }
    reply.status(201).send({ success: true, files: saved.map(toFileDto) });
  });

  fastify.get(
    '/business/companies/:companyId/files/:fileId/download',
    staff,
    async (request: any, reply: any) => {
      const file = await findCompanyFile(companyIdOf(request), parseInt(request.params.fileId, 10));
      if (!file) {
        reply.status(404).send({ success: false, error: 'File not found' });
        return;
      }
      try {
        const buffer = await readCompanyFile(file);
        // Inline only for what the dashboard previews in an <img> or the PDF
        // viewer; everything else always downloads.
        const inline =
          request.query.inline === '1' &&
          (file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf');
        reply
          .header('Content-Type', file.mimeType)
          .header('Content-Disposition', contentDisposition(file.originalName, inline))
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
          .header('Cache-Control', 'private, no-store')
          .send(buffer);
      } catch {
        reply.status(404).send({ success: false, error: 'File missing on disk' });
      }
    }
  );

  fastify.get(
    '/business/companies/:companyId/files/:fileId/thumb',
    staff,
    async (request: any, reply: any) => {
      const file = await findCompanyFile(companyIdOf(request), parseInt(request.params.fileId, 10));
      if (!file) {
        reply.status(404).send({ success: false, error: 'File not found' });
        return;
      }
      try {
        const thumb = await companyFileThumb(file);
        if (!thumb) {
          reply.status(404).send({ success: false, error: 'No thumbnail for this file type' });
          return;
        }
        reply
          .header('Content-Type', thumb.contentType)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
          .header('Cache-Control', 'private, max-age=86400')
          .send(thumb.data);
      } catch {
        reply.status(404).send({ success: false, error: 'No thumbnail' });
      }
    }
  );

  fastify.patch(
    '/business/companies/:companyId/files/:fileId',
    staff,
    async (request: any, reply: any) => {
      const file = await findCompanyFile(companyIdOf(request), parseInt(request.params.fileId, 10));
      if (!file) {
        reply.status(404).send({ success: false, error: 'File not found' });
        return;
      }
      const { category, note, originalName } = request.body || {};
      // companyListId: a list of this company moves the file there, null back to the company.
      let companyListId: number | null | undefined;
      if (request.body && 'companyListId' in request.body) {
        const scope = await listScope(file.companyId, request.body.companyListId, reply);
        if (scope === false) return;
        companyListId = scope;
      }
      const updated = await updateCompanyFile(file, { category, note, originalName, companyListId });
      reply.send({ success: true, file: toFileDto(updated) });
    }
  );

  fastify.delete(
    '/business/companies/:companyId/files/:fileId',
    staff,
    async (request: any, reply: any) => {
      const file = await findCompanyFile(companyIdOf(request), parseInt(request.params.fileId, 10));
      if (!file) {
        reply.status(404).send({ success: false, error: 'File not found' });
        return;
      }
      await deleteCompanyFile(file);
      reply.send({ success: true });
    }
  );

  // ---- Quote requests ----

  fastify.get('/business/quote-requests', staff, async (request: any, reply: any) => {
    const statuses = String(request.query.status || 'open,in_progress')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    reply.send({ success: true, requests: await quoteRequests.list(statuses) });
  });

  fastify.get('/business/quote-requests/:id', staff, async (request: any, reply: any) => {
    const found = await quoteRequests.get(parseInt(request.params.id, 10));
    if (!found) {
      reply.status(404).send({ success: false, error: 'Quote request not found' });
      return;
    }
    reply.send({ success: true, request: found });
  });

  fastify.put('/business/quote-requests/:id', staff, async (request: any, reply: any) => {
    try {
      const updated = await quoteRequests.updateStatus(
        parseInt(request.params.id, 10),
        String(request.body?.status || '')
      );
      reply.send({ success: true, request: updated });
    } catch (error) {
      sendQuoteRequestError(reply, error);
    }
  });

  fastify.get(
    '/business/companies/:companyId/quote-requests',
    staff,
    async (request: any, reply: any) => {
      const company = await findCompany(companyIdOf(request), reply);
      if (!company) return;
      reply.send({ success: true, requests: await quoteRequests.listForCompany(company.id) });
    }
  );

  // ---- Mail files and a quotation to a company contact ----

  fastify.post('/business/companies/:companyId/mail', staff, async (request: any, reply: any) => {
    const company = await findCompany(companyIdOf(request), reply);
    if (!company) return;
    const body = request.body || {};
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '').trim();
    if (!subject || !message) {
      reply.status(400).send({ success: false, error: 'Subject and message are required' });
      return;
    }

    // The recipient is one of the company's users, or its contact address.
    let to: { email: string; name: string; locale: string | null } | null = null;
    if (body.userId) {
      const user = await prisma.user.findFirst({
        where: { id: Number(body.userId), companyId: company.id },
        select: { email: true, displayName: true, locale: true },
      });
      if (user) to = { email: user.email, name: user.displayName || '', locale: user.locale };
    } else if (body.email && company.contactemail) {
      const email = String(body.email).trim().toLowerCase();
      if (email === company.contactemail.trim().toLowerCase()) {
        to = { email: company.contactemail.trim(), name: company.contact || '', locale: company.locale };
      }
    }
    if (!to) {
      reply.status(400).send({ success: false, error: 'The recipient must be a contact of this company' });
      return;
    }

    const fileIds: number[] = Array.isArray(body.fileIds)
      ? [...new Set<number>(body.fileIds.map((id: any) => parseInt(id, 10)).filter(Number.isInteger))]
      : [];
    const files = fileIds.length
      ? await prisma.companyFile.findMany({ where: { id: { in: fileIds }, companyId: company.id } })
      : [];
    if (files.length !== fileIds.length) {
      reply.status(400).send({ success: false, error: 'Some files do not belong to this company' });
      return;
    }

    const attachments: Array<{ filename: string; contentType: string; data: Buffer }> = [];
    for (const file of files) {
      try {
        attachments.push({ filename: file.originalName, contentType: file.mimeType, data: await readCompanyFile(file) });
      } catch {
        reply.status(404).send({ success: false, error: `File missing on disk: ${file.originalName}` });
        return;
      }
    }

    let quotationNumber: string | null = null;
    if (body.quotationId) {
      const quotation = await prisma.quotation.findFirst({
        where: { id: Number(body.quotationId), companyId: company.id },
      });
      if (!quotation) {
        reply.status(400).send({ success: false, error: 'Quotation not found for this company' });
        return;
      }
      try {
        const data = await require('fs').promises.readFile(
          `${process.env['PRIVATE_DIR']}/quotation/${quotation.quotationNumber}.pdf`
        );
        const quotationT = await translation.getBusinessTranslator(
          translation.resolveBusinessLocale(quotation.locale),
          'quotation'
        );
        attachments.push({
          filename: `${quotationT('fileName')}_${company.name.replace(/[^a-zA-Z0-9]/g, '_')}_${quotation.quotationNumber}.pdf`,
          contentType: 'application/pdf',
          data,
        });
        quotationNumber = quotation.quotationNumber;
      } catch {
        reply.status(404).send({ success: false, error: 'The quotation PDF is missing on disk' });
        return;
      }
    }

    const total = attachments.reduce((sum, a) => sum + a.data.length, 0);
    if (total > MAIL_ATTACHMENT_LIMIT_BYTES) {
      const biggest = [...attachments]
        .sort((a, b) => b.data.length - a.data.length)
        .slice(0, 3)
        .map((a) => `${a.filename} (${(a.data.length / 1e6).toFixed(1)} MB)`);
      reply.status(413).send({
        success: false,
        error: `The attachments are ${(total / 1e6).toFixed(1)} MB, the limit is ${(MAIL_ATTACHMENT_LIMIT_BYTES / 1e6).toFixed(0)} MB. Largest: ${biggest.join(', ')}`,
      });
      return;
    }

    // Written in Dutch, sent in the recipient's language.
    const locale = String(body.locale || to.locale || company.locale || 'nl');
    let finalSubject = subject;
    let finalMessage = message;
    if (locale !== 'nl') {
      const translated = await chatgpt.translateMessage(message, subject, locale);
      finalSubject = translated.subject;
      finalMessage = translated.message;
    }

    const businessEmail = process.env['BUSINESS_CONTACT_EMAIL'] || process.env['INFO_EMAIL'];
    try {
      await Mail.getInstance().sendCustomMail(to.email, to.name, finalSubject, finalMessage, locale, {
        attachments,
        fromEmail: businessEmail,
        replyTo: businessEmail,
        escapeMessage: true,
        throwOnError: true,
      });
    } catch (error: any) {
      reply.status(502).send({ success: false, error: `Sending failed: ${error?.message || error}` });
      return;
    }

    const names = attachments.map((a) => a.filename);
    await prisma.companyEvent
      .create({
        data: {
          companyId: company.id,
          userId: request.user?.id ?? null,
          type: 'mail_sent',
          content: `Mail to ${to.email}: "${finalSubject}"${names.length ? `\nAttachments: ${names.join(', ')}` : ''}`,
        },
      })
      .catch(() => undefined);

    if (body.quoteRequestId) {
      const owned = await prisma.companyQuoteRequest.findFirst({
        where: { id: Number(body.quoteRequestId), companyId: company.id },
      });
      if (owned) await quoteRequests.updateStatus(owned.id, 'sent').catch(() => undefined);
    }

    reply.send({ success: true, sentTo: to.email, attachments: names, quotationNumber });
  });

  // ---- Song years for boxd's sample cards ----

  fastify.get('/business/tracks/year', staff, async (request: any, reply: any) => {
    const artist = String(request.query.artist || '').trim();
    const title = String(request.query.title || '').trim();
    if (!artist || !title) {
      reply.status(400).send({ success: false, error: 'artist and title are required' });
      return;
    }
    const select = { id: true, artist: true, name: true, year: true, manuallyChecked: true, certainty: true };
    let candidates = await prisma.track.findMany({
      where: { artist: { equals: artist }, name: { startsWith: title }, year: { not: null } },
      select,
      take: 50,
    });
    if (!candidates.length) {
      candidates = await prisma.track.findMany({
        where: { artist: { startsWith: artist }, name: { startsWith: title }, year: { not: null } },
        select,
        take: 50,
      });
    }
    if (!candidates.length) {
      reply.status(404).send({ success: false });
      return;
    }
    // An exact title beats "Title - Remastered"; a hand-checked year beats a
    // derived one; then the most certain.
    const lowerTitle = title.toLowerCase();
    candidates.sort(
      (a: any, b: any) =>
        Number(b.name.toLowerCase() === lowerTitle) - Number(a.name.toLowerCase() === lowerTitle) ||
        Number(b.manuallyChecked) - Number(a.manuallyChecked) ||
        b.certainty - a.certainty
    );
    const best = candidates[0];
    reply.send({ success: true, year: best.year, trackId: best.id, artist: best.artist, name: best.name });
  });
}
