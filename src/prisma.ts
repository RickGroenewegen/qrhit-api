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
    // The primary process hosts the queue worker fleet (Generator,
    // MusicFetch, Excel, Asset, AIPlaylist) which together can keep many
    // queries in flight at once. Keep dev tight to surface starvation
    // early, but give prod enough headroom for the worker pool plus HTTP
    // traffic.
    connectionLimit: process.env.NODE_ENV === 'development' ? 5 : 10,
    // The pool creates connections one at a time on the event loop and by
    // default eagerly handshakes connectionLimit connections in every
    // process at boot. Pre-warm only a couple per process, give acquires
    // headroom to survive a saturated boot, and have future pool-timeout
    // errors report connections held longer than 20s.
    minimumIdle: 2,
    acquireTimeout: 30000,
    leakDetectionTimeout: 20000,
    // A caching_sha2_password user (the MySQL 8.4 default) over a non-TLS
    // connection needs the server's RSA key for its first login after a
    // server restart. mysql2 (knex) fetches it by itself; the mariadb driver
    // refuses unless this is set. No effect for mysql_native_password users.
    allowPublicKeyRetrieval: true,
  });
}

class PrismaInstance {
  private static instance: PrismaClient;

  private constructor() {}

  public static getInstance(): PrismaClient {
    if (!PrismaInstance.instance) {
      const adapter = createPrismaAdapter();
      PrismaInstance.instance = new PrismaClient({ adapter });
    }
    return PrismaInstance.instance;
  }
}

export { createPrismaAdapter };
export default PrismaInstance;
