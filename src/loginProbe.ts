/**
 * `POST /admin/login-probe` — issue #14's fourth checkbox, runnable without
 * touching live config.
 *
 * `SESSION_PROVIDER` is `manual` because `POST player/login/` is rejected
 * for this account: it returns `400 non_field_errors: "Incorrect username or
 * password"`, the B2C-provisioned case where the account has no usable
 * Django-side password. If a password ever does get set on the site,
 * `password` becomes the strictly better provider — it needs no maintenance
 * and cannot silently expire — so that has to be re-checkable after any
 * account change. Flipping the live `SESSION_PROVIDER` var to find out is a
 * deploy and a gamble; this route just asks.
 *
 * Deliberate choices:
 *  - POST, not GET. A token-gated GET that submits real credentials means
 *    any prefetcher or link scanner that sees the `?token=` URL triggers a
 *    login attempt against the live account. The operator runs this from a
 *    terminal.
 *  - Rate-limited via a `config` key. Repeated failed logins are an
 *    account-lockout vector, and this route is the only thing in the system
 *    that can generate them on demand.
 *  - Reports `configured: false` distinctly from `ok: false`. Under
 *    `manual`, FANTASY_EMAIL/FANTASY_PASSWORD may simply never have been
 *    set; that is a prerequisite the operator must fix, not a login result.
 *  - Never writes the session store. The heartbeat's read-modify-write of
 *    the `session` row assumes the cron is its only writer.
 *  - Returns a FINGERPRINT of any freshly-issued cookie, never the cookie.
 *    Comparing it against the dashboard's fingerprint is exactly the
 *    diagnostic this is for: same cookie, or a rotation?
 */

import { isAuthorized, notFound, type AdminAuthEnv } from './adminAuth';
import {
  ApiValidationError,
  FantasyApiClient,
  extractCookieValue,
  getSetCookies,
} from './api/client';
import { loginRaw } from './api/endpoints';
import { getConfig, setConfig, type DbEnv } from './db';
import {
  fingerprintCookie,
  LOGIN_PROBE_LAST_AT_KEY,
  LOGIN_PROBE_MIN_INTERVAL_MS,
} from './sessionHealth';

export interface LoginProbeEnv extends AdminAuthEnv, DbEnv {
  FANTASY_BASE_URL: string;
  FANTASY_EMAIL?: string;
  FANTASY_PASSWORD?: string;
}

export interface LoginProbeResult {
  /** Whether both credential secrets are set at all. When false, nothing was
   * sent and `ok` is meaningless. */
  configured: boolean;
  /** Whether the login succeeded and returned a sessionid. */
  ok: boolean;
  /** The site's own rejection detail, verbatim, on a 400. */
  fieldErrors?: unknown;
  /** Fingerprint of the sessionid the site issued, when it issued one. */
  cookieFingerprint?: string;
  /** Why no attempt was made (unconfigured, or rate-limited). */
  detail?: string;
}

export async function handleLoginProbe(request: Request, env: LoginProbeEnv): Promise<Response> {
  // Gate before touching any binding: this must answer 404 on a bundle
  // loaded with no bindings, not throw.
  if (!isAuthorized(request, env)) return notFound();

  const result = await probe(request, env);
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function probe(request: Request, env: LoginProbeEnv): Promise<LoginProbeResult> {
  if (!env.FANTASY_EMAIL || !env.FANTASY_PASSWORD) {
    return {
      configured: false,
      ok: false,
      detail:
        'FANTASY_EMAIL and FANTASY_PASSWORD are not both set; run `wrangler secret put` for each before probing',
    };
  }

  const now = Date.now();
  const lastAt = Number(await getConfig(env.DB, LOGIN_PROBE_LAST_AT_KEY));
  if (Number.isFinite(lastAt) && lastAt > 0 && now - lastAt < LOGIN_PROBE_MIN_INTERVAL_MS) {
    const waitMs = LOGIN_PROBE_MIN_INTERVAL_MS - (now - lastAt);
    return {
      configured: true,
      ok: false,
      detail: `rate limited: last probe was ${now - lastAt}ms ago, wait ${waitMs}ms`,
    };
  }
  await setConfig(env.DB, LOGIN_PROBE_LAST_AT_KEY, String(now));

  const client = new FantasyApiClient(env.FANTASY_BASE_URL);
  try {
    const { response } = await loginRaw(client, {
      email: env.FANTASY_EMAIL,
      password: env.FANTASY_PASSWORD,
    });
    const sessionid = extractCookieValue(getSetCookies(response.headers), 'sessionid');
    if (!sessionid) {
      return { configured: true, ok: false, detail: 'login returned no sessionid cookie' };
    }
    return {
      configured: true,
      ok: true,
      cookieFingerprint: await fingerprintCookie(sessionid),
    };
  } catch (err) {
    if (err instanceof ApiValidationError) {
      // The expected outcome for this account today: a 400 whose
      // non_field_errors says the username or password is wrong.
      return { configured: true, ok: false, fieldErrors: err.fieldErrors };
    }
    return {
      configured: true,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
