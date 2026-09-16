import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getUefaAppearancesForElements,
  hasUefaAppearance,
  hasUefaAppearances,
  upsertUefaAppearances,
} from '../../src/db/uefaAppearances';
import type { UefaAppearanceRow } from '../../src/db/types';

/**
 * Runs against the real D1 binding the `workers` project wires up from
 * wrangler.jsonc (see vitest.config.ts) -- the only place in this suite that
 * runs actual SQL rather than a hand-rolled fake, which is what this
 * module's JSON-upsert SQL (json_each/ON CONFLICT) needs to be verified
 * against. No `src/db/*.ts` table module has a dedicated SQL-executing test
 * yet (verified before writing this file); this is the first one.
 *
 * Schema is created fresh (`IF NOT EXISTS`) and cleared before every test
 * rather than relying on `beforeAll`, since it's not guaranteed how
 * vitest-pool-workers' isolated storage treats writes made outside a test.
 */
beforeEach(async () => {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS uefa_appearances (' +
      'element_id INTEGER NOT NULL, fixture_id INTEGER NOT NULL, competition TEXT NOT NULL, ' +
      'opponent TEXT NOT NULL, kickoff_time TEXT NOT NULL, started INTEGER NOT NULL, ' +
      'subbed_off_minute INTEGER, minutes_played INTEGER NOT NULL, fetched_at TEXT NOT NULL, ' +
      'PRIMARY KEY (element_id, fixture_id))',
  ).run();
  await env.DB.prepare('DELETE FROM uefa_appearances').run();
});

function makeRow(overrides: Partial<UefaAppearanceRow> = {}): UefaAppearanceRow {
  return {
    elementId: 101,
    fixtureId: 9001,
    competition: 'UCL',
    opponent: 'Benfica',
    kickoffTime: '2026-09-16T19:00:00Z',
    started: true,
    subbedOffMinute: null,
    minutesPlayed: 90,
    fetchedAt: '2026-09-16T21:00:00Z',
    ...overrides,
  };
}

