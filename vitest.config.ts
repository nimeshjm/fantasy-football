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
 * test/workers/globalScope.workers.test.ts exists to close: the output is fed
 * to workerd as an auxiliary Worker so that module scope actually runs.
 *
 * Runs once, when the project starts. That makes this a `vitest run` guard:
 * under `npm run test:watch` the bundle is not rebuilt as `src/` changes, so
 * a green workers project there says nothing about the current source. CI and
 * deploy both use `vitest run`, so the guard they get is accurate.
 */
async function bundleWorker(): Promise<{ scriptPath: string; modulesRoot: string }> {
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
                serviceBindings: { WORKER_UNDER_TEST: 'worker-under-test' },
                workers: [
                  {
                    name: 'worker-under-test',
                    modules: true,
                    ...bundle,
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
