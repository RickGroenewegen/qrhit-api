import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

function createPrismaAdapter(): PrismaMariaDb {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const url = new URL(connectionString);
  return new PrismaMariaDb({
    host: url.hostname,
    port: parseInt(url.port) || 3306,
    user: url.username,
    password: url.password,
    database: url.pathname.slice(1),
    connectionLimit: 5,
  });
}

class PrismaInstance {
  private static instance: PrismaClient;

  private constructor() {}

  public static getInstance(): PrismaClient {
    if (!PrismaInstance.instance) {
      const adapter = createPrismaAdapter();
      PrismaInstance.instance = new PrismaClient({ adapter });

      // Graceful shutdown - close pool cleanly so MySQL doesn't count aborted connections as errors
      const shutdown = async () => {
        await PrismaInstance.instance.$disconnect();
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    }
    return PrismaInstance.instance;
  }
}

export { createPrismaAdapter };
export default PrismaInstance;
