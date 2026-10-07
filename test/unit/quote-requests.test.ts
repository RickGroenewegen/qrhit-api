import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Quote requests from the /business form: the field and file rules, and which
 * company a request lands on. Prisma, Business, mail and reCAPTCHA are mocked.
 */

const h = vi.hoisted(() => ({
  companies: [] as any[],
  users: [] as any[],
  createCompany: vi.fn(),
  upsertLeadUser: vi.fn(),
  createCompanyList: vi.fn(),
  requestCreate: vi.fn(),
  saveCompanyFile: vi.fn(),
  isHuman: true,
  spam: false,
}));

vi.mock('../../src/prisma', () => ({
  default: {
    getInstance: () => ({
      company: {
        findFirst: async ({ where }: any) =>
          h.companies.find((c) => c.name.toLowerCase() === where.name.equals.toLowerCase()) ?? null,
      },
      user: {
        count: async ({ where }: any) =>
          h.users.filter((u) => u.email === where.email && u.companyId === where.companyId).length,
      },
      companyList: {
        findFirst: async () => null,
        update: async () => ({}),
      },
      companyQuoteRequest: { create: h.requestCreate },
      companyEvent: { create: async () => ({}) },
    }),
  },
}));

vi.mock('../../src/business', () => ({
  default: {
    getInstance: () => ({
      createCompany: h.createCompany,
      upsertLeadUser: h.upsertLeadUser,
      createCompanyList: h.createCompanyList,
    }),
  },
}));

vi.mock('../../src/utils', () => ({
  default: class {
    verifyRecaptcha = async () => ({ isHuman: h.isHuman, score: 0.9 });
    isSpam = () => ({ isSpam: h.spam, reason: h.spam ? 'test' : null });
  },
}));

vi.mock('../../src/mail', () => ({
  default: { getInstance: () => ({ sendBusinessLeadNotification: async () => {} }) },
}));
vi.mock('../../src/pushover', () => ({ default: class { sendMessage = async () => {} } }));
vi.mock('../../src/translation', () => ({
  default: class {
    isValidLocale = (l: string) => ['nl', 'en', 'de', 'fr'].includes(l);
  },
}));
vi.mock('../../src/logger', () => ({ default: class { log() {} } }));
vi.mock('../../src/companyFiles', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  saveCompanyFile: h.saveCompanyFile,
}));

import QuoteRequests, { normalizeUrl, validateQuoteRequest } from '../../src/quoteRequests';

const form = (o: Record<string, any> = {}) => ({
  fullname: 'Anna de Vries',
  company: 'Bakkerij Zoet',
  email: 'Anna@Zoet.nl',
  quantity: '250',
  captchaToken: 't',
  locale: 'nl',
  ...o,
});
const file = (name: string, bytes = 10) => ({ originalName: name, buffer: Buffer.alloc(bytes) });
const anyLocale = () => true;

beforeEach(() => {
  h.companies = [];
  h.users = [];
  h.isHuman = true;
  h.spam = false;
  h.createCompany.mockReset().mockImplementation(async (data: any) => ({
    success: true,
    data: { company: { id: 900, ...data } },
  }));
  h.upsertLeadUser.mockReset().mockResolvedValue({ id: 77 });
  h.createCompanyList.mockReset().mockResolvedValue({ success: true, data: { list: { id: 55 } } });
  h.requestCreate.mockReset().mockImplementation(async ({ data }: any) => ({ id: 12, ...data }));
  h.saveCompanyFile.mockReset().mockResolvedValue({});
});

