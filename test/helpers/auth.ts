import { generateSalt, hashPassword, generateToken } from '../../src/auth';
import { prisma } from './db';

export interface TestUser {
  user: any;
  password: string;
  token: string;
}

/**
 * Insert a user (with optional groups) using the real password hashing and
 * JWT generation from src/auth.ts, so integration tests exercise the same
 * verification paths production uses.
 */
export async function createTestUser(
  opts: {
    email?: string;
    password?: string;
    groups?: string[];
    displayName?: string;
  } = {}
): Promise<TestUser> {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = opts.email ?? `user-${unique}@test.qrsong.io`;
  const password = opts.password ?? 'Test1234!';
  const salt = generateSalt();
  // hashPassword defaults to the current iteration count (600k); store that
  // count so authenticateUser verifies with the same one.
  const passwordHash = hashPassword(password, salt);

  const user = await prisma().user.create({
    data: {
      email,
      password: passwordHash,
      salt,
      passwordIterations: 600000,
      displayName: opts.displayName ?? 'Test User',
      verified: true,
      verifiedAt: new Date(),
      userId: `test-user-${unique}`,
      hash: `test-hash-${unique}`,
    },
  });

  const groups = opts.groups ?? ['users'];
  for (const name of groups) {
    const group = await prisma().userGroup.findFirst({ where: { name } });
    if (!group) {
      throw new Error(`Unknown user group "${name}" — add it to seedBaseline().`);
    }
    await prisma().userInGroup.create({
      data: { userId: user.id, groupId: group.id },
    });
  }

  const token = generateToken(user.userId, groups, undefined, user.id);
  return { user, password, token };
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
