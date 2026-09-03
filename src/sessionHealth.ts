/**
 * Session-health observability and alerting primitives (issue #14).
 *
 * `SESSION_PROVIDER` is `manual`: the fantasy site rejects `POST
 * player/login/` for this B2C-provisioned account, so the `sessionid` is a
 * pasted secret that cannot re-authenticate itself. When it expires the tick
 * keeps working -- it just logs a failed heartbeat and every decision falls
 * back to the deterministic optimizer, silently, until someone notices. This
 * module holds the pure parts of making that loud and measurable:
 *
 *  - `fingerprintCookie` -- identifies WHICH cookie is in play without ever
 *    storing or logging the cookie. This repo is public and D1 is dumpable.
 *  - `nextSessionOkState` -- what a healthy heartbeat writes to the `session`
 *    row, including when `first_ok_at` restarts.
 *  - `planSessionAlert` -- whether this tick should alert, stay quiet, or
 *    stand down.
 *
 * All three are deliberately TypeScript rather than clever SQL. No test in
 * this repo runs SQL against a migrated schema (tests fake the `src/db`
 * helper, not D1), so logic expressed as a `CASE` expression would ship
 * unverified; expressed here it is covered by test/sessionHealth.test.ts.
 */

import { sessionIdOf } from './api/session';
import type { SessionBeat, SessionOkState } from './db';

/** Consecutive failed heartbeats before alerting outward. Ticks are hourly,
 * so this is ~3h of silent degradation -- long enough to ride out a
 * transient upstream blip, far short of a gameweek deadline. */
export const SESSION_ALERT_THRESHOLD = 3;

/**
 * How stale a failed beat may be and still count toward the streak.
 *
 * Load-bearing, not defensive. The kill switch returns before ANY write
 * including the heartbeat (see src/cron.ts), and a Cloudflare cron can miss
 * ticks, so "the last three rows" can span a month. Without this bound, a
 * week with the kill switch on followed by one fresh failure reads as three
 * consecutive failures and pages falsely. Sized at the threshold plus two
 * hours of slack so a couple of genuinely missed ticks do not mask a real
 * outage.
 */
export const SESSION_BEAT_FRESH_WINDOW_MS = (SESSION_ALERT_THRESHOLD + 2) * 60 * 60 * 1000;

/** `config` key holding whether an alert is currently outstanding. Lives in
 * D1 rather than a var so it can be cleared without a deploy, following the
 * `projection_strategy` precedent in src/db/config.ts. */
export const SESSION_ALERT_OPEN_KEY = 'session_alert_open';

/** `config` key holding when the login probe last ran, so repeated probes
 * cannot be used to lock the live account out. */
export const LOGIN_PROBE_LAST_AT_KEY = 'login_probe_last_at';

/** Minimum gap between login probes. The probe POSTs real credentials to the
 * live site; a tight loop of failed logins is an account-lockout vector. */
export const LOGIN_PROBE_MIN_INTERVAL_MS = 60_000;

/**
 * Why the session is considered dead.
 *
 * `unauthenticated` is `me/` answering with `player: null` -- the true
 * expired-cookie signal. `error` is a throw, most often ApiAuthError on
 * 401/403, but also any transport failure: three hours of site downtime
 * looks identical to a dead cookie from here. They are different diagnoses
 * for whoever reads the alert, so the distinction is carried rather than
 * flattened.
 */
export type SessionFailureReason = 'unauthenticated' | 'error';

export interface SessionAlertPayload {
  /** How many consecutive failed heartbeats triggered this. */
  streak: number;
  threshold: number;
  /** Which shape the most recent failure took. `unauthenticated` points at
   * the cookie; `error` may equally be the site being down. */
  reason: SessionFailureReason;
  /** The thrown message, when `reason` is 'error'. */
  detail?: string;
  /** Oldest and newest failure in the streak, so an alert citing "3
   * consecutive failures" is honest about the span they cover. */
  firstFailureAt: string;
  lastFailureAt: string;
  lastOkAt: string | null;
  /** When the current cookie first proved good -- with `lastOkAt`, the
   * observed lifetime of this cookie. */
  firstOkAt: string | null;
  cookieFingerprint: string | null;
  /** Which deployment is complaining, so the alert is self-describing. */
  worker: string;
}

