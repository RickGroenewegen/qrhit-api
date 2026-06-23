import { describe, it, expect, vi, beforeEach } from 'vitest';
import { outbound } from '../helpers/recording-mock';

// Extends test/unit/auth.test.ts: covers the Prisma-backed flows with the
// database mocked out. Mail is globally mocked by test/setup.ts.
const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  userGroup: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  userInGroup: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  $executeRaw: vi.fn(),
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

import Utils from '../../src/utils';
import {
  authenticateUser,
  deleteUserById,
  getUserGroups,
  verifyUser,
  resetPassword,
  checkPasswordResetToken,
  initiatePasswordReset,
  registerAccount,
  createOrUpdateAdminUser,
  generateSalt,
  hashPassword,
  verifyToken,
} from '../../src/auth';

const CAPTCHA_OK = { isHuman: true, score: 0.9 };
const CAPTCHA_FAIL = { isHuman: false, score: null };
const STRONG_PW = 'Str0ng!pass';

let captchaSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outbound.reset();
  for (const group of [prismaMock.user, prismaMock.userGroup, prismaMock.userInGroup]) {
    for (const fn of Object.values(group)) {
      (fn as any).mockReset();
    }
  }
  prismaMock.$executeRaw.mockReset();
  captchaSpy = vi
    .spyOn(Utils.prototype, 'verifyRecaptcha')
    .mockResolvedValue(CAPTCHA_OK) as any;
});

function dbUser(overrides: any = {}) {
  return {
    id: 42,
    userId: 'rick@example.com',
    email: 'rick@example.com',
    displayName: 'Rick',
    companyId: null,
    verified: true,
    locale: 'nl',
    UserGroupUser: [{ UserGroup: { name: 'users' } }],
    ...overrides,
  };
}

describe('deleteUserById', () => {
  it('deletes by id', async () => {
    prismaMock.user.delete.mockResolvedValue({});
    expect(await deleteUserById(42)).toEqual({ success: true });
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 42 } });
  });

  it('reports failure when the delete throws', async () => {
    prismaMock.user.delete.mockRejectedValue(new Error('FK constraint'));
    expect(await deleteUserById(42)).toEqual({
      success: false,
      error: 'Failed to delete user',
    });
  });
});

describe('authenticateUser', () => {
  const FAST = 1000;

  function userWithPassword(password: string, iterations: number | null) {
    const salt = generateSalt();
    return dbUser({
      password: hashPassword(password, salt, iterations ?? 10000),
      salt,
      passwordIterations: iterations,
      companyId: 7,
      UserGroupUser: [
        { UserGroup: { name: 'users' } },
        { UserGroup: { name: 'admin' } },
      ],
    });
  }

  it('returns null for an unknown user', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await authenticateUser('x@y.com', 'pw')).toBeNull();
  });

  it('returns null when the user has no password/salt set', async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      dbUser({ password: null, salt: null })
    );
    expect(await authenticateUser('rick@example.com', 'pw')).toBeNull();
  });

  it('returns null for an unverified user', async () => {
    const user = userWithPassword('pw', FAST);
    user.verified = false;
    prismaMock.user.findUnique.mockResolvedValue(user);
    expect(await authenticateUser('rick@example.com', 'pw')).toBeNull();
  });

  it('returns null for a wrong password', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userWithPassword('right', FAST));
    expect(await authenticateUser('rick@example.com', 'wrong')).toBeNull();
  });

  it('authenticates and lazily rehashes a legacy-iteration password', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userWithPassword('pw1', FAST));
    prismaMock.user.update.mockResolvedValue({});

    const result = await authenticateUser('rick@example.com', 'pw1');
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('rick@example.com');
    expect(result!.userGroups).toEqual(['users', 'admin']);
    expect(result!.companyId).toBe(7);

    const decoded = verifyToken(result!.token);
    expect(decoded).toMatchObject({
      userId: 'rick@example.com',
      userGroups: ['users', 'admin'],
      companyId: 7,
      id: 42,
      displayName: 'Rick',
    });

    // Rehash upgrade to 600k iterations
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ passwordIterations: 600000 }),
    });
  });

  it('defaults to legacy 10000 iterations when none are stored', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userWithPassword('pw2', null));
    prismaMock.user.update.mockResolvedValue({});
    const result = await authenticateUser('rick@example.com', 'pw2');
    expect(result).not.toBeNull();
  });

  it('still logs the user in when the rehash update fails', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userWithPassword('pw3', FAST));
    prismaMock.user.update.mockRejectedValue(new Error('db readonly'));
    const result = await authenticateUser('rick@example.com', 'pw3');
    expect(result).not.toBeNull();
  });

  it('returns null when the lookup throws', async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error('db down'));
    expect(await authenticateUser('rick@example.com', 'pw')).toBeNull();
  });
});

