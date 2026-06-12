/**
 * Unit tests for src/vibe.ts — handleCompanyListCreate + createCompany.
 *
 * DB is fully mocked (fake prisma vi.fn()s, see ./vibe-mocks). Mail and
 * Pushover ride the global recording proxies from test/setup.ts and are
 * asserted via `outbound`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, resetAll } from './vibe-mocks';
import { outbound } from '../../helpers/recording-mock';

vi.mock('../../../src/prisma', async () => (await import('./vibe-mocks')).prismaModule());
vi.mock('../../../src/cache', async () => (await import('./vibe-mocks')).cacheModule());
vi.mock('../../../src/utils', async () => (await import('./vibe-mocks')).utilsModule());
vi.mock('../../../src/auth', async () => (await import('./vibe-mocks')).authModule());
vi.mock('../../../src/mollie', async () => (await import('./vibe-mocks')).mollieModule());
vi.mock('../../../src/discount', async () => (await import('./vibe-mocks')).discountModule());
vi.mock('../../../src/data', async () => (await import('./vibe-mocks')).dataModule());
vi.mock('../../../src/spotify', async () => (await import('./vibe-mocks')).spotifyModule());
vi.mock('../../../src/generator', async () => (await import('./vibe-mocks')).generatorModule());
vi.mock('../../../src/translation', async () => (await import('./vibe-mocks')).translationModule());
vi.mock('../../../src/logger', async () => (await import('./vibe-mocks')).loggerModule());
vi.mock('sharp', async () => (await import('./vibe-mocks')).sharpModule());
vi.mock('fs/promises', async () => (await import('./vibe-mocks')).fsModule());

import Vibe from '../../../src/vibe';

const vibe = Vibe.getInstance();

process.env['FRONTEND_VOTING_URI'] = 'https://vote.test';

const GOOD_PASSWORD = 'Abcdefg1!';

function baseBody(overrides: Record<string, any> = {}) {
  return {
    fullname: 'Rick Tester',
    company: 'Acme & Co!',
    email: 'rick@acme.test',
    captchaToken: 'tok',
    ...overrides,
  };
}

/** Wire up all prisma mocks for a successful end-to-end create. */
function arrangeHappyPath() {
  // createCompany
  h.prisma.company.findFirst.mockResolvedValue(null);
  h.prisma.company.create.mockResolvedValue({ id: 7, name: 'Acme & Co!' });
  // contact user + portal user lookups
  h.prisma.user.findUnique.mockResolvedValue(null);
  h.prisma.user.create.mockImplementation(async ({ data }: any) => ({
    id: 99,
    ...data,
  }));
  h.prisma.user.update.mockImplementation(async ({ data }: any) => ({
    id: 99,
    ...data,
  }));
  // groups
  h.prisma.userGroup.findUnique.mockImplementation(async ({ where }: any) =>
    where.name === 'companyadmin'
      ? { id: 30, name: 'companyadmin' }
      : where.name === 'qrvoteadmin'
        ? { id: 40, name: 'qrvoteadmin' }
        : null
  );
  h.prisma.userGroup.create.mockResolvedValue({ id: 31, name: 'users' });
  h.prisma.userInGroup.findFirst.mockResolvedValue(null);
  h.prisma.userInGroup.create.mockResolvedValue({ id: 1 });
  // createCompanyList
  h.prisma.company.findUnique.mockResolvedValue({ id: 7, name: 'Acme & Co!' });
  h.prisma.companyList.findFirst.mockResolvedValue(null);
  h.prisma.companyList.create.mockImplementation(async ({ data }: any) => ({
    id: 55,
    ...data,
  }));
}

beforeEach(() => {
  resetAll();
  outbound.reset();
});