/** What the tick should do about the session alert this tick. */
export type SessionAlertAction = 'send' | 'clear' | 'none';

/** Outcome of an alert attempt. Deliberately a value rather than a throw:
 * the caller must be able to tell "nobody was told" from "told", because
 * `session_alert_open` may only be set once delivery actually happened. */
export interface AlertDelivery {
  delivered: boolean;
  /** Why not, when `delivered` is false. Logged, never thrown. */
  detail?: string;
}

const HEX = '0123456789abcdef';

/**
 * A short, stable, one-way identifier for a cookie: the first 12 hex
 * characters of the SHA-256 digest of its `sessionid` value.
 *
 * 48 bits is ample to tell "the cookie was re-pasted" from "same cookie as
 * last hour", which is all this is for, and far too short to be useful to
 * anyone who reads it out of D1 or an alert body. Hashing the sessionid
 * VALUE rather than the header means `abc` and `sessionid=abc` fingerprint
 * identically -- `normalizeManualCookie` accepts both, and a re-paste in the
 * other format must not look like a rotation.
 *
 * Must be called from inside a function: `crypto.subtle` at module scope is
 * a disallowed global-scope operation in workerd (see
 * test/globalScope.test.ts and test/workers/deployContract.workers.test.ts).
 */
export async function fingerprintCookie(cookie: string): Promise<string> {
  const value = sessionIdOf(cookie);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest).subarray(0, 6);
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  }
  return out;
}

/**
 * The `session` heartbeat columns a healthy tick should write.
 *
 * `lastOkAt` always advances. `firstOkAt` is stamped afresh when there is no
 * state yet, when it was never set, or when the fingerprint changed -- a
 * re-pasted cookie starts a new measurement, otherwise the "observed
 * lifetime" would be the age of the column rather than of the cookie.
 */
export function nextSessionOkState(
  previous: SessionOkState | null,
  input: { at: string; fingerprint?: string },
): SessionOkState {
  const fingerprint = input.fingerprint ?? null;
  const sameCookie = previous !== null && previous.cookieFingerprint === fingerprint;
  const carriedFirstOkAt = sameCookie ? previous.firstOkAt : null;

  return {
    lastOkAt: input.at,
    firstOkAt: carriedFirstOkAt ?? input.at,
    cookieFingerprint: fingerprint,
  };
}

/**
 * Whether this tick should alert, stand down, or do nothing.
 *
 * `beats` is the most recent `session-health` rows, newest first, read back
 * AFTER this tick's own heartbeat has been written -- so `beats[0]` is this
 * tick. Requiring `beats.length >= threshold` is what stops a single failing
 * beat on a fresh deploy (or after a log-less period) from alerting
 * immediately.
 *
 * Only failures inside `SESSION_BEAT_FRESH_WINDOW_MS` of `now` count; see
 * that constant for why a stale row must not extend the streak.
 */
export function planSessionAlert(params: {
  now: Date;
  beats: readonly SessionBeat[];
  threshold: number;
  alertOpen: boolean;
}): SessionAlertAction {
  const { now, beats, threshold, alertOpen } = params;

  const newest = beats[0];
  if (newest === undefined) return 'none';
  // Recovered (or never broken): stand the alert down so the NEXT incident
  // can fire. Nothing to send while the session is good.
  if (newest.ok) return alertOpen ? 'clear' : 'none';

  const oldestCounted = now.getTime() - SESSION_BEAT_FRESH_WINDOW_MS;
  let streak = 0;
  for (const beat of beats) {
    if (beat.ok) break;
    if (new Date(beat.ts).getTime() < oldestCounted) break;
    streak++;
  }

  if (alertOpen) return 'none'; // Storm guard: one alert per incident.
  return streak >= threshold ? 'send' : 'none';
}

/** The leading run of consecutive failed beats, for display. Unbounded by
 * the freshness window on purpose -- the dashboard should show the true
 * length of the outage even when the alert deliberately did not fire. */
export function failureStreak(beats: readonly SessionBeat[]): number {
  let streak = 0;
  for (const beat of beats) {
    if (beat.ok) break;
    streak++;
  }
  return streak;
}