describe('getUserGroups', () => {
  it('returns group names for a user', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser());
    expect(await getUserGroups('rick@example.com')).toEqual(['users']);
  });

  it('returns [] for unknown users and on errors', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await getUserGroups('x')).toEqual([]);
    prismaMock.user.findUnique.mockRejectedValue(new Error('boom'));
    expect(await getUserGroups('x')).toEqual([]);
  });
});

describe('verifyUser', () => {
  it('requires a hash', async () => {
    expect(await verifyUser('')).toEqual({
      success: false,
      error: 'hashIsRequired',
    });
  });

  it('rejects an unknown hash', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await verifyUser('nope')).toEqual({
      success: false,
      error: 'invalidHash',
    });
  });

  it('rejects an already verified account', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ verified: true }));
    expect(await verifyUser('hash1')).toEqual({
      success: false,
      error: 'alreadyVerified',
    });
  });

  it('verifies the account, clears the hash and returns a token', async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      dbUser({ verified: false, companyId: 3 })
    );
    prismaMock.user.update.mockResolvedValue({});

    const result = await verifyUser('hash1');
    expect(result.success).toBe(true);
    expect(result.message).toBe('verificationSuccess');
    expect(result.userGroups).toEqual(['users']);
    expect(result.companyId).toBe(3);
    expect(verifyToken(result.token!)).toMatchObject({
      userId: 'rick@example.com',
    });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({
        verified: true,
        verificationHash: null,
      }),
    });
  });

  it('returns serverError when the db throws', async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error('boom'));
    expect(await verifyUser('hash1')).toEqual({
      success: false,
      error: 'serverError',
    });
  });
});

describe('resetPassword', () => {
  it('requires all fields', async () => {
    expect(await resetPassword('', STRONG_PW, STRONG_PW, 'cap')).toEqual({
      success: false,
      error: 'missingRequiredFields',
    });
  });

  it('rejects failed captcha', async () => {
    captchaSpy.mockResolvedValue(CAPTCHA_FAIL);
    expect(await resetPassword('tok', STRONG_PW, STRONG_PW, 'cap')).toEqual({
      success: false,
      error: 'captchaVerificationFailed',
    });
  });

  it('rejects mismatching passwords', async () => {
    expect(await resetPassword('tok', STRONG_PW, 'Other1!pass', 'cap')).toEqual(
      { success: false, error: 'passwordsDoNotMatch' }
    );
  });

  it.each([
    ['Sh0rt!a', 'passwordTooShort'],
    ['lowercase1!', 'passwordNeedsUppercase'],
    ['UPPERCASE1!', 'passwordNeedsLowercase'],
    ['NoNumbers!', 'passwordNeedsNumber'],
    ['NoSpecial1', 'passwordNeedsSpecialCharacter'],
  ])('enforces password strength: %s -> %s', async (pw, error) => {
    expect(await resetPassword('tok', pw, pw, 'cap')).toEqual({
      success: false,
      error,
    });
  });

  it('rejects an unknown or expired token', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await resetPassword('tok', STRONG_PW, STRONG_PW, 'cap')).toEqual({
      success: false,
      error: 'invalidOrExpiredToken',
    });

    prismaMock.user.findUnique.mockResolvedValue(
      dbUser({ passwordResetExpiry: new Date(Date.now() - 1000) })
    );
    expect(await resetPassword('tok', STRONG_PW, STRONG_PW, 'cap')).toEqual({
      success: false,
      error: 'invalidOrExpiredToken',
    });
  });

  it('updates the password and clears the reset token on success', async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      dbUser({ passwordResetExpiry: new Date(Date.now() + 3600000) })
    );
    prismaMock.user.update.mockResolvedValue({});

    expect(await resetPassword('tok', STRONG_PW, STRONG_PW, 'cap')).toEqual({
      success: true,
      message: 'passwordResetSuccess',
    });
    const updateArgs = prismaMock.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 42 });
    expect(updateArgs.data).toMatchObject({
      passwordIterations: 600000,
      passwordResetToken: null,
      passwordResetExpiry: null,
    });
    // The stored hash must verify against the new password
    expect(
      hashPassword(STRONG_PW, updateArgs.data.salt, 600000)
    ).toBe(updateArgs.data.password);
  });

  it('returns internalServerError when the db throws', async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error('boom'));
    expect(await resetPassword('tok', STRONG_PW, STRONG_PW, 'cap')).toEqual({
      success: false,
      error: 'internalServerError',
    });
  });
});