describe('validateQuoteRequest', () => {
  it('normalises the fields', () => {
    const v = validateQuoteRequest(form({ website: 'zoet.nl', phone: ' 0612 ' }), [], anyLocale);
    expect(v.email).toBe('anna@zoet.nl');
    expect(v.website).toBe('https://zoet.nl/');
    expect(v.phone).toBe('0612');
    expect(v.quantity).toBe(250);
  });

  it('needs name, company and a real e-mail', () => {
    expect(() => validateQuoteRequest(form({ email: 'nope' }), [], anyLocale)).toThrow(
      expect.objectContaining({ code: 'missing_fields' })
    );
    expect(() => validateQuoteRequest(form({ company: ' ' }), [], anyLocale)).toThrow(
      expect.objectContaining({ code: 'missing_fields' })
    );
  });

  it('sells from 100 boxes', () => {
    expect(() => validateQuoteRequest(form({ quantity: '99' }), [], anyLocale)).toThrow(
      expect.objectContaining({ code: 'quantity_min' })
    );
    expect(validateQuoteRequest(form({ quantity: 100 }), [], anyLocale).quantity).toBe(100);
  });

  it('takes at most five brand kit files of accepted types under 20 MB', () => {
    const six = Array.from({ length: 6 }, (_, i) => file(`logo${i}.png`));
    expect(() => validateQuoteRequest(form(), six, anyLocale)).toThrow(
      expect.objectContaining({ code: 'too_many_files' })
    );
    expect(() => validateQuoteRequest(form(), [file('setup.exe')], anyLocale)).toThrow(
      expect.objectContaining({ code: 'file_type' })
    );
    expect(() => validateQuoteRequest(form(), [file('movie.mp4')], anyLocale)).toThrow(
      expect.objectContaining({ code: 'file_type' })
    );
    expect(() => validateQuoteRequest(form(), [file('huge.pdf', 21 * 1024 * 1024)], anyLocale)).toThrow(
      expect.objectContaining({ code: 'file_size' })
    );
    expect(() => validateQuoteRequest(form(), [file('brand.AI'), file('kit.zip')], anyLocale)).not.toThrow();
  });

  it('falls back to Dutch for an unknown language', () => {
    expect(validateQuoteRequest(form({ locale: 'xx' }), [], (l) => l === 'en').locale).toBe('nl');
  });
});

describe('normalizeUrl', () => {
  it('adds https and refuses what is not a web address', () => {
    expect(normalizeUrl('www.zoet.nl/merk', 500)).toBe('https://www.zoet.nl/merk');
    expect(normalizeUrl('http://zoet.nl', 500)).toBe('http://zoet.nl/');
    expect(normalizeUrl('javascript:alert(1)', 500)).toBeNull();
    expect(normalizeUrl('localhost', 500)).toBeNull();
    expect(normalizeUrl('', 500)).toBeNull();
  });
});

describe('createFromForm', () => {
  const requests = QuoteRequests.getInstance();

  it('creates a company, user, list, request and brand kit files', async () => {
    const result = await requests.createFromForm(form(), [file('logo.svg')], '203.0.113.1');
    expect(result).toEqual({ requestId: 12, companyId: 900 });
    expect(h.createCompany).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Bakkerij Zoet', onlyForAdmin: true, contactemail: 'anna@zoet.nl' })
    );
    expect(h.createCompany.mock.calls[0][0]).not.toHaveProperty('test');
    expect(h.requestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ companyId: 900, listId: 55, userId: 77, quantity: 250 }),
    });
    expect(h.saveCompanyFile).toHaveBeenCalledWith(
      900,
      expect.objectContaining({ originalName: 'logo.svg' }),
      expect.objectContaining({ category: 'brand', source: 'client', quoteRequestId: 12 })
    );
  });

  it('adds a returning contact\'s request to their own company', async () => {
    h.companies = [{ id: 31, name: 'Bakkerij Zoet', contactemail: 'other@zoet.nl' }];
    h.users = [{ email: 'anna@zoet.nl', companyId: 31 }];
    const result = await requests.createFromForm(form(), [], '203.0.113.1');
    expect(result.companyId).toBe(31);
    expect(h.createCompany).not.toHaveBeenCalled();
  });

  it('never writes into a customer whose name a stranger types', async () => {
    h.companies = [{ id: 31, name: 'Bakkerij Zoet', contactemail: 'owner@zoet.nl' }];
    const result = await requests.createFromForm(form({ email: 'stranger@example.com' }), [], '203.0.113.1');
    expect(result.companyId).toBe(900);
    expect(h.createCompany).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bakkerij Zoet (2)' }));
  });

  it('stores nothing when reCAPTCHA or the spam check says no', async () => {
    h.isHuman = false;
    await expect(requests.createFromForm(form(), [file('a.png')], 'ip')).rejects.toMatchObject({ code: 'captcha' });
    h.isHuman = true;
    h.spam = true;
    await expect(requests.createFromForm(form(), [file('a.png')], 'ip')).rejects.toMatchObject({ code: 'spam' });
    expect(h.createCompany).not.toHaveBeenCalled();
    expect(h.saveCompanyFile).not.toHaveBeenCalled();
  });
});
