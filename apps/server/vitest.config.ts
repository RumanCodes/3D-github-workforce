import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC keeps decorator metadata so Nest-based tests can resolve dependencies.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false, // tests share one Postgres database
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/workforce_test',
      GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
      REDIS_PREFIX: 'workforce-test',
    },
    testTimeout: 20_000,
  },
});
