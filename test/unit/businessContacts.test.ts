/**
 * Unit tests for src/businessContacts.ts: the company contacts reconciled
 * onto the NL/EN/DE EmailOctopus business lists.
 *
 *  - axios            → EmailOctopus reads and writes stubbed
 *  - ../../src/prisma → companies from an in-memory stub
 * Pushover stays on the global recording proxy (asserted via `outbound`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { outbound } from '../helpers/recording-mock';

const prismaMock = vi.hoisted(() => ({
  company: { findMany: vi.fn() },
}));
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

vi.mock('axios');
import axios from 'axios';
const axiosGet = vi.mocked(axios.get);
const axiosPut = vi.mocked(axios.put);
const axiosDelete = vi.mocked(axios.delete);

import BusinessContacts, {
  BusinessCompanyRow,
  CurrentContact,
  businessListFor,
  planBusinessSync,
  splitName,
  wantedContacts,
} from '../../src/businessContacts';

const LISTS = { nl: 'list-nl', en: 'list-en', de: 'list-de' };

function company(overrides: Partial<BusinessCompanyRow> = {}): BusinessCompanyRow {
  return {
    id: 1,
    name: 'Acme',
    locale: 'nl',
    countrycode: 'NL',
    contact: 'Jan de Vries',
    contactemail: 'jan@acme.nl',
    excludeFromMailing: false,
    updatedAt: new Date('2026-09-01'),
    User: [],
    ...overrides,
  };
}

function user(email: string, displayName: string, groups: string[] = ['companyadmin']) {
  return {
    email,
    displayName,
    UserGroupUser: groups.map((name) => ({ UserGroup: { name } })),
  };
}

function onList(
  email: string,
  list: 'nl' | 'en' | 'de',
  overrides: Partial<CurrentContact> = {}
): CurrentContact {
  return {
    email,
    list,
    status: 'subscribed',
    fields: { FirstName: 'Jan', LastName: 'de Vries', CompanyName: 'Acme', Country: 'NL' },
    ...overrides,
  };
}

/** Stub the three lists' contents for GET /lists/{id}/contacts. */
function listContents(contents: Partial<Record<'nl' | 'en' | 'de', CurrentContact[]>>) {
  axiosGet.mockImplementation(async (url: string) => {
    const key = (Object.keys(LISTS) as ('nl' | 'en' | 'de')[]).find((k) =>
      url.includes(`/lists/${LISTS[k]}/`)
    )!;
    const data = (contents[key] || []).map((c) => ({
      email_address: c.email,
      status: c.status,
      fields: c.fields,
    }));
    return { data: { data, paging: { next: null } } } as any;
  });
}

const md5 = (email: string) => crypto.createHash('md5').update(email).digest('hex');

describe('businessListFor', () => {
  it('maps nl and NULL to NL, de to DE and every other language to EN', () => {
    expect(businessListFor('nl')).toBe('nl');
    expect(businessListFor(null)).toBe('nl');
    expect(businessListFor('')).toBe('nl');
    expect(businessListFor('DE')).toBe('de');
    expect(businessListFor('en')).toBe('en');
    expect(businessListFor('pt')).toBe('en');
  });
});

describe('splitName', () => {
  it('splits at the first space', () => {
    expect(splitName('Jan de Vries')).toEqual({ FirstName: 'Jan', LastName: 'de Vries' });
    expect(splitName('Jan')).toEqual({ FirstName: 'Jan', LastName: '' });
    expect(splitName(null)).toEqual({ FirstName: '', LastName: '' });
  });
});

