import PrismaInstance from '../../src/prisma';

/**
 * Database helpers for integration suites.
 *
 * Safety: every destructive helper first verifies it is connected to a
 * database whose name ends in "_test" — defense in depth on top of the
 * setup.ts DATABASE_URL rewrite.
 */

const prisma = () => PrismaInstance.getInstance();

async function assertTestDatabase(): Promise<string> {
  const rows = await prisma().$queryRawUnsafe<{ db: string }[]>(
    'SELECT DATABASE() AS db'
  );
  const db = rows[0]?.db;
  if (!db || !db.endsWith('_test')) {
    throw new Error(
      `Refusing destructive operation: connected database is "${db}", expected a *_test database.`
    );
  }
  return db;
}

/** Truncate every table in the test database (FK checks disabled). */
export async function resetDb(): Promise<void> {
  const db = await assertTestDatabase();
  const tables = await prisma().$queryRawUnsafe<{ TABLE_NAME: string }[]>(
    `SELECT TABLE_NAME FROM information_schema.tables
     WHERE table_schema = '${db}' AND table_type = 'BASE TABLE'`
  );
  await prisma().$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const { TABLE_NAME } of tables) {
      // Prisma's own migration bookkeeping table must survive resets.
      if (TABLE_NAME === '_prisma_migrations') continue;
      await prisma().$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
    }
  } finally {
    await prisma().$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  }
}

/**
 * Minimal reference data most suites need. Grows as suites are added —
 * keep it small; suite-specific data belongs in the suite.
 */
export async function seedBaseline(): Promise<void> {
  await assertTestDatabase();
  await prisma().userGroup.createMany({
    data: [
      { id: 1, name: 'admin' },
      { id: 2, name: 'users' },
      { id: 3, name: 'companies' },
      { id: 4, name: 'resellers' },
      { id: 5, name: 'vibeadmin' },
    ],
    skipDuplicates: true,
  });
}

export { prisma };
