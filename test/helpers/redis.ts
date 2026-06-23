import Cache from '../../src/cache';

/** Flush the dedicated test Redis db (REDIS_DB=9). Never touches db 0. */
export async function flushTestRedis(): Promise<void> {
  if (process.env['REDIS_DB'] !== '9') {
    throw new Error(
      `Refusing flushdb: REDIS_DB is "${process.env['REDIS_DB']}", expected "9" (test).`
    );
  }
  await Cache.getInstance().executeCommand('flushdb');
}
