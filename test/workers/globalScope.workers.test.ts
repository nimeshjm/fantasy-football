import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * The real guard for the bug class that got all the way to a failed
 * production deploy: a `new Response(...)` at module scope in
 * src/dashboard.ts. workerd disallows that kind of operation in global scope
 * and Cloudflare rejects the upload with error 10021.
 *
 * Nothing in CI caught it. `wrangler deploy --dry-run` bundles locally and
 * never evaluates module scope, so it is structurally incapable of catching
 * this, and the plain-node project never loads the entry point under
 * workerd's restrictions.
 *
 * How this closes the gap (see vitest.config.ts for the wiring): the Worker
 * is bundled by `wrangler deploy --dry-run` and handed to workerd as a
 * separate auxiliary Worker, so its module scope is evaluated at startup
 * outside any request I/O context -- the same condition Cloudflare evaluates
 * an upload under. A module-scope violation therefore fails the run before
 * any test in this file executes, with workerd's own message:
 *
 *   service core:user:worker-under-test: Uncaught Error: Disallowed
 *   operation called within global scope. Asynchronous I/O (ex: fetch() or
 *   connect()), setting a timeout, and generating random values are not
 *   allowed within global scope.
 *
 * Note that merely `import`ing src/index.ts from a test file would NOT catch
 * it: vitest-pool-workers evaluates test modules inside a request context,
 * where all of those operations are legal. Verified empirically -- the
 * defect above passes such a test.
 */

describe('worker entry point under workerd', () => {
  it('evaluates module scope and dispatches from its default export', async () => {
    // A route the Worker itself handles without touching any binding. Getting
    // this response back proves module scope evaluated cleanly (workerd
    // refuses to start the Worker otherwise) and the default export is wired
    // up. `/` is deliberately avoided: the dashboard reads D1.
    const response = await env.WORKER_UNDER_TEST.fetch('http://worker-under-test/nope');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('has the ai and workflows bindings this Worker declares', () => {
    // The reason this project could not exist before the wrangler 4 upgrade:
    // @cloudflare/vitest-pool-workers 0.5 could not emulate these. Nothing
    // here calls Workers AI or starts a Workflow -- CI has no credentials,
    // and the guard above does not need either to do its job.
    expect(env.AI).toBeDefined();
    expect(env.INGEST).toBeDefined();
    expect(env.DECIDE).toBeDefined();
    expect(env.DB).toBeDefined();
  });
});
