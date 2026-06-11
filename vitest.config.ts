import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // Integration suites share one MariaDB test database and truncate it
    // between suites, so test files must not run concurrently.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/app.ts',
        'src/worker.ts',
        'src/locales/**',
        'src/templates/**',
        'src/interfaces/**',
        'src/**/*.d.ts',
      ],
      // Thresholds are a ratchet: set just below achieved coverage and only
      // ever raised. See TESTING.md.
      thresholds: {
        // Set after the initial harness build-out (Phase C).
      },
    },
  },
});