describe('checkPasswordResetToken', () => {
  it('is invalid for empty/unknown/expired tokens', async () => {
    expect(await checkPasswordResetToken('')).toEqual({ valid: false });

    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await checkPasswordResetToken('tok')).toEqual({ valid: false });

    prismaMock.user.findUnique.mockResolvedValue(
      dbUser({ passwordResetExpiry: new Date(Date.now() - 1) })
    );
    expect(await checkPasswordResetToken('tok')).toEqual({ valid: false });

    prismaMock.user.findUnique.mockRejectedValue(new Error('boom'));
    expect(await checkPasswordResetToken('tok')).toEqual({ valid: false });
  });

  it('is valid for a live token', async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      dbUser({ passwordResetExpiry: new Date(Date.now() + 1000) })
    );
    expect(await checkPasswordResetToken('tok')).toEqual({ valid: true });
  });
});

describe('initiatePasswordReset', () => {
  it('requires email and captcha token', async () => {
    expect(await initiatePasswordReset('', 'cap')).toEqual({
      success: false,
      error: 'missingRequiredFields',
    });
    expect(await initiatePasswordReset('a@b.com', '')).toEqual({
      success: false,
      error: 'missingRequiredFields',
    });
  });

  it('rejects failed captcha and invalid email formats', async () => {
    captchaSpy.mockResolvedValueOnce(CAPTCHA_FAIL);
    expect(await initiatePasswordReset('a@b.com', 'cap')).toEqual({
      success: false,
      error: 'captchaVerificationFailed',
    });
    expect(await initiatePasswordReset('not-an-email', 'cap')).toEqual({
      success: false,
      error: 'invalidEmailFormat',
    });
  });

  it('claims success for unknown users without sending mail (anti-enumeration)', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await initiatePasswordReset('ghost@example.com', 'cap')).toEqual({
      success: true,
      message: 'passwordResetEmailSent',
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(outbound.calls('Mail', 'sendPasswordResetMail')).toHaveLength(0);
  });

  it('stores a reset token and emails verified users', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ verified: true }));
    prismaMock.user.update.mockResolvedValue({});

    const result = await initiatePasswordReset('rick@example.com', 'cap');
    expect(result.success).toBe(true);

    const updateArgs = prismaMock.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 42 });
    expect(updateArgs.data.passwordResetToken).toMatch(/^[0-9a-f]{64}$/);
    expect(updateArgs.data.passwordResetExpiry.getTime()).toBeGreaterThan(
      Date.now()
    );

    const mails = outbound.calls('Mail', 'sendPasswordResetMail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'rick@example.com',
      'Rick',
      updateArgs.data.passwordResetToken,
      'nl',
    ]);
  });

  it('skips unverified users but still claims success', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ verified: false }));
    const result = await initiatePasswordReset('rick@example.com', 'cap');
    expect(result.success).toBe(true);
    expect(outbound.calls('Mail', 'sendPasswordResetMail')).toHaveLength(0);
  });

  it('returns internalServerError when the db throws', async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error('boom'));
    expect(await initiatePasswordReset('rick@example.com', 'cap')).toEqual({
      success: false,
      error: 'internalServerError',
    });
  });
});

