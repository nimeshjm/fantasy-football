import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against a bug class that got all the way to a failed production
 * deploy: a `new Response(...)` at module scope in src/dashboard.ts. workerd
 * disallows that kind of operation in global scope and Cloudflare rejects the
 * upload with error 10021.
 *
 * Nothing in CI caught it. `wrangler deploy --dry-run` only bundles locally —
 * it never contacts the Cloudflare API and never evaluates module scope — so
 * it is structurally incapable of catching this. The node tests never import
 * the worker entry under workerd's restrictions.
 *
 * The correct guard is to load the worker inside workerd, but
 * @cloudflare/vitest-pool-workers 0.5 (pinned by wrangler 3) cannot emulate
 * this Worker's `ai` or `workflows` bindings, so that needs a wrangler 4
 * upgrade — tracked separately.
 *
 * This is the cheap stand-in until then: a static check that the constructs
 * workerd forbids in global scope do not appear at module top level. It is a
 * heuristic, not a runtime check — it reasons about indentation, so it catches
 * the plain top-level declaration that actually bit us and would miss, say, a
 * construction hidden inside a top-level IIFE.
 */

const FORBIDDEN_AT_MODULE_SCOPE = [
  { pattern: /^(?:const|let|var)\s+\w+.*=\s*new\s+Response\s*\(/, name: 'new Response' },
  { pattern: /^(?:const|let|var)\s+\w+.*=\s*new\s+Request\s*\(/, name: 'new Request' },
  { pattern: /^(?:const|let|var)\s+\w+.*=\s*new\s+WebSocket\s*\(/, name: 'new WebSocket' },
  { pattern: /^(?:const|let|var)\s+\w+.*=\s*crypto\.subtle\./, name: 'crypto.subtle' },
  { pattern: /^(?:const|let|var)\s+\w+.*=\s*fetch\s*\(/, name: 'fetch' },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('no disallowed global-scope operations in src/', () => {
  it('has no module-scope Response/Request/WebSocket/crypto.subtle/fetch construction', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles('src')) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        // Module scope only: a top-level declaration starts at column 0.
        // Anything indented is inside a function or block and is fine.
        if (/^\s/.test(line)) return;
        for (const { pattern, name } of FORBIDDEN_AT_MODULE_SCOPE) {
          if (pattern.test(line)) {
            offenders.push(`${file}:${index + 1} — module-scope ${name}: ${line.trim()}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('detects the exact pattern that broke the first deploy', () => {
    // Proves the guard above is not vacuous.
    const regression = "const NOT_FOUND = new Response('Not found', { status: 404 });";
    const matched = FORBIDDEN_AT_MODULE_SCOPE.some(({ pattern }) => pattern.test(regression));
    expect(matched).toBe(true);
  });
});