describe('handleCompanyListCreate — validation gates', () => {
  it('rejects missing required fields with 400', async () => {
    const res = await vibe.handleCompanyListCreate({ fullname: 'X' }, '1.1.1.1');
    expect(res).toMatchObject({
      success: false,
      statusCode: 400,
      error: 'Missing required fields: fullname, company, email',
    });
    expect(h.utils.verifyRecaptcha).not.toHaveBeenCalled();
  });

  it('rejects when reCAPTCHA verification fails', async () => {
    h.utils.verifyRecaptcha.mockResolvedValue({ isHuman: false, score: 0.1 });
    const res = await vibe.handleCompanyListCreate(baseBody(), '1.1.1.1');
    expect(res).toMatchObject({
      success: false,
      statusCode: 400,
      error: 'reCAPTCHA verification failed',
    });
  });

  it('rejects spam-flagged submissions and never creates anything', async () => {
    h.utils.isSpam.mockReturnValue({ isSpam: true, reason: 'Honeypot field filled' });
    const res = await vibe.handleCompanyListCreate(
      baseBody({ honeypot: 'gotcha' }),
      '1.1.1.1'
    );
    expect(res).toMatchObject({
      success: false,
      statusCode: 400,
      error: 'Message detected as spam',
    });
    expect(h.prisma.company.create).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords', async () => {
    const res = await vibe.handleCompanyListCreate(
      baseBody({ password1: GOOD_PASSWORD, password2: 'Different1!' }),
      '1.1.1.1'
    );
    expect(res).toMatchObject({
      success: false,
      statusCode: 400,
      error: 'Passwords do not match',
    });
  });

  it.each([
    ['Ab1!x', 'Password must be at least 8 characters long'],
    ['abcdefg1!', 'Password must contain at least one uppercase letter'],
    ['ABCDEFG1!', 'Password must contain at least one lowercase letter'],
    ['Abcdefghi!', 'Password must contain at least one number'],
    ['Abcdefgh1', 'Password must contain at least one special character'],
  ])('rejects weak password %s', async (pw, expectedError) => {
    const res = await vibe.handleCompanyListCreate(
      baseBody({ password1: pw, password2: pw }),
      '1.1.1.1'
    );
    expect(res).toMatchObject({ success: false, statusCode: 400, error: expectedError });
  });
});

describe('handleCompanyListCreate — happy path (companyadmin)', () => {
  it('creates company, user, list, sends portal mail and pushover', async () => {
    arrangeHappyPath();
    const res = await vibe.handleCompanyListCreate(
      baseBody({
        password1: GOOD_PASSWORD,
        password2: GOOD_PASSWORD,
        phone: '0612345678',
        marketingEmails: true,
      }),
      '1.2.3.4'
    );

    expect(res.success).toBe(true);
    expect(res.company.id).toBe(7);
    expect(res.list.id).toBe(55);
    expect(res.portalWelcomeSent).toBe(true);

    // Company created as non-lead (no source: 'business')
    expect(h.prisma.company.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Acme & Co!',
        test: false,
        onlyForAdmin: false,
        contact: 'Rick Tester',
        contactemail: 'rick@acme.test',
        contactphone: '0612345678',
      }),
    });

    // Portal user: verified immediately, hashed credentials, nl locale
    expect(h.prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'rick@acme.test',
        email: 'rick@acme.test',
        displayName: 'Rick Tester',
        password: 'hash-1',
        salt: 'salt-1',
        companyId: 7,
        locale: 'nl',
        marketingEmails: true,
        verified: true,
        verificationHash: null,
      }),
    });
    expect(h.auth.hashPassword).toHaveBeenCalledWith(GOOD_PASSWORD, 'salt-1');

    // Slugified list with portal defaults
    expect(h.prisma.companyList.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 7,
        name: 'Acme & Co!',
        slug: 'acme-co',
        numberOfCards: 200,
        numberOfTracks: 5,
        playlistSource: 'voting',
        status: 'new',
        qrvote: false,
      }),
    });

    // Welcome mail with the portal URL built from the slug
    const mails = outbound.calls('Mail', 'sendPortalWelcomeEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'rick@acme.test',
      'Rick Tester',
      'Acme & Co!',
      'https://vote.test/hitlist/acme-co',
      'rick@acme.test',
      GOOD_PASSWORD,
      'nl',
      'https://vote.test',
    ]);
    expect(outbound.calls('Mail', 'sendQRVoteWelcomeEmail')).toHaveLength(0);

    // Pushover notification, not forced (not a business lead)
    const pushes = outbound.calls('PushoverClient', 'sendMessage');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].args[0].title).toBe('New company registered');
    expect(pushes[0].args[0].message).toContain('Phone: 0612345678');
    expect(pushes[0].args[1]).toBe('1.2.3.4');
    expect(pushes[0].args[2]).toBe(false);
  });

  it('generates a random password when none is supplied and mails it', async () => {
    arrangeHappyPath();
    const res = await vibe.handleCompanyListCreate(baseBody(), '1.1.1.1');
    expect(res.success).toBe(true);
    const mailArgs = outbound.calls('Mail', 'sendPortalWelcomeEmail')[0].args;
    expect(mailArgs[5]).toMatch(/^[a-z0-9]+$/);
    expect(mailArgs[5].length).toBeGreaterThanOrEqual(8);
    expect(h.auth.hashPassword).toHaveBeenCalledWith(mailArgs[5], 'salt-1');
  });

  it('still succeeds when the welcome mail and pushover both fail', async () => {
    arrangeHappyPath();
    outbound.respondWith('Mail', 'sendPortalWelcomeEmail', () =>
      Promise.reject(new Error('smtp down'))
    );
    outbound.respondWith('PushoverClient', 'sendMessage', () =>
      Promise.reject(new Error('pushover down'))
    );
    const res = await vibe.handleCompanyListCreate(baseBody(), '1.1.1.1');
    expect(res.success).toBe(true);
    expect(res.portalWelcomeSent).toBe(true);
  });

  it('survives user-group connection failures (ensureUserInGroup swallows errors)', async () => {
    arrangeHappyPath();
    h.prisma.userInGroup.create.mockRejectedValue(new Error('fk violation'));
    const res = await vibe.handleCompanyListCreate(baseBody(), '1.1.1.1');
    expect(res.success).toBe(true);
  });
});

