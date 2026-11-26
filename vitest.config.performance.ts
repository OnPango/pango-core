import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Benchmarks of the inventory import (INV-015) against the local test database
// from docker-compose.test.yml; never a remote database. Slow on purpose.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/performance/**/*.perf-spec.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
  },
});
