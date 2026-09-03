/**
 * Tests for src/sessionHealth.ts: the pure decisions behind issue #14's
 * session observability -- what a healthy heartbeat writes to the `session`
 * row, and the one-way cookie fingerprint that makes a re-paste detectable.
 *
 * These are unit tests on purpose. The `first_ok_at` rule could have been a
 * `CASE` expression inside the upsert, but no test in this repo runs SQL
 * against a migrated schema, so it would have shipped unverified.
 */
import { describe, expect, it } from 'vitest';

import { fingerprintCookie, nextSessionOkState } from '../src/sessionHealth';
import type { SessionOkState } from '../src/db';

const AT = '2026-09-10T16:00:00.000Z';
const LATER = '2026-09-11T16:00:00.000Z';

function state(overrides: Partial<SessionOkState> = {}): SessionOkState {
  return {
    lastOkAt: AT,
    firstOkAt: AT,
    cookieFingerprint: 'aaaaaaaaaaaa',
    ...overrides,
  };
}

describe('nextSessionOkState', () => {
  it('stamps both timestamps when there is no row yet', () => {
    // The normal state under SESSION_PROVIDER=manual: no migration seeds the
    // session table, so the very first healthy tick creates the row.
    expect(nextSessionOkState(null, { at: AT, fingerprint: 'aaaaaaaaaaaa' })).toEqual({
      lastOkAt: AT,
      firstOkAt: AT,
      cookieFingerprint: 'aaaaaaaaaaaa',
    });
  });

  it('advances lastOkAt but preserves firstOkAt while the cookie is unchanged', () => {
    // This is what makes the measurement a measurement: firstOkAt must be
    // the age of the COOKIE, not of the most recent tick.
    const next = nextSessionOkState(state(), { at: LATER, fingerprint: 'aaaaaaaaaaaa' });

    expect(next.lastOkAt).toBe(LATER);
    expect(next.firstOkAt).toBe(AT);
  });

  it('restarts firstOkAt when the fingerprint changes', () => {
    // A re-paste is a new cookie. Carrying the old firstOkAt forward would
    // report the observed lifetime as the age of the column.
    const next = nextSessionOkState(state(), { at: LATER, fingerprint: 'bbbbbbbbbbbb' });

    expect(next.firstOkAt).toBe(LATER);
    expect(next.cookieFingerprint).toBe('bbbbbbbbbbbb');
  });

  it('stamps firstOkAt when the stored row has one missing', () => {
    // Rows written before 0003 have NULL in both new columns.
    const next = nextSessionOkState(state({ firstOkAt: null, cookieFingerprint: null }), {
      at: LATER,
      fingerprint: 'aaaaaaaaaaaa',
    });

    expect(next.firstOkAt).toBe(LATER);
  });

  it('treats an absent fingerprint as its own identity rather than a rotation', () => {
    // If checkSession could not produce a fingerprint, two consecutive such
    // ticks must not each look like a fresh cookie.
    const first = nextSessionOkState(null, { at: AT });
    const second = nextSessionOkState(first, { at: LATER });

    expect(first.cookieFingerprint).toBeNull();
    expect(second.firstOkAt).toBe(AT);
  });
});

describe('fingerprintCookie', () => {
  it('is 12 lowercase hex characters', async () => {
    expect(await fingerprintCookie('sessionid=abc')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable for the same cookie and differs for a different one', async () => {
    const a = await fingerprintCookie('sessionid=abc');

    expect(await fingerprintCookie('sessionid=abc')).toBe(a);
    expect(await fingerprintCookie('sessionid=abd')).not.toBe(a);
  });

  it('fingerprints the sessionid value, not the header formatting', async () => {
    // normalizeManualCookie accepts a bare value OR "sessionid=...", so
    // re-pasting the same cookie in the other format must not read as a
    // rotation and restart the lifetime measurement.
    const bare = await fingerprintCookie('abc');

    expect(await fingerprintCookie('sessionid=abc')).toBe(bare);
    expect(await fingerprintCookie('csrftoken=zzz; sessionid=abc')).toBe(bare);
  });

  it('leaks no part of the cookie it was given', async () => {
    // The whole reason this is a hash: the fingerprint is written to D1 and
    // POSTed in alert bodies, and this repo is public.
    const secret = 'supersecretsessionvalue';
    const fingerprint = await fingerprintCookie(`sessionid=${secret}`);

    for (let i = 0; i + 3 <= secret.length; i++) {
      expect(fingerprint).not.toContain(secret.slice(i, i + 3));
    }
  });
});