describe('upsertUefaAppearances + getUefaAppearancesForElements', () => {
  it('round-trips a row through upsert and read', async () => {
    const row = makeRow();

    await upsertUefaAppearances(env.DB, [row]);
    const results = await getUefaAppearancesForElements(env.DB, [row.elementId]);

    expect(results).toEqual([row]);
  });

  it('preserves a null subbedOffMinute (not 0)', async () => {
    const row = makeRow({ subbedOffMinute: null, started: true, minutesPlayed: 90 });

    await upsertUefaAppearances(env.DB, [row]);
    const [result] = await getUefaAppearancesForElements(env.DB, [row.elementId]);

    expect(result!.subbedOffMinute).toBeNull();
  });

  it('stores a real subbedOffMinute value', async () => {
    const row = makeRow({ subbedOffMinute: 67, minutesPlayed: 67 });

    await upsertUefaAppearances(env.DB, [row]);
    const [result] = await getUefaAppearancesForElements(env.DB, [row.elementId]);

    expect(result!.subbedOffMinute).toBe(67);
  });

  it('orders results by kickoff_time, most recent first', async () => {
    const earliest = makeRow({
      elementId: 201,
      fixtureId: 1,
      kickoffTime: '2026-09-01T19:00:00Z',
    });
    const middle = makeRow({ elementId: 201, fixtureId: 2, kickoffTime: '2026-09-08T19:00:00Z' });
    const latest = makeRow({ elementId: 201, fixtureId: 3, kickoffTime: '2026-09-15T19:00:00Z' });

    // deliberately unsorted insert order
    await upsertUefaAppearances(env.DB, [middle, earliest, latest]);
    const results = await getUefaAppearancesForElements(env.DB, [201]);

    expect(results.map((r) => r.fixtureId)).toEqual([3, 2, 1]);
  });

  it('filters to only the requested element ids', async () => {
    const wanted = makeRow({ elementId: 301, fixtureId: 1 });
    const other = makeRow({ elementId: 302, fixtureId: 2 });

    await upsertUefaAppearances(env.DB, [wanted, other]);
    const results = await getUefaAppearancesForElements(env.DB, [301]);

    expect(results).toEqual([wanted]);
  });

  it('returns an empty array for no requested element ids, without querying', async () => {
    await upsertUefaAppearances(env.DB, [makeRow()]);

    const results = await getUefaAppearancesForElements(env.DB, []);

    expect(results).toEqual([]);
  });

  it('returns an empty array when nothing is stored for the requested elements', async () => {
    const results = await getUefaAppearancesForElements(env.DB, [999]);

    expect(results).toEqual([]);
  });

  it('does nothing on an empty upsert batch', async () => {
    await upsertUefaAppearances(env.DB, []);

    const results = await getUefaAppearancesForElements(env.DB, [101]);

    expect(results).toEqual([]);
  });

  it('guard columns: an unchanged re-upsert leaves fetched_at at its first-seen value', async () => {
    const first = makeRow({ fetchedAt: '2026-09-16T21:00:00Z' });
    await upsertUefaAppearances(env.DB, [first]);

    const resame = makeRow({ fetchedAt: '2026-09-17T09:00:00Z' });
    await upsertUefaAppearances(env.DB, [resame]);

    const [result] = await getUefaAppearancesForElements(env.DB, [first.elementId]);
    expect(result!.fetchedAt).toBe('2026-09-16T21:00:00Z');
  });

  it('guard columns: a changed minutesPlayed/started DOES rewrite the row, fetchedAt included', async () => {
    const first = makeRow({
      started: true,
      minutesPlayed: 45,
      subbedOffMinute: 45,
      fetchedAt: '2026-09-16T18:00:00Z',
    });
    await upsertUefaAppearances(env.DB, [first]);

    const updated = makeRow({
      started: true,
      minutesPlayed: 90,
      subbedOffMinute: null,
      fetchedAt: '2026-09-16T22:00:00Z',
    });
    await upsertUefaAppearances(env.DB, [updated]);

    const [result] = await getUefaAppearancesForElements(env.DB, [first.elementId]);
    expect(result).toEqual(updated);
  });
});

describe('hasUefaAppearance', () => {
  it('is true for a stored (elementId, fixtureId) pair', async () => {
    const row = makeRow();
    await upsertUefaAppearances(env.DB, [row]);

    expect(await hasUefaAppearance(env.DB, row.elementId, row.fixtureId)).toBe(true);
  });

  it('is false for an elementId/fixtureId combination that was never stored', async () => {
    const row = makeRow();
    await upsertUefaAppearances(env.DB, [row]);

    expect(await hasUefaAppearance(env.DB, row.elementId, row.fixtureId + 1)).toBe(false);
    expect(await hasUefaAppearance(env.DB, row.elementId + 1, row.fixtureId)).toBe(false);
  });

  it('is false against an entirely empty table', async () => {
    expect(await hasUefaAppearance(env.DB, 1, 1)).toBe(false);
  });
});

describe('hasUefaAppearances', () => {
  it('returns the stored subset of requested (elementId, fixtureId) pairs', async () => {
    const stored = makeRow({ elementId: 401, fixtureId: 11 });
    await upsertUefaAppearances(env.DB, [stored]);

    const result = await hasUefaAppearances(env.DB, [401, 402], [11, 12]);

    expect(result).toEqual(new Set(['401:11']));
  });

  it('returns an empty set for an empty elementIds input', async () => {
    await upsertUefaAppearances(env.DB, [makeRow()]);

    expect(await hasUefaAppearances(env.DB, [], [9001])).toEqual(new Set());
  });

  it('returns an empty set for an empty fixtureIds input', async () => {
    await upsertUefaAppearances(env.DB, [makeRow()]);

    expect(await hasUefaAppearances(env.DB, [101], [])).toEqual(new Set());
  });

  it('returns an empty set against an entirely empty table', async () => {
    expect(await hasUefaAppearances(env.DB, [1, 2], [1, 2])).toEqual(new Set());
  });
});
