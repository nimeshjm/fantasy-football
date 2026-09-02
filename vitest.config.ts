import { defineConfig } from 'vitest/config';

// Plain node environment: scoring.ts is pure functions with no Workers
// runtime dependency, so @cloudflare/vitest-pool-workers would be needless
// weight here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
