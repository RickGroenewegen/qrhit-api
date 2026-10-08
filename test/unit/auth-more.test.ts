import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import {
  authenticateUser,
  deleteUserById,
  createOrUpdateAdminUser,
  generateSalt,
  hashPassword,
  verifyToken,
} from '../../src/auth';

beforeEach(() => {
  for (const group of [prismaMock.user, prismaMock.userGroup, prismaMock.userInGroup]) {
    for (const fn of Object.values(group)) {
      (fn as any).mockReset();
    }
  }
  prismaMock.$executeRaw.mockReset();
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
        'companyadmin',
      ])
    ).rejects.toThrow('Insufficient permissions');

    // Same group is also blocked
    prismaMock.userGroup.findUnique.mockResolvedValue({
      id: 2,
      name: 'companyadmin',
    });
    await expect(
      createOrUpdateAdminUser('a@b.com', 'pw', 'A', undefined, 'companyadmin', undefined, [
        'companyadmin',
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
      ['admin'],
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
