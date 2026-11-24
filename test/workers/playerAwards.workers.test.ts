import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getPlayerAwardsByPeriod,
  getPlayerAwardsForElements,
  upsertPlayerAwards,
} from '../../src/db/playerAwards';
import type { PlayerAwardRow } from '../../src/db/types';

function makeRow(overrides: Partial<PlayerAwardRow> = {}): PlayerAwardRow {
  return {
    elementId: 101,
    awardType: 'POTW',
    periodKey: 'gw:5',
    fixtureId: 501,
    sourcePlayerName: 'Viktor Gyokeres',
    fetchedAt: '2026-09-20T22:00:00Z',
    ...overrides,
  };
}

describe('playerAwards DB helpers', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS player_awards (' +
        'element_id INTEGER NOT NULL, award_type TEXT NOT NULL, period_key TEXT NOT NULL, ' +
        'fixture_id INTEGER, source_player_name TEXT NOT NULL, fetched_at TEXT NOT NULL, ' +
        'PRIMARY KEY (award_type, period_key, element_id))',
    ).run();
    await env.DB.prepare('DELETE FROM player_awards').run();
  });

  it('upsertPlayerAwards with empty array is a no-op', async () => {
    await upsertPlayerAwards(env.DB, []);
    const rows = await getPlayerAwardsForElements(env.DB, [101]);
    expect(rows).toEqual([]);
  });

  it('upsertPlayerAwards round-trips rows with non-null and null fixtureId', async () => {
    const potwRow = makeRow({
      elementId: 101,
      awardType: 'POTW',
      periodKey: 'gw:5',
      fixtureId: 501,
      sourcePlayerName: 'Viktor Gyokeres',
    });
    const potmRow = makeRow({
      elementId: 102,
      awardType: 'POTM',
      periodKey: 'month:2026-09',
      fixtureId: null,
      sourcePlayerName: 'Diogo Costa',
    });

    await upsertPlayerAwards(env.DB, [potwRow, potmRow]);

    const rows = await getPlayerAwardsForElements(env.DB, [101, 102]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([potwRow, potmRow]));
  });

  it('guarded re-upsert preserves fetched_at when unchanged and updates when changed', async () => {
    const initial = makeRow({
      fetchedAt: '2026-09-20T22:00:00Z',
    });
    await upsertPlayerAwards(env.DB, [initial]);

    // Unchanged fixture_id and source_player_name: fetched_at should be preserved
    const unchanged = makeRow({
      fetchedAt: '2026-09-21T10:00:00Z',
    });
    await upsertPlayerAwards(env.DB, [unchanged]);

    let rows = await getPlayerAwardsForElements(env.DB, [101]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fetchedAt).toBe('2026-09-20T22:00:00Z');

    // Changed source_player_name: fetched_at should update
    const changedName = makeRow({
      sourcePlayerName: 'V. Gyokeres',
      fetchedAt: '2026-09-21T12:00:00Z',
    });
    await upsertPlayerAwards(env.DB, [changedName]);

    rows = await getPlayerAwardsForElements(env.DB, [101]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourcePlayerName).toBe('V. Gyokeres');
    expect(rows[0]!.fetchedAt).toBe('2026-09-21T12:00:00Z');

    // Changed fixture_id: fetched_at should update
    const changedFixture = makeRow({
      fixtureId: 502,
      sourcePlayerName: 'V. Gyokeres',
      fetchedAt: '2026-09-21T14:00:00Z',
    });
    await upsertPlayerAwards(env.DB, [changedFixture]);

    rows = await getPlayerAwardsForElements(env.DB, [101]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fixtureId).toBe(502);
    expect(rows[0]!.fetchedAt).toBe('2026-09-21T14:00:00Z');
  });

  it('getPlayerAwardsForElements returns empty array for empty input', async () => {
    await upsertPlayerAwards(env.DB, [makeRow()]);
    const rows = await getPlayerAwardsForElements(env.DB, []);
    expect(rows).toEqual([]);
  });

  it('getPlayerAwardsByPeriod returns matching rows for awardType and periodKey', async () => {
    const r1 = makeRow({ elementId: 101, awardType: 'POTW', periodKey: 'gw:5' });
    const r2 = makeRow({ elementId: 102, awardType: 'POTW', periodKey: 'gw:5' });
    const r3 = makeRow({ elementId: 103, awardType: 'POTW', periodKey: 'gw:6' });
    const r4 = makeRow({
      elementId: 101,
      awardType: 'POTM',
      periodKey: 'month:2026-09',
      fixtureId: null,
    });

    await upsertPlayerAwards(env.DB, [r1, r2, r3, r4]);

    const gw5Rows = await getPlayerAwardsByPeriod(env.DB, 'POTW', 'gw:5');
    expect(gw5Rows).toEqual([r1, r2]);
  });
});
