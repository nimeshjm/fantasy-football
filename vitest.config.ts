import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { experimental_readRawConfig } from 'wrangler';
import { configDefaults, defineConfig } from 'vitest/config';

const execFileAsync = promisify(execFile);
const root = import.meta.dirname;
const WRANGLER_CONFIG = './wrangler.jsonc';
const WORKER_UNDER_TEST = 'worker-under-test';
const HANDLER_SHAPE_PROBE = 'handler-shape-probe';

/** The subset of miniflare's module-definition shape this file uses.
 *
 * Declared here rather than imported from `miniflare`: it is a transitive
 * dependency of @cloudflare/vitest-pool-workers, currently on an alpha
 * release, and declaring a direct dependency on that just to borrow one type
 * is the worse trade. Annotating the literal `type` is most of what the real
 * type would buy: unannotated, a typo in it passes `tsc` (checked). A field
 * miniflare renames outright would stop workerd from starting, which is loud
 * enough on its own. */
interface ProbeModule {
  type: 'ESModule';
  path: string;
  contents?: string;
}

/** What `bundleWorker` hands to miniflare: the deployable bundle's entry and
 * the module root it resolves against. */
interface Bundle {
  scriptPath: string;
  modulesRoot: string;
}

// Two projects, because the two halves of the suite need mutually exclusive
// module resolution:
//
//  * `node` -- the bulk of the suite. `scoring.ts` and friends are pure
//    functions with no Workers runtime dependency, so workerd would be
//    needless weight. `cloudflare:workers` is a workerd built-in (not an npm
//    package), so `src/workflows/*.ts` -- which extends the real
//    `WorkflowEntrypoint` from that module -- cannot resolve it under plain
//    Node. It is aliased to a minimal test-only stub (see
//    test/stubs/cloudflareWorkers.ts) so those files can be imported and
//    unit-tested here; wrangler resolves the real built-in at deploy time,
//    this alias never ships.
//
//  * `workers` -- test/workers/**, run inside workerd by
//    @cloudflare/vitest-pool-workers. Here the *real* `cloudflare:workers`
//    built-in must resolve, so the stub alias above must NOT apply. That is
//    the whole reason for the split: one config cannot both alias and not
//    alias the same specifier.
//
// `npm run test` runs both. CI and deploy need no changes.

/**
 * Bundles the Worker exactly as a deploy would, and returns the entry point
 * of the bundle along with its module root.
 *
 * `wrangler deploy --dry-run` is the real bundler over the real
 * `wrangler.jsonc` (module resolution, `nodejs_compat` shims, aliasing), and
 * it contacts nothing -- no credentials, no account. What it does *not* do is
 * evaluate the bundle's module scope, which is precisely the gap
 * test/workers/deployContract.workers.test.ts exists to close: the output is fed
 * to workerd as an auxiliary Worker so that module scope actually runs.
 *
 * Runs once, when the project starts. That makes this a `vitest run` guard:
 * under `npm run test:watch` the bundle is not rebuilt as `src/` changes, so
 * a green workers project there says nothing about the current source. CI and
 * deploy both use `vitest run`, so the guard they get is accurate.
 */
async function bundleWorker(): Promise<Bundle> {
  const outdir = mkdtempSync(path.join(tmpdir(), 'ff-worker-bundle-'));
  await execFileAsync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', outdir], {
    cwd: root,
  });

  // Discovered rather than assumed to be `index.js`: the basename tracks
  // `main` in wrangler.jsonc, so hardcoding it would turn "the entry point
  // was renamed" into a bare ENOENT that reads like a broken harness.
  const entries = readdirSync(outdir).filter((name) => name.endsWith('.js'));
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) {
    throw new Error(
      `Expected exactly one .js entry in the Worker bundle, found ${entries.length}: ${entries.join(', ')}`,
    );
  }

  return { scriptPath: path.join(outdir, entry), modulesRoot: outdir };
}

