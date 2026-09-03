/**
 * The token gate shared by every operator-only route (`GET /`, `POST
 * /admin/login-probe`).
 *
 * Extracted from src/dashboard.ts rather than copied: duplicated
 * 404-not-401 logic drifts, and the drift is silent — a route that starts
 * answering 401 advertises that a token-gated endpoint exists there.
 *
 * The contract, unchanged from the dashboard's original:
 *  - `DASHBOARD_TOKEN` must both be CONFIGURED and MATCH.
 *  - Every failure is a 404, never a 401, so an unconfigured deployment and
 *    a wrong token are indistinguishable from "no such route".
 *  - The comparison is constant-time, so response timing cannot be used to
 *    brute-force the token one character at a time.
 *
 * The gate touches only `env.DASHBOARD_TOKEN` and the request — never a
 * binding. That is what lets the deploy-contract test fetch these routes on
 * a bundle loaded with no bindings at all and get a clean 404 rather than a
 * 500 (see test/workers/deployContract.workers.test.ts).
 */

export interface AdminAuthEnv {
  DASHBOARD_TOKEN?: string;
}

/**
 * A fresh 404 per call, deliberately a factory rather than a shared
 * constant.
 *
 * Two reasons, either sufficient. First, constructing a Response with a body
 * at module scope is a disallowed global-scope operation in workerd and
 * Cloudflare rejects the upload outright (error 10021) — this is the exact
 * defect that failed a production deploy and that test/globalScope.test.ts
 * and test/workers/deployContract.workers.test.ts now guard. Second, a
 * Response body can only be consumed once, so handing the same instance to
 * two requests would serve a used body to the second.
 */
export function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/** Constant-time-ish string comparison: the loop always runs the same
 * number of iterations regardless of where the strings first differ, so
 * response time doesn't leak how many leading characters matched. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 32);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    const x = i < aBytes.length ? aBytes[i]! : 0;
    const y = i < bBytes.length ? bBytes[i]! : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

function extractToken(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) return fromQuery;
  const header = request.headers.get('x-dashboard-token');
  if (header) return header;
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return null;
}

/** True iff `DASHBOARD_TOKEN` is configured and the request presents it. */
export function isAuthorized(request: Request, env: AdminAuthEnv): boolean {
  if (!env.DASHBOARD_TOKEN) return false;
  const token = extractToken(request);
  return token !== null && timingSafeEqual(token, env.DASHBOARD_TOKEN);
}
