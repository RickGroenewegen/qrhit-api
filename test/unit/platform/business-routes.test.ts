import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

/**
 * The asset store, the mail endpoint and the public quote request form on a
 * bare Fastify instance. Prisma is an in-memory stand-in, files go to a temp
 * PRIVATE_DIR, mail and translation are spies.
 */

const h = vi.hoisted(() => ({
  files: [] as any[],
  nextFileId: 1,
  quotations: [] as any[],
  sendCustomMail: vi.fn(),
  translateMessage: vi.fn(),
  createFromForm: vi.fn(),
  events: [] as any[],
}));

vi.mock('../../../src/prisma', () => ({
  default: {
    getInstance: () => ({
      company: {
        findUnique: async ({ where }: any) =>
          ({
            1: { id: 1, name: 'Zoet', contactemail: 'anna@zoet.nl', contact: 'Anna', locale: 'nl' },
            2: { id: 2, name: 'Other', contactemail: 'bob@other.nl', contact: 'Bob', locale: 'en' },
          })[where.id as 1 | 2] ?? null,
      },
      companyFile: {
        create: async ({ data }: any) => {
          const row = { id: h.nextFileId++, createdAt: new Date(), ...data };
          h.files.push(row);
          return row;
        },
        findMany: async ({ where }: any) =>
          h.files.filter(
            (f) => f.companyId === where.companyId && (!where.id || where.id.in.includes(f.id))
          ),
        findUnique: async ({ where }: any) => h.files.find((f) => f.id === where.id) ?? null,
        delete: async ({ where }: any) => {
          h.files = h.files.filter((f) => f.id !== where.id);
        },
        update: async ({ where, data }: any) => {
          const row = h.files.find((f) => f.id === where.id);
          Object.assign(row, data);
          return row;
        },
      },
      user: {
        findFirst: async ({ where }: any) =>
          where.id === 10 && where.companyId === 1
            ? { email: 'piet@zoet.nl', displayName: 'Piet', locale: 'de' }
            : null,
      },
      quotation: {
        findFirst: async ({ where }: any) =>
          h.quotations.find((q) => q.id === where.id && q.companyId === where.companyId) ?? null,
      },
      companyQuoteRequest: { findFirst: async () => null },
      companyEvent: {
        create: async ({ data }: any) => {
          h.events.push(data);
          return data;
        },
      },
    }),
  },
}));

vi.mock('../../../src/mail', () => ({
  default: { getInstance: () => ({ sendCustomMail: h.sendCustomMail }) },
}));

vi.mock('../../../src/chatgpt', () => ({
  ChatGPT: class {
    translateMessage = h.translateMessage;
  },
}));

vi.mock('../../../src/translation', () => ({
  default: class {
    resolveBusinessLocale = (l: string) => (['nl', 'en', 'de'].includes(l) ? l : 'en');
    getBusinessTranslator = async () => (key: string) => (key === 'fileName' ? 'Offerte' : key);
  },
}));

vi.mock('../../../src/quoteRequests', () => {
  class QuoteRequestError extends Error {
    constructor(public code: string, message: string, public statusCode = 400) {
      super(message);
    }
  }
  return {
    default: {
      getInstance: () => ({
        createFromForm: h.createFromForm,
        updateStatus: async () => ({}),
      }),
    },
    QuoteRequestError,
    BRAND_KIT_MAX_FILES: 5,
    BRAND_KIT_MAX_BYTES: 20 * 1024 * 1024,
  };
});

vi.mock('../../../src/boxOptionsQuotation', () => ({
  boxOptionsQuotationView: vi.fn(),
  createBoxOptionsQuotation: vi.fn(),
  quotationOptionsSummary: vi.fn(),
  verifyQuotationSignature: () => false,
}));

vi.mock('../../../src/services/boxOptionsPricing', () => ({
  BoxOptionsError: class extends Error {},
}));

import businessRoutes from '../../../src/routes/businessRoutes';
import { QuoteRequestError } from '../../../src/quoteRequests';

let app: FastifyInstance;
let privateDir: string;