describe('wantedContacts', () => {
  it('takes the contact address and the users, lowercased and once each', () => {
    const { contacts } = wantedContacts([
      company({
        contactemail: ' Jan@Acme.nl ',
        User: [user('jan@acme.nl', 'Jan V.'), user('piet@acme.nl', 'Piet Jansen')],
      }),
    ]);
    expect([...contacts.keys()]).toEqual(['jan@acme.nl', 'piet@acme.nl']);
    expect(contacts.get('jan@acme.nl')!.fields).toEqual({
      FirstName: 'Jan',
      LastName: 'de Vries',
      CompanyName: 'Acme',
      Country: 'NL',
    });
  });

  it('leaves out staff and reports invalid addresses', () => {
    const { contacts, invalid } = wantedContacts([
      company({
        contactemail: 'not-an-address',
        User: [user('rick@qrsong.io', 'Rick', ['admin', 'users']), user('admin@acme.nl', 'A', ['admin'])],
      }),
    ]);
    expect(contacts.size).toBe(0);
    expect(invalid).toEqual(['not-an-address']);
  });

  it('leaves out an excluded company, unless the address is also on a company that is not', () => {
    const { contacts, excluded } = wantedContacts([
      company({
        id: 1,
        excludeFromMailing: true,
        User: [user('piet@acme.nl', 'Piet'), user('both@acme.nl', 'Both')],
      }),
      company({ id: 2, name: 'Other', contactemail: 'both@acme.nl', updatedAt: new Date('2025-01-01') }),
    ]);
    expect([...contacts.keys()]).toEqual(['both@acme.nl']);
    expect(contacts.get('both@acme.nl')!.fields.CompanyName).toBe('Other');
    expect(excluded).toEqual(['jan@acme.nl', 'piet@acme.nl']);
  });

  it('puts an address on two companies with the latest updated one', () => {
    const { contacts } = wantedContacts([
      company({ id: 1, name: 'Old', locale: 'de', updatedAt: new Date('2026-01-01') }),
      company({ id: 2, name: 'New', locale: 'en', updatedAt: new Date('2026-09-01') }),
      company({ id: 3, name: 'Oldest', locale: 'nl', updatedAt: new Date('2025-01-01') }),
    ]);
    const jan = contacts.get('jan@acme.nl')!;
    expect(jan.fields.CompanyName).toBe('New');
    expect(jan.list).toBe('en');
  });
});

describe('planBusinessSync', () => {
  const wanted = (rows: BusinessCompanyRow[]) => wantedContacts(rows).contacts;

  it('adds a new contact, leaves an equal one and updates a changed one', () => {
    const contacts = wanted([
      company({ User: [user('piet@acme.nl', 'Piet Jansen'), user('kees@acme.nl', 'Kees')] }),
    ]);
    const { actions, unchanged } = planBusinessSync(contacts, [
      onList('jan@acme.nl', 'nl'),
      onList('piet@acme.nl', 'nl', { fields: { FirstName: 'Piet', LastName: 'Jansen', CompanyName: 'Old name', Country: 'NL' } }),
    ]);
    expect(unchanged).toBe(1);
    expect(actions.map((a) => [a.type, 'contact' in a ? a.contact.email : a.email])).toEqual([
      ['update', 'piet@acme.nl'],
      ['add', 'kees@acme.nl'],
    ]);
  });

  it('treats a missing field as empty', () => {
    const onlyFirstName = wanted([company({ contact: 'Jan' })]);
    const { actions, unchanged } = planBusinessSync(onlyFirstName, [
      onList('jan@acme.nl', 'nl', { fields: { FirstName: 'Jan', CompanyName: 'Acme', Country: 'NL' } }),
    ]);
    expect(actions).toEqual([]);
    expect(unchanged).toBe(1);

    const withLastName = wanted([company()]);
    expect(
      planBusinessSync(withLastName, [
        onList('jan@acme.nl', 'nl', { fields: { FirstName: 'Jan', CompanyName: 'Acme', Country: 'NL' } }),
      ]).actions
    ).toEqual([{ type: 'update', contact: withLastName.get('jan@acme.nl') }]);
  });

  it('moves a contact to the new language and carries an unsubscribe along', () => {
    const contacts = wanted([company({ locale: 'de' })]);
    expect(planBusinessSync(contacts, [onList('jan@acme.nl', 'nl')]).actions).toEqual([
      { type: 'move', contact: contacts.get('jan@acme.nl'), from: ['nl'] },
    ]);
    expect(
      planBusinessSync(contacts, [onList('jan@acme.nl', 'nl', { status: 'unsubscribed' })]).actions
    ).toEqual([
      { type: 'move', contact: contacts.get('jan@acme.nl'), from: ['nl'], status: 'unsubscribed' },
    ]);
  });

  it('removes a subscribed contact who left and keeps an unsubscribed one', () => {
    const { actions } = planBusinessSync(new Map(), [
      onList('gone@acme.nl', 'nl'),
      onList('pending@acme.nl', 'en', { status: 'pending' }),
      onList('optout@acme.nl', 'de', { status: 'unsubscribed' }),
    ]);
    expect(actions).toEqual([
      { type: 'remove', email: 'gone@acme.nl', list: 'nl' },
      { type: 'remove', email: 'pending@acme.nl', list: 'en' },
      { type: 'keep', email: 'optout@acme.nl', list: 'de' },
    ]);
  });

  it('marks the removal of an excluded company contact, and still keeps an unsubscribed one', () => {
    const { actions } = planBusinessSync(
      new Map(),
      [onList('ex@acme.nl', 'nl'), onList('exout@acme.nl', 'nl', { status: 'unsubscribed' })],
      new Set(['ex@acme.nl', 'exout@acme.nl'])
    );
    expect(actions).toEqual([
      { type: 'remove', email: 'ex@acme.nl', list: 'nl', excluded: true },
      { type: 'keep', email: 'exout@acme.nl', list: 'nl' },
    ]);
  });
});

