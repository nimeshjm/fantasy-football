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
 * None of the three names below are real bindings of this Worker; they are
 * what vitest.config.ts adds to the runner: `WORKER_UNDER_TEST` points at the
 * deployable bundle running as a separate Worker, `HANDLER_SHAPE_PROBE` at the
 * generated Worker that reports that bundle's export shape, and
 * `WORKFLOW_CLASS_NAMES` carries `wrangler.jsonc`'s Workflow class names.
 */
declare module 'cloudflare:test' {
  export const env: import('../../src/env').Env & {
    WORKER_UNDER_TEST: Fetcher;
    HANDLER_SHAPE_PROBE: Fetcher;
    WORKFLOW_CLASS_NAMES: string[];
  };
}
