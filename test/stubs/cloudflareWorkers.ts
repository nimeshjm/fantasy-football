/**
 * Test-only stand-in for the `cloudflare:workers` module, which the real
 * `vitest.config.ts` node environment cannot resolve (it is a workerd
 * built-in, not an npm package). Aliased in `vitest.config.ts` so that
 * `src/workflows/*.ts` -- which extends the real `WorkflowEntrypoint` from
 * `cloudflare:workers` -- can be imported under plain Node during tests.
 *
 * This intentionally implements only the surface `src/workflows` actually
 * uses. It is never bundled into the deployed Worker (wrangler resolves the
 * real built-in there); it exists purely so `import ... from
 * 'cloudflare:workers'` doesn't blow up module resolution under Vitest.
 */
export abstract class WorkflowEntrypoint<Env = unknown, T = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  abstract run(event: unknown, step: unknown): Promise<T>;
}