/**
 * A second Worker over the same bundle: a tiny entry module that imports the
 * real one and reports the shape of its default export over `fetch`.
 *
 * This exists because `scheduled` is the one part of the deploy contract
 * nothing else checks. `wrangler.jsonc` declares an hourly cron trigger, but:
 *
 *  * `tsc` does not require the handler -- `scheduled` is optional on
 *    `ExportedHandler`, so *deleting* it typechecks clean (a *typo* is caught,
 *    as an excess property, but a deletion is not);
 *  * `wrangler deploy --dry-run` bundles and uploads nothing, and does not
 *    cross-check the cron trigger against the handlers the entry exports;
 *  * the node project tests `runScheduledTick` directly, never through the
 *    export.
 *
 * All three were verified against a Worker with `scheduled` removed: every
 * gate stayed green. The Worker would have deployed and the hourly tick would
 * have silently done nothing.
 *
 * Asking the runtime rather than the source is what makes this exact: the
 * probe reads `Object.keys` off the same default export Cloudflare would
 * invoke, inside workerd, after the bundle's module scope has run.
 *
 * It reports the bundle's named exports too, so the same request settles the
 * Workflow classes `wrangler.jsonc` binds. `wrangler deploy --dry-run` does
 * reject a Workflow that is not exported at all ("Your Worker depends on the
 * following Workflows, which are not exported in your entrypoint file"), so
 * that much is already gated. What nothing gates is an export under the right
 * name that is not a `WorkflowEntrypoint` -- `export const IngestWorkflow =
 * {}` passes dry-run, and passes workerd's own named-entrypoint validation
 * (both checked). Reporting `typeof` and whether `prototype.run` exists lets
 * the test require a class that could actually run.
 *
 * A separate Worker rather than a wrapper around the entry, so that
 * `worker-under-test` stays the unmodified deployable bundle -- the
 * module-scope guard depends on that.
 *
 * The modules are listed explicitly, with the probe first as the entry.
 * `modules: true` (what `worker-under-test` uses, being a single file) does
 * not follow the probe's import of the bundle, and workerd then fails to
 * start with `No such module "index.js"`.
 */
function handlerShapeProbeModules(bundle: Bundle): ProbeModule[] {
  const entryName = path.basename(bundle.scriptPath);

  return [
    {
      type: 'ESModule',
      // Never read from disk -- `contents` is the module. The path only fixes
      // the module's name, and must sit under `modulesRoot` for the relative
      // import below to resolve.
      path: path.join(bundle.modulesRoot, '__handlerShapeProbe.js'),
      contents: `import handler, * as bundle from './${entryName}';

const shapeOf = (value) => ({
  type: typeof value,
  hasRun: typeof value === 'function' && typeof value.prototype?.run === 'function',
});

export default {
  fetch() {
    return Response.json({
      handler: handler !== null && typeof handler === 'object' ? Object.keys(handler) : [],
      named: Object.fromEntries(
        Object.entries(bundle)
          .filter(([name]) => name !== 'default')
          .map(([name, value]) => [name, shapeOf(value)]),
      ),
    });
  },
};
`,
    },
    { type: 'ESModule', path: bundle.scriptPath },
  ];
}

/**
 * workerd only accepts compatibility dates its own binary knows about, and
 * the workerd bundled with miniflare 5 (a @cloudflare/vitest-pool-workers
 * dependency) currently caps below `wrangler.jsonc`'s date. Clamp rather than
 * fail to start.
 *
 * This is a fidelity gap worth being explicit about: the global-scope
 * restriction workerd enforces is not compatibility-date gated, so clamping
 * does not weaken the guard. It would only matter for behaviour that is
 * date-gated, which is not what these tests assert.
 */
const MAX_SUPPORTED_COMPATIBILITY_DATE = '2026-08-22';

/**
 * Mirrors wrangler.jsonc's compatibility settings rather than duplicating
 * them, clamping the date to what the bundled workerd accepts.
 *
 * `experimental_readRawConfig` is the same API @cloudflare/vitest-pool-workers
 * uses internally, but it is experimental and wrangler moves often here. A
 * failure is caught rather than thrown, because throwing during config load
 * would take down the node project's 187 tests as well; falling back leaves
 * any real mismatch to surface as a scoped workerd startup error instead.
 */