describe('handleCompanyListCreate — QRVote flow', () => {
  it('creates an unverified user with verification hash and sends QRVote mail', async () => {
    arrangeHappyPath();
    const res = await vibe.handleCompanyListCreate(
      baseBody({ qrvote: 'true' }),
      '1.1.1.1'
    );
    expect(res.success).toBe(true);

    const createData = h.prisma.user.create.mock.calls[0][0].data;
    expect(createData.verified).toBe(false);
    expect(createData.verifiedAt).toBeNull();
    expect(createData.verificationHash).toMatch(/^[0-9a-f]{32}$/);

    // List flagged as qrvote
    expect(h.prisma.companyList.create.mock.calls[0][0].data.qrvote).toBe(true);

    // QRVote mail carries the verification hash; portal mail not sent
    const mails = outbound.calls('Mail', 'sendQRVoteWelcomeEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args[4]).toBe(createData.verificationHash);
    expect(outbound.calls('Mail', 'sendPortalWelcomeEmail')).toHaveLength(0);

    // qrvoteadmin group used
    expect(h.prisma.userGroup.findUnique).toHaveBeenCalledWith({
      where: { name: 'qrvoteadmin' },
    });
  });

  it('re-issues a verification hash for an existing user and adopts them into the company', async () => {
    arrangeHappyPath();
    const existing = {
      id: 5,
      email: 'rick@acme.test',
      companyId: null,
      phone: null,
      verificationHash: null,
    };
    // First lookup is createCompany's contact-user check, second is the
    // portal-user lookup; both should see the existing user.
    h.prisma.user.findUnique.mockResolvedValue(existing as any);
    h.prisma.user.update.mockImplementation(async ({ data }: any) => ({
      ...existing,
      ...data,
    }));

    const res = await vibe.handleCompanyListCreate(
      baseBody({ qrvote: '1', phone: '0611111111' }),
      '1.1.1.1'
    );
    expect(res.success).toBe(true);
    expect(h.prisma.user.create).not.toHaveBeenCalled();

    // 1st update: new verification hash, unverified
    const firstUpdate = h.prisma.user.update.mock.calls[0][0];
    expect(firstUpdate.where).toEqual({ id: 5 });
    expect(firstUpdate.data.verified).toBe(false);
    expect(firstUpdate.data.verificationHash).toMatch(/^[0-9a-f]{32}$/);

    // 2nd update: merge patch adopts companyId + phone
    const secondUpdate = h.prisma.user.update.mock.calls[1][0];
    expect(secondUpdate.data).toEqual({ companyId: 7, phone: '0611111111' });
  });

  it('never moves an existing user that already belongs to another company', async () => {
    arrangeHappyPath();
    h.prisma.user.findUnique.mockResolvedValue({
      id: 5,
      email: 'rick@acme.test',
      companyId: 3,
      phone: '06999',
    } as any);

    const res = await vibe.handleCompanyListCreate(
      baseBody({ phone: '0611111111' }),
      '1.1.1.1'
    );
    expect(res.success).toBe(true);
    // No qrvote, companyId set, phone set -> no update at all
    expect(h.prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('handleCompanyListCreate — business intake (source=business)', () => {
  it('creates a lead company, skips the welcome mail, forces pushover', async () => {
    arrangeHappyPath();
    const res = await vibe.handleCompanyListCreate(
      baseBody({ source: 'business', message: 'Call me back' }),
      '9.9.9.9'
    );
    expect(res.success).toBe(true);

    expect(h.prisma.company.create.mock.calls[0][0].data).toMatchObject({
      test: true,
      onlyForAdmin: true,
      message: 'Call me back',
    });

    expect(outbound.calls('Mail', 'sendPortalWelcomeEmail')).toHaveLength(0);
    expect(outbound.calls('Mail', 'sendQRVoteWelcomeEmail')).toHaveLength(0);

    const push = outbound.calls('PushoverClient', 'sendMessage')[0];
    expect(push.args[0].message).toContain('Message: Call me back');
    expect(push.args[2]).toBe(true); // always notify for business leads
  });
});

describe('handleCompanyListCreate — downstream failures', () => {
  it('returns 409 when the company already exists', async () => {
    h.prisma.company.findFirst.mockResolvedValue({ id: 1, name: 'Acme & Co!' });
    const res = await vibe.handleCompanyListCreate(baseBody(), '1.1.1.1');
    expect(res).toMatchObject({
      success: false,
      statusCode: 409,
      error: 'Company with this name already exists',
    });
  });

  it('returns 409 when the list slug already exists', async () => {
    arrangeHappyPath();
    h.prisma.companyList.findFirst.mockResolvedValue({ id: 2, slug: 'acme-co' });
    const res = await vibe.handleCompanyListCreate(baseBody(), '1.1.1.1');
    expect(res).toMatchObject({
      success: false,
      statusCode: 409,
      error: 'Slug bestaat al. Kies een unieke slug.',
    });
  });

  it('returns 500 on unexpected errors', async () => {
    arrangeHappyPath();
    h.prisma.userGroup.findUnique.mockRejectedValue(new Error('db gone'));
    const res = await vibe.handleCompanyListCreate(baseBody(), '1.1.1.1');
    expect(res).toMatchObject({
      success: false,
      statusCode: 500,
      error: 'Internal server error',
    });
  });
});

describe('createCompany', () => {
  it('rejects an empty name', async () => {
    const res = await vibe.createCompany({ name: '   ' });
    expect(res).toMatchObject({ success: false, error: 'Company name cannot be empty' });
  });

  it('rejects duplicates (trimmed name match)', async () => {
    h.prisma.company.findFirst.mockResolvedValue({ id: 1, name: 'Dup' });
    const res = await vibe.createCompany({ name: '  Dup  ' });
    expect(res).toMatchObject({
      success: false,
      error: 'Company with this name already exists',
    });
    expect(h.prisma.company.findFirst).toHaveBeenCalledWith({
      where: { name: { equals: 'Dup' } },
    });
  });

  it('creates the company with defaults and no contact user when no contactemail', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockResolvedValue({ id: 12, name: 'Solo' });
    const res = await vibe.createCompany({ name: ' Solo ' });
    expect(res.success).toBe(true);
    expect(res.data.company.id).toBe(12);
    expect(h.prisma.company.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Solo',
        test: false,
        followUp: false,
        onlyForAdmin: false,
      }),
    });
    expect(h.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(h.auth.createOrUpdateAdminUser).not.toHaveBeenCalled();
  });

  it('auto-creates a companyadmin contact user for a new contact email', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockResolvedValue({ id: 12, name: 'WithContact' });
    h.prisma.user.findUnique.mockResolvedValue(null);

    const res = await vibe.createCompany({
      name: 'WithContact',
      contact: ' Jane Doe ',
      contactemail: 'jane@x.test',
      contactphone: ' 0612 ',
    });
    expect(res.success).toBe(true);
    expect(h.auth.createOrUpdateAdminUser).toHaveBeenCalledWith(
      'jane@x.test',
      expect.stringMatching(/^[0-9a-f]{32}$/), // random hex password
      'Jane Doe',
      12,
      'companyadmin',
      undefined,
      undefined,
      '0612'
    );
  });

  it('skips contact user creation when the user already exists', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockResolvedValue({ id: 12, name: 'X' });
    h.prisma.user.findUnique.mockResolvedValue({ id: 4, email: 'jane@x.test' } as any);
    const res = await vibe.createCompany({ name: 'X', contactemail: 'jane@x.test' });
    expect(res.success).toBe(true);
    expect(h.auth.createOrUpdateAdminUser).not.toHaveBeenCalled();
  });

  it('still succeeds when contact user creation fails', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockResolvedValue({ id: 12, name: 'X' });
    h.prisma.user.findUnique.mockResolvedValue(null);
    h.auth.createOrUpdateAdminUser.mockRejectedValue(new Error('boom'));
    const res = await vibe.createCompany({ name: 'X', contactemail: 'jane@x.test' });
    expect(res.success).toBe(true);
  });

  it('maps prisma failures to a generic error', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockRejectedValue(new Error('db down'));
    const res = await vibe.createCompany({ name: 'X' });
    expect(res).toMatchObject({ success: false, error: 'Error creating company' });
  });
});