describe('BusinessContacts.sync', () => {
  const service = BusinessContacts.getInstance();

  beforeEach(() => {
    service.writeDelayMs = 0;
    service.retryDelayMs = 0;
    axiosGet.mockReset();
    axiosPut.mockReset().mockResolvedValue({ data: {} } as any);
    axiosDelete.mockReset().mockResolvedValue({ data: {} } as any);
    prismaMock.company.findMany.mockReset();
    outbound.reset();
    process.env['MAIL_OCTOPUS_API_KEY'] = 'eo_test';
    process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_NL'] = LISTS.nl;
    process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_EN'] = LISTS.en;
    process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_DE'] = LISTS.de;
  });

  afterEach(() => {
    delete process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_NL'];
    delete process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_EN'];
    delete process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_DE'];
  });

  it('skips when a list id is not configured', async () => {
    delete process.env['MAIL_OCTOPUS_BUSINESS_LIST_ID_DE'];
    const result = await service.sync();
    expect(result.skippedReason).toBe('not_configured');
    expect(prismaMock.company.findMany).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('adds without a status, so a new contact is subscribed and an existing one keeps theirs', async () => {
    prismaMock.company.findMany.mockResolvedValue([company({ locale: 'en' })]);
    listContents({});
    const result = await service.sync();

    expect(result.added).toEqual(['jan@acme.nl']);
    expect(result.perList).toEqual({ nl: 0, en: 1, de: 0 });
    expect(axiosPut).toHaveBeenCalledTimes(1);
    const [url, body, opts] = axiosPut.mock.calls[0] as any[];
    expect(url).toBe(`https://api.emailoctopus.com/lists/${LISTS.en}/contacts`);
    expect(body).toEqual({
      email_address: 'jan@acme.nl',
      fields: { FirstName: 'Jan', LastName: 'de Vries', CompanyName: 'Acme', Country: 'NL' },
    });
    expect(body).not.toHaveProperty('status');
    expect(opts.headers.Authorization).toBe('Bearer eo_test');
  });

  it('reads every page of a list', async () => {
    prismaMock.company.findMany.mockResolvedValue([company()]);
    axiosGet.mockImplementation(async (url: string, opts: any) => {
      if (!url.includes(LISTS.nl)) return { data: { data: [], paging: { next: null } } } as any;
      if (!opts.params.starting_after) {
        return { data: { data: [], paging: { next: { starting_after: 'cursor-1' } } } } as any;
      }
      const c = onList('jan@acme.nl', 'nl');
      return {
        data: { data: [{ email_address: c.email, status: c.status, fields: c.fields }], paging: { next: null } },
      } as any;
    });
    const result = await service.sync();
    expect(result.unchanged).toBe(1);
    expect(axiosPut).not.toHaveBeenCalled();
    expect(axiosGet).toHaveBeenCalledTimes(4);
  });

  it('moves with the unsubscribe carried along, then deletes from the old list', async () => {
    prismaMock.company.findMany.mockResolvedValue([company({ locale: 'de' })]);
    listContents({ nl: [onList('jan@acme.nl', 'nl', { status: 'unsubscribed' })] });
    const result = await service.sync();

    expect(result.moved).toEqual(['jan@acme.nl']);
    const [url, body] = axiosPut.mock.calls[0] as any[];
    expect(url).toContain(`/lists/${LISTS.de}/contacts`);
    expect(body.status).toBe('unsubscribed');
    expect(axiosDelete).toHaveBeenCalledWith(
      `https://api.emailoctopus.com/lists/${LISTS.nl}/contacts/${md5('jan@acme.nl')}`,
      expect.anything()
    );
  });

  it('removes a contact who left and keeps one who unsubscribed', async () => {
    prismaMock.company.findMany.mockResolvedValue([company()]);
    listContents({
      nl: [
        onList('jan@acme.nl', 'nl'),
        onList('gone@acme.nl', 'nl'),
        onList('optout@acme.nl', 'nl', { status: 'unsubscribed' }),
      ],
    });
    const result = await service.sync();
    expect(result.removed).toEqual(['gone@acme.nl']);
    expect(result.kept).toEqual(['optout@acme.nl']);
    expect(axiosDelete).toHaveBeenCalledTimes(1);
    expect((axiosDelete.mock.calls[0] as any[])[0]).toContain(md5('gone@acme.nl'));
  });

  it('removes nothing and alerts when a run would empty the lists', async () => {
    prismaMock.company.findMany.mockResolvedValue([]);
    listContents({
      nl: Array.from({ length: 12 }, (_, i) => onList(`person${i}@acme.nl`, 'nl')),
    });
    const result = await service.sync();
    expect(result.removalsBlocked).toBe(true);
    expect(result.removed).toEqual([]);
    expect(axiosDelete).not.toHaveBeenCalled();
    const pushes = outbound.calls('PushoverClient', 'sendMessage');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].args[0].message).toContain('Not removing 12 of 12');
  });

  it('removes the contacts of excluded companies however many there are', async () => {
    prismaMock.company.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) =>
        company({ id: i, contactemail: `person${i}@acme.nl`, excludeFromMailing: true })
      )
    );
    listContents({
      nl: Array.from({ length: 12 }, (_, i) => onList(`person${i}@acme.nl`, 'nl')),
    });
    const result = await service.sync();
    expect(result.removalsBlocked).toBe(false);
    expect(result.removed).toHaveLength(12);
    expect(result.excluded).toHaveLength(12);
    expect(axiosDelete).toHaveBeenCalledTimes(12);
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('plans without writing in a dry run', async () => {
    prismaMock.company.findMany.mockResolvedValue([
      company({ User: [user('piet@acme.nl', 'Piet')] }),
    ]);
    listContents({ nl: [onList('gone@acme.nl', 'nl')] });
    const result = await service.sync({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.added).toEqual(['jan@acme.nl', 'piet@acme.nl']);
    expect(result.removed).toEqual(['gone@acme.nl']);
    expect(axiosPut).not.toHaveBeenCalled();
    expect(axiosDelete).not.toHaveBeenCalled();
  });

  it('retries once on 429, skips a 422 and counts other failures as errors', async () => {
    prismaMock.company.findMany.mockResolvedValue([
      company({ contactemail: 'slow@acme.nl', User: [user('bad@acme.nl', 'B'), user('down@acme.nl', 'D')] }),
    ]);
    listContents({});
    axiosPut.mockImplementation(async (_url: string, body: any) => {
      if (body.email_address === 'slow@acme.nl' && axiosPut.mock.calls.length === 1) {
        throw { response: { status: 429 } };
      }
      if (body.email_address === 'bad@acme.nl') {
        throw { response: { status: 422, data: { detail: 'Invalid email' } } };
      }
      if (body.email_address === 'down@acme.nl') throw new Error('socket hang up');
      return { data: {} } as any;
    });
    const result = await service.sync();
    expect(result.added).toEqual(['slow@acme.nl']);
    expect(result.skipped).toEqual(['bad@acme.nl']);
    expect(result.errors).toEqual(['down@acme.nl']);
  });

  it('pushes and rethrows when reading a list fails', async () => {
    prismaMock.company.findMany.mockResolvedValue([company()]);
    axiosGet.mockRejectedValue(new Error('401 Unauthorized'));
    await expect(service.sync()).rejects.toThrow('401 Unauthorized');
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(1);
    expect(service.isRunning()).toBe(false);
  });
});