function workerdCompatibility(): { compatibilityDate: string; compatibilityFlags: string[] } {
  const clamp = (date: string) =>
    date > MAX_SUPPORTED_COMPATIBILITY_DATE ? MAX_SUPPORTED_COMPATIBILITY_DATE : date;

  try {
    const { rawConfig } = experimental_readRawConfig({ config: WRANGLER_CONFIG });
    return {
      compatibilityDate: clamp(rawConfig.compatibility_date ?? MAX_SUPPORTED_COMPATIBILITY_DATE),
      compatibilityFlags: [...(rawConfig.compatibility_flags ?? [])],
    };
  } catch (error) {
    console.warn(
      `[vitest.config] could not read ${WRANGLER_CONFIG} compatibility settings, falling back to defaults: ${error}`,
    );
    return {
      compatibilityDate: MAX_SUPPORTED_COMPATIBILITY_DATE,
      compatibilityFlags: ['nodejs_compat'],
    };
  }
}

/**
 * The Workflow classes `wrangler.jsonc` binds, handed to the workers project
 * so its assertions name the same classes a deploy would.
 *
 * Read from the config rather than listed here, so adding a third Workflow
 * extends the guard without touching this file, and anything unexpected --
 * an empty list, a missing `class_name` -- throws rather than leaving an
 * assertion that iterates nothing. Unlike
 * `workerdCompatibility`, a read failure is *not* swallowed: falling back
 * would leave a guard that passes while checking nothing, which is the
 * failure mode this whole project exists to rule out.
 */
function workflowClassNames(): string[] {
  const { rawConfig } = experimental_readRawConfig({ config: WRANGLER_CONFIG });

  // `rawConfig` is typed loosely enough that `workflows` arrives as `any`, so
  // the shape is checked here rather than asserted -- a cast would turn a
  // wrangler schema change into a guard that silently checks nothing.
  const workflows: unknown = rawConfig.workflows ?? [];
  if (!Array.isArray(workflows) || workflows.length === 0) {
    throw new Error(
      `Expected a non-empty \`workflows\` array in ${WRANGLER_CONFIG}, got ${JSON.stringify(workflows)}; the Workflow export guard would check nothing.`,
    );
  }

  return workflows.map((workflow: unknown, index) => {
    const className = (workflow as { class_name?: unknown }).class_name;
    if (typeof className !== 'string') {
      throw new Error(
        `Expected \`workflows[${index}].class_name\` in ${WRANGLER_CONFIG} to be a string, got ${JSON.stringify(className)}.`,
      );
    }
    return className;
  });
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/workers/**'],
        },
        resolve: {
          alias: {
            'cloudflare:workers': path.resolve(root, 'test/stubs/cloudflareWorkers.ts'),
          },
        },
      },
      {
        plugins: [
          cloudflareTest(async () => {
            const bundle = await bundleWorker();
            const compatibility = workerdCompatibility();
            const workflowClasses = workflowClassNames();

            return {
              // The runner Worker gets this project's real bindings straight
              // from wrangler.jsonc -- `ai`, both `workflows`, D1 and the
              // vars. That is what @cloudflare/vitest-pool-workers 0.5 could
              // not do and 0.22 can.
              wrangler: { configPath: WRANGLER_CONFIG },

              // Keep every binding local. Left at its default, the `ai`
              // binding is proxied to the real account, which means an API
              // call and therefore credentials -- and CI deliberately has
              // none (only deploy.yml touches secrets). These tests never
              // call Workers AI or run a Workflow; they only need the
              // bindings to exist.
              remoteBindings: false,

              miniflare: {
                ...compatibility,

                // The deployable bundle, run as a separate Worker so that
                // workerd evaluates its module scope at startup -- outside
                // any request I/O context, exactly as Cloudflare does when
                // validating an upload. Importing src/index.ts from a test
                // file instead would prove nothing: test modules are
                // evaluated inside a request, where the operations workerd
                // forbids in global scope are all perfectly legal.
                serviceBindings: { WORKER_UNDER_TEST, HANDLER_SHAPE_PROBE },

                // wrangler.jsonc's Workflow class names, so the test asserts
                // against the deploy's own list rather than a copy of it.
                bindings: { WORKFLOW_CLASS_NAMES: workflowClasses },

                workers: [
                  {
                    name: WORKER_UNDER_TEST,
                    modules: true,
                    scriptPath: bundle.scriptPath,
                    modulesRoot: bundle.modulesRoot,
                    ...compatibility,
                  },
                  {
                    name: HANDLER_SHAPE_PROBE,
                    modules: handlerShapeProbeModules(bundle),
                    modulesRoot: bundle.modulesRoot,
                    ...compatibility,
                  },
                ],
              },
            };
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/workers/**/*.test.ts'],
        },
      },
    ],
  },
});