describe('registerAccount', () => {
  const args = (over: Partial<Record<string, string>> = {}) =>
    [
      over.displayName ?? 'Rick',
      over.email ?? 'rick@example.com',
      over.password1 ?? STRONG_PW,
      over.password2 ?? STRONG_PW,
      over.captchaToken ?? 'cap',
      over.locale,
    ] as const;

  it('validates required fields, captcha, email format and passwords', async () => {
    expect(await registerAccount('', 'a@b.com', STRONG_PW, STRONG_PW, 'cap')).toEqual(
      { success: false, error: 'missingRequiredFields' }
    );

    captchaSpy.mockResolvedValueOnce(CAPTCHA_FAIL);
    expect(await registerAccount(...args())).toEqual({
      success: false,
      error: 'captchaVerificationFailed',
    });

    expect(await registerAccount(...args({ email: 'bad' }))).toEqual({
      success: false,
      error: 'invalidEmailFormat',
    });

    expect(
      await registerAccount(...args({ password2: 'Different1!' }))
    ).toEqual({ success: false, error: 'passwordsDoNotMatch' });

    expect(
      await registerAccount(...args({ password1: 'weak', password2: 'weak' }))
    ).toEqual({ success: false, error: 'passwordTooShort' });
  });

  it('rejects an already upgraded account but still sends a notification mail', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ upgraded: true }));
    expect(await registerAccount(...args())).toEqual({
      success: false,
      error: 'accountAlreadyExists',
    });
    const mails = outbound.calls('Mail', 'sendQRSongVerificationMail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual(['rick@example.com', 'Rick', '', 'en']);
  });

  it('returns accountAlreadyExists even when the notification mail fails', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ upgraded: true }));
    outbound.respondWith('Mail', 'sendQRSongVerificationMail', () => {
      throw new Error('smtp down');
    });
    expect(await registerAccount(...args())).toEqual({
      success: false,
      error: 'accountAlreadyExists',
    });
  });

  it('upgrades an existing non-upgraded account and sends verification mail', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(dbUser({ upgraded: false })) // existing user
      .mockResolvedValue(null);
    prismaMock.user.update.mockResolvedValue({ id: 42 });
    prismaMock.userGroup.findUnique.mockResolvedValue({ id: 9, name: 'users' });
    prismaMock.userInGroup.findFirst.mockResolvedValue({ id: 1 });

    expect(await registerAccount(...args({ locale: 'de' }))).toEqual({
      success: true,
      message: 'accountUpgraded',
    });

    const updateArgs = prismaMock.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ email: 'rick@example.com' });
    expect(updateArgs.data).toMatchObject({
      upgraded: true,
      verified: false,
      locale: 'de',
      passwordIterations: 600000,
    });
    expect(updateArgs.data.verificationHash).toMatch(/^[0-9a-f]{32}$/);

    const mails = outbound.calls('Mail', 'sendQRSongVerificationMail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'rick@example.com',
      'Rick',
      updateArgs.data.verificationHash,
      'de',
    ]);
    // Already in the group: no new membership row
    expect(prismaMock.userInGroup.create).not.toHaveBeenCalled();
  });

  it('creates a brand new user, the users group if needed, and membership', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 77 });
    prismaMock.userGroup.findUnique.mockResolvedValue(null);
    prismaMock.userGroup.create.mockResolvedValue({ id: 5, name: 'users' });
    prismaMock.userInGroup.findFirst.mockResolvedValue(null);
    prismaMock.userInGroup.create.mockResolvedValue({});

    expect(await registerAccount(...args())).toEqual({
      success: true,
      message: 'accountCreated',
    });

    const createArgs = prismaMock.user.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      userId: 'rick@example.com',
      email: 'rick@example.com',
      displayName: 'Rick',
      locale: 'en',
      upgraded: true,
      verified: false,
      marketingEmails: false,
    });
    expect(createArgs.data.verificationHash).toMatch(/^[0-9a-f]{32}$/);
    expect(
      hashPassword(STRONG_PW, createArgs.data.salt, 600000)
    ).toBe(createArgs.data.password);

    expect(prismaMock.userGroup.create).toHaveBeenCalledWith({
      data: { name: 'users' },
    });
    expect(prismaMock.userInGroup.create).toHaveBeenCalledWith({
      data: { userId: 77, groupId: 5 },
    });
    expect(outbound.calls('Mail', 'sendQRSongVerificationMail')).toHaveLength(1);
  });

  it('swallows group-assignment errors (registration still succeeds)', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ id: 77 });
    prismaMock.userGroup.findUnique.mockRejectedValue(new Error('boom'));
    expect(await registerAccount(...args())).toEqual({
      success: true,
      message: 'accountCreated',
    });
  });

  it('returns internalServerError when user creation throws', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockRejectedValue(new Error('db down'));
    expect(await registerAccount(...args())).toEqual({
      success: false,
      error: 'internalServerError',
    });
  });
});

