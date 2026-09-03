import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Plain node environment: scoring.ts is pure functions with no Workers
// runtime dependency, so @cloudflare/vitest-pool-workers would be needless
// weight here.
//
// `cloudflare:workers` is a workerd built-in (not an npm package), so
// `src/workflows/*.ts` -- which extends the real `WorkflowEntrypoint` from
// that module -- cannot resolve it under plain Node. Alias it to a minimal
// test-only stub (see test/stubs/cloudflareWorkers.ts) so those files can be
// imported and unit-tested here; wrangler resolves the real built-in at
// deploy time, this alias never ships.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'cloudflare:workers': path.resolve(__dirname, 'test/stubs/cloudflareWorkers.ts'),
    },
  },
});