function multipart(parts: Array<{ name: string; value?: string; filename?: string; content?: Buffer }>) {
  const boundary = '----qrsongtest';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        )
      );
      chunks.push(p.content ?? Buffer.from('x'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value ?? ''}`));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

beforeAll(async () => {
  privateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'company-files-'));
  process.env['PRIVATE_DIR'] = privateDir;
  app = Fastify();
  await app.register(require('@fastify/multipart'));
  const getAuthHandler = () => ({
    preHandler: async (request: any) => {
      request.user = { id: 5, userId: 'admin@qrsong.io', userGroups: ['admin'] };
    },
  });
  await businessRoutes(app, getAuthHandler);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(privateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(privateDir, 'company-files'), { recursive: true, force: true });
  h.files = [];
  h.nextFileId = 1;
  h.quotations = [];
  h.events = [];
  h.sendCustomMail.mockReset().mockResolvedValue(undefined);
  h.translateMessage.mockReset().mockImplementation(async (message: string, subject: string) => ({
    subject: `[de] ${subject}`,
    message: `[de] ${message}`,
  }));
  h.createFromForm.mockReset();
});

async function upload(companyId: number, filename: string, content = Buffer.from('data'), category = 'design') {
  return app.inject({
    method: 'POST',
    url: `/vibe/companies/${companyId}/files`,
    ...multipart([
      { name: 'category', value: category },
      { name: 'file', filename, content },
    ]),
  });
}

describe('asset store', () => {
  it('stores a file privately and lists it with the mail limit', async () => {
    const res = await upload(1, 'Box ontwerp.pdf');
    expect(res.statusCode).toBe(201);
    const [file] = res.json().files;
    expect(file).toMatchObject({ originalName: 'Box ontwerp.pdf', category: 'design', mimeType: 'application/pdf', size: 4 });
    const onDisk = await fs.readdir(path.join(privateDir, 'company-files', '1'));
    expect(onDisk).toHaveLength(1);

    const list = await app.inject({ method: 'GET', url: '/vibe/companies/1/files' });
    expect(list.json()).toMatchObject({ success: true, mailLimitBytes: expect.any(Number) });
    expect(list.json().files).toHaveLength(1);
  });

  it('refuses a file type that is not on the list', async () => {
    const res = await upload(1, 'run.exe');
    expect(res.statusCode).toBe(400);
    expect(h.files).toHaveLength(0);
  });

  it('never serves one company\'s file under another company', async () => {
    const id = (await upload(1, 'logo.png')).json().files[0].id;
    const other = await app.inject({ method: 'GET', url: `/vibe/companies/2/files/${id}/download` });
    expect(other.statusCode).toBe(404);
    const own = await app.inject({ method: 'GET', url: `/vibe/companies/1/files/${id}/download` });
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-disposition']).toMatch(/^attachment;/);
    expect(own.headers['x-content-type-options']).toBe('nosniff');
  });

  it('deletes the file and its row', async () => {
    const id = (await upload(1, 'a.pdf')).json().files[0].id;
    const res = await app.inject({ method: 'DELETE', url: `/vibe/companies/1/files/${id}` });
    expect(res.statusCode).toBe(200);
    expect(h.files).toHaveLength(0);
    expect(await fs.readdir(path.join(privateDir, 'company-files', '1'))).toHaveLength(0);
  });
});

describe('mail to a contact', () => {
  it('sends to a company user in their language with the files attached', async () => {
    const id = (await upload(1, 'ontwerp.pdf', Buffer.from('%PDF'))).json().files[0].id;
    const res = await app.inject({
      method: 'POST',
      url: '/vibe/companies/1/mail',
      payload: { userId: 10, subject: 'Jullie box', message: 'Hierbij het ontwerp', locale: 'de', fileIds: [id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sentTo: 'piet@zoet.nl', attachments: ['ontwerp.pdf'] });
    const [to, name, subject, message, locale, options] = h.sendCustomMail.mock.calls[0];
    expect([to, name, subject, message, locale]).toEqual([
      'piet@zoet.nl',
      'Piet',
      '[de] Jullie box',
      '[de] Hierbij het ontwerp',
      'de',
    ]);
    expect(options.attachments[0]).toMatchObject({ filename: 'ontwerp.pdf', contentType: 'application/pdf' });
    expect(options).toMatchObject({ escapeMessage: true, throwOnError: true });
    expect(h.events[0]).toMatchObject({ companyId: 1, type: 'mail_sent' });
  });

  it('does not translate Dutch', async () => {
    await app.inject({
      method: 'POST',
      url: '/vibe/companies/1/mail',
      payload: { email: 'ANNA@zoet.nl', subject: 'S', message: 'M', locale: 'nl', fileIds: [] },
    });
    expect(h.translateMessage).not.toHaveBeenCalled();
    expect(h.sendCustomMail.mock.calls[0][0]).toBe('anna@zoet.nl');
  });

  it('only mails contacts of the company', async () => {
    const stranger = await app.inject({
      method: 'POST',
      url: '/vibe/companies/1/mail',
      payload: { email: 'someone@else.com', subject: 'S', message: 'M', fileIds: [] },
    });
    expect(stranger.statusCode).toBe(400);
    const otherCompanyUser = await app.inject({
      method: 'POST',
      url: '/vibe/companies/2/mail',
      payload: { userId: 10, subject: 'S', message: 'M', fileIds: [] },
    });
    expect(otherCompanyUser.statusCode).toBe(400);
    expect(h.sendCustomMail).not.toHaveBeenCalled();
  });

  it('refuses another company\'s files', async () => {
    const id = (await upload(2, 'theirs.pdf')).json().files[0].id;
    const res = await app.inject({
      method: 'POST',
      url: '/vibe/companies/1/mail',
      payload: { userId: 10, subject: 'S', message: 'M', fileIds: [id] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stops above the size limit and names the biggest file', async () => {
    const id = (await upload(1, 'huge.pdf', Buffer.alloc(8 * 1000 * 1000))).json().files[0].id;
    const res = await app.inject({
      method: 'POST',
      url: '/vibe/companies/1/mail',
      payload: { userId: 10, subject: 'S', message: 'M', locale: 'nl', fileIds: [id] },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/huge\.pdf/);
    expect(h.sendCustomMail).not.toHaveBeenCalled();
  });

  it('attaches the archived quotation PDF', async () => {
    h.quotations = [{ id: 3, companyId: 1, quotationNumber: 'QRS12345678', locale: 'nl' }];
    await fs.mkdir(path.join(privateDir, 'quotation'), { recursive: true });
    await fs.writeFile(path.join(privateDir, 'quotation', 'QRS12345678.pdf'), '%PDF');
    const res = await app.inject({
      method: 'POST',
      url: '/vibe/companies/1/mail',
      payload: { userId: 10, subject: 'S', message: 'M', locale: 'nl', fileIds: [], quotationId: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().attachments).toEqual(['Offerte_Zoet_QRS12345678.pdf']);
  });
});

describe('public quote request', () => {
  it('hands fields and brand kit files to the request flow', async () => {
    h.createFromForm.mockResolvedValue({ requestId: 4, companyId: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/business/quote-request',
      ...multipart([
        { name: 'fullname', value: 'Anna' },
        { name: 'quantity', value: '250' },
        { name: 'brandKit', filename: 'logo.svg', content: Buffer.from('<svg/>') },
      ]),
    });
    expect(res.json()).toEqual({ success: true, requestId: 4 });
    const [fields, files] = h.createFromForm.mock.calls[0];
    expect(fields).toMatchObject({ fullname: 'Anna', quantity: '250' });
    expect(files[0]).toMatchObject({ originalName: 'logo.svg' });
  });

  it('answers a refused request with its code', async () => {
    h.createFromForm.mockRejectedValue(new QuoteRequestError('quantity_min', 'The minimum is 100 boxes'));
    const res = await app.inject({
      method: 'POST',
      url: '/business/quote-request',
      ...multipart([{ name: 'quantity', value: '50' }]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, code: 'quantity_min' });
  });

  it('refuses a sixth brand kit file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/business/quote-request',
      ...multipart(
        Array.from({ length: 6 }, (_, i) => ({ name: 'brandKit', filename: `f${i}.png`, content: Buffer.from('x') }))
      ),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('too_many_files');
    expect(h.createFromForm).not.toHaveBeenCalled();
  });
});
