/**
 * Setup for the live suites. Reuses the normal test setup (env loading, test
 * database name, scratch dirs, outbound mocks) and then puts the real `fetch`
 * back: these tests exist precisely to talk to the outside world.
 */
export {};

const realFetch = globalThis.fetch;

await import('../setup');

globalThis.fetch = realFetch;
