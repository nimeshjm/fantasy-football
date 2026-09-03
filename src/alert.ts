/**
 * The one outbound notification channel: a webhook POST.
 *
 * Chosen over Cloudflare Email Routing because it needs no binding and no
 * verified destination -- `wrangler secret put ALERT_WEBHOOK_URL` and any of
 * Slack/Discord/ntfy/Zapier works as-is, and the whole thing stubs with the
 * `vi.stubGlobal('fetch', ...)` pattern already used in test/api.test.ts.
 *
 * Two rules this module exists to enforce:
 *
 *  - It NEVER throws. A failed alert must not be able to break the hourly
 *    tick, which is the one thing that guarantees a legal team by the
 *    deadline. Failure is a returned `{delivered: false}`, so the caller can
 *    tell "nobody was told" from "told" -- `session_alert_open` may only be
 *    latched once delivery actually happened, or an unconfigured webhook
 *    would silence the very alerting this exists to add.
 *  - It sends no secret material. The payload carries a truncated cookie
 *    FINGERPRINT, never the cookie, and never the dashboard token.
 */

import type { AlertDelivery, SessionAlertPayload } from './sessionHealth';

/** The smallest env this layer needs, per the per-layer-interface convention
 * in src/env.ts (cf. `FantasyEnv`, `LlmEnv`, `GateEnv`, `DbEnv`). */
export interface AlertEnv {
  /** Secret. Unset is a supported state: alerting is simply off, which keeps
   * CI and local dev from posting anywhere. */
  ALERT_WEBHOOK_URL?: string;
}

/** Short on purpose: this runs inside the cron tick, and an unbounded POST
 * to a wedged endpoint would burn the invocation's wall clock. */
const ALERT_TIMEOUT_MS = 5_000;

export async function sendWebhookAlert(
  env: AlertEnv,
  payload: SessionAlertPayload,
): Promise<AlertDelivery> {
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) {
    return { delivered: false, detail: 'ALERT_WEBHOOK_URL is not set' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { delivered: false, detail: 'ALERT_WEBHOOK_URL is not a valid URL' };
  }
  // A typo'd http:// URL would put the payload on the wire in plaintext.
  // Refusing is louder than sending: it shows up as a failed `session-alert`
  // row rather than as a silent downgrade.
  if (parsed.protocol !== 'https:') {
    return { delivered: false, detail: `ALERT_WEBHOOK_URL must be https, got ${parsed.protocol}` };
  }

  // The same summary under BOTH keys, so one webhook URL works for either of
  // the two likely targets without a per-service adapter: Slack renders
  // `text` and ignores `content`, Discord requires `content` and ignores
  // `text`. Sending only `text` gets a Discord webhook rejected outright with
  // `400 Cannot send an empty message` -- it needs one of content/embeds/file.
  const summary = summarize(payload);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: summary, content: summary, ...payload }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { delivered: false, detail: `webhook returned ${response.status}` };
    }
    return { delivered: true };
  } catch (err) {
    return { delivered: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A one-line human summary, sent as both `text` and `content` (see the call
 * site). It has to stand alone: the alert fires at most once per incident, so
 * whoever reads it may only ever see this string, not the structured fields
 * riding alongside it. Hence naming the secret to re-paste and saying what
 * degrades until someone does.
 *
 * ntfy is the one target that wants neither key -- it renders the whole
 * request body -- so there the summary arrives inside the JSON rather than as
 * the notification title. Legible, not pretty.
 */
function summarize(payload: SessionAlertPayload): string {
  const age = payload.firstOkAt ? ` (cookie first seen ${payload.firstOkAt})` : '';
  const why =
    payload.reason === 'unauthenticated'
      ? 'me/ returned no player — the cookie is not authenticating'
      : `request failed: ${payload.detail ?? 'unknown error'} — could be the cookie or the site`;
  return (
    `${payload.worker}: fantasy session dead — ${payload.streak} consecutive failed ` +
    `heartbeats since ${payload.firstFailureAt}. ${why}. ` +
    `Last good ${payload.lastOkAt ?? 'never'}${age}. ` +
    `Re-paste FANTASY_SESSION_COOKIE; decisions are falling back to the optimizer until you do.`
  );
}
