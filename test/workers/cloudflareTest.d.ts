/**
 * Minimal ambient declaration for `cloudflare:test`, the module
 * @cloudflare/vitest-pool-workers injects into the workerd runner.
 *
 * The package ships full types at `@cloudflare/vitest-pool-workers/types`,
 * but wiring those up means adding an entry to `compilerOptions.types` in
 * tsconfig.json, which would apply them to the plain-node project too. This
 * declares only the surface test/workers/** actually imports, and lives under
 * `test/` so the existing tsconfig `include` already covers it.
 *
 * `WORKER_UNDER_TEST` is not a real binding of this Worker: it is the service
 * binding vitest.config.ts adds to the runner, pointing at the deployable
 * bundle running as a separate Worker.
 */
declare module 'cloudflare:test' {
  export const env: import('../../src/env').Env & { WORKER_UNDER_TEST: Fetcher };
}