describe('createOrUpdateAdminUser', () => {
  it('throws when the requested user group does not exist', async () => {
    prismaMock.userGroup.findUnique.mockResolvedValue(null);
    await expect(
      createOrUpdateAdminUser('a@b.com', 'pw', 'A', undefined, 'ghosts')
    ).rejects.toThrow('UserGroup "ghosts" does not exist');
  });

  it('blocks creating a user at or above the caller highest group', async () => {
    prismaMock.userGroup.findUnique.mockResolvedValue({ id: 1, name: 'admin' });
    await expect(
      createOrUpdateAdminUser('a@b.com', 'pw', 'A', undefined, 'admin', undefined, [
        'vibeadmin',
      ])
    ).rejects.toThrow('Insufficient permissions');

    // Same group is also blocked
    prismaMock.userGroup.findUnique.mockResolvedValue({
      id: 2,
      name: 'vibeadmin',
    });
    await expect(
      createOrUpdateAdminUser('a@b.com', 'pw', 'A', undefined, 'vibeadmin', undefined, [
        'vibeadmin',
      ])
    ).rejects.toThrow('Insufficient permissions');
  });

  it('throws when the caller groups are not rankable', async () => {
    prismaMock.userGroup.findUnique.mockResolvedValue({ id: 1, name: 'admin' });
    await expect(
      createOrUpdateAdminUser('a@b.com', 'pw', 'A', undefined, 'admin', undefined, [
        'randomgroup',
      ])
    ).rejects.toThrow('Invalid user group for permission check');
  });

  it('allows creating a lower-ranked user and connects the group', async () => {
    prismaMock.userGroup.findUnique.mockResolvedValue({
      id: 3,
      name: 'companyadmin',
    });
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null) // no existing user
      .mockResolvedValueOnce(dbUser({ id: 88 })); // fetch created user
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.userInGroup.findFirst.mockResolvedValue(null);
    prismaMock.userInGroup.create.mockResolvedValue({});

    const created = await createOrUpdateAdminUser(
      'new@b.com',
      'pw',
      'New User',
      12,
      'companyadmin',
      undefined,
      ['vibeadmin'],
      '+31612345678'
    );

    expect(created).toMatchObject({ id: 88 });
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1); // INSERT
    expect(prismaMock.userInGroup.create).toHaveBeenCalledWith({
      data: { userId: 88, groupId: 3 },
    });
  });

  it('requires a password when creating a new user', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(
      createOrUpdateAdminUser('new@b.com', '', 'New User')
    ).rejects.toThrow('Password is required when creating a new user');
  });

  it('updates an existing user without touching the password when none is given', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ id: 42 }));
    prismaMock.$executeRaw.mockResolvedValue(1);

    await createOrUpdateAdminUser('rick@example.com', '', 'Renamed', undefined, undefined, 42);

    // One raw UPDATE (displayName/email only)
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = prismaMock.$executeRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('displayName');
    expect(sql).not.toContain('password');
    // phone undefined -> not updated
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('updates the password hash and phone when provided', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ id: 42 }));
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.user.update.mockResolvedValue({});

    await createOrUpdateAdminUser(
      'rick@example.com',
      'NewPw1!aa',
      'Rick',
      undefined,
      undefined,
      42,
      undefined,
      '+31600000000'
    );

    const sql = prismaMock.$executeRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('password');
    expect(sql).toContain('passwordIterations');
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { phone: '+31600000000' },
    });
  });

  it('clears the phone when an empty string is passed', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ id: 42 }));
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.user.update.mockResolvedValue({});

    await createOrUpdateAdminUser(
      'rick@example.com', '', 'Rick', undefined, undefined, 42, undefined, ''
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { phone: null },
    });
  });

  it('rethrows database errors', async () => {
    prismaMock.user.findUnique.mockResolvedValue(dbUser({ id: 42 }));
    prismaMock.$executeRaw.mockRejectedValue(new Error('deadlock'));
    await expect(
      createOrUpdateAdminUser('rick@example.com', '', 'Rick', undefined, undefined, 42)
    ).rejects.toThrow('deadlock');
  });
});
