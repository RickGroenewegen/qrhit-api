import { defineConfig } from 'vitest/config';

/**
 * Live suites: real network calls to the music services, run with
 * `npm run test:live`. Kept out of `npm test` because they need internet
 * access and fail whenever a provider changes its API - which is exactly
 * what they are for.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./test/live/setup.ts'],
    include: ['test/live/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
