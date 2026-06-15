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
      // ever raised. See TESTING.md. Achieved 2026-06-15: stmts 80.39%,
      // branches 68.71%, funcs 81.52%, lines 80.57% (3418 tests).
      thresholds: {
        statements: 79,
        branches: 67,
        functions: 80,
        lines: 79,
      },
    },
  },
});
