import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * The runtime half of the deploy gate. Three properties of the *deployable
 * bundle* that neither `tsc`, the node test project, nor `wrangler deploy
 * --dry-run` establishes:
 *
 *  1. its module scope evaluates under workerd's global-scope restrictions;
 *  2. its default export carries both the `fetch` and `scheduled` handlers;
 *  3. every Workflow class `wrangler.jsonc` binds is exported from it as
 *     something that could actually run.
 *
 * The first is the bug class that got all the way to a failed production
 * deploy: a `new Response(...)` at module scope in src/dashboard.ts. workerd disallows that kind of operation in global scope
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

/** The shape of the deployable bundle's exports, as read inside workerd by
 * the probe Worker vitest.config.ts builds over the same bundle. */
interface BundleShape {
  /** `Object.keys` of the default export -- the handlers Cloudflare invokes. */
  handler: string[];
  /** Every other export, by name. */
  named: Record<string, { type: string; hasRun: boolean }>;
}

async function probeBundle(): Promise<BundleShape> {
  const response = await env.HANDLER_SHAPE_PROBE.fetch('http://handler-shape-probe/');
  expect(response.status).toBe(200);
  return (await response.json()) as BundleShape;
}

describe('deployable bundle under workerd', () => {
  it('evaluates module scope and dispatches from its default export', async () => {
    // A route the Worker itself handles without touching any binding. Getting
    // this response back proves module scope evaluated cleanly (workerd
    // refuses to start the Worker otherwise) and the default export is wired
    // up. `/` is deliberately avoided: the dashboard reads D1.
    const response = await env.WORKER_UNDER_TEST.fetch('http://worker-under-test/nope');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('gates the admin routes before touching a binding', async () => {
    // A free assertion, because `WORKER_UNDER_TEST` is declared with no
    // bindings at all (see vitest.config.ts): the token gate reads only
    // `env.DASHBOARD_TOKEN` and the request, so an unconfigured deployment
    // answers 404. A handler that reached for `env.DB` first would throw
    // inside workerd and return 500 instead -- which is exactly the mistake
    // this catches.
    const response = await env.WORKER_UNDER_TEST.fetch(
      'http://worker-under-test/admin/login-probe',
      { method: 'POST' },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('does not expose the login probe over GET', async () => {
    // The probe submits real credentials to the live site, so a token-gated
    // GET would let any prefetcher that saw the ?token= URL trigger a login
    // attempt. GET must fall through to the plain 404.
    const response = await env.WORKER_UNDER_TEST.fetch(
      'http://worker-under-test/admin/login-probe',
    );

    expect(response.status).toBe(404);
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

  it('exports both the fetch and scheduled handlers it is deployed with', async () => {
    // The gap nothing else covers. `wrangler.jsonc` declares an hourly cron,
    // but `scheduled` is optional on `ExportedHandler`, so deleting the
    // handler typechecks clean, dry-runs clean and leaves the node suite
    // green -- while the deployed Worker's tick silently does nothing. All
    // three were checked against a Worker with `scheduled` removed.
    const { handler } = await probeBundle();

    expect(handler).toEqual(expect.arrayContaining(['fetch', 'scheduled']));
  });

  it('exports every Workflow class wrangler.jsonc binds, as a runnable class', () => {
    // Names come from wrangler.jsonc (see vitest.config.ts), so this asserts
    // against the deploy's own list; a third Workflow is covered the moment it
    // is configured, and an empty list throws rather than passing on nothing.
    expect(env.WORKFLOW_CLASS_NAMES.length).toBeGreaterThan(0);
  });

  it.each(env.WORKFLOW_CLASS_NAMES)('exports %s as a WorkflowEntrypoint class', async (name) => {
    // Being exported at all is already gated: `wrangler deploy --dry-run`
    // rejects a Workflow missing from the entry file. What is not gated
    // anywhere else is an export under the right name that could never run --
    // `export const IngestWorkflow = {}` passes dry-run *and* workerd's own
    // named-entrypoint validation (both checked). Hence the shape, not just
    // the name.
    const { named } = await probeBundle();

    expect(named[name]).toEqual({ type: 'function', hasRun: true });
  });
});
