import type { Pick } from '../types';
import { squadStateFromDbRow, type SquadStateDbRow, type SquadStateRow } from './types';

const COLUMNS =
  'entry, event, picks, chip, bank, value, free_transfers, transfers_made, cumulative_transfers';

export interface SquadStateInput {
  entry: number;
  event: number;
  picks: readonly Pick[];
  chip: string | null;
  bank: number;
  value: number;
  freeTransfers: number;
  transfersMade: number;
  cumulativeTransfers: number;
}

/**
 * Upserts one entry's squad state for one gameweek. A single bound-param
 * statement (not the json_each bulk path) since this is written at most
 * once per gameweek per managed entry, never in bulk.
 */
export async function upsertSquadState(db: D1Database, state: SquadStateInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO squad_state (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
        'ON CONFLICT(entry, event) DO UPDATE SET ' +
        'picks = excluded.picks, chip = excluded.chip, bank = excluded.bank, value = excluded.value, ' +
        'free_transfers = excluded.free_transfers, transfers_made = excluded.transfers_made, ' +
        'cumulative_transfers = excluded.cumulative_transfers',
    )
    .bind(
      state.entry,
      state.event,
      JSON.stringify(state.picks),
      state.chip,
      state.bank,
      state.value,
      state.freeTransfers,
      state.transfersMade,
      state.cumulativeTransfers,
    )
    .run();
}

export async function getSquadState(
  db: D1Database,
  entry: number,
  event: number,
): Promise<SquadStateRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM squad_state WHERE entry = ? AND event = ?`)
    .bind(entry, event)
    .first<SquadStateDbRow>();
  return row === null ? null : squadStateFromDbRow(row);
}

/** Used to resume state without knowing the current event id up front --
 * served by idx_squad_state_entry_event (entry, event DESC). */
export async function getLatestSquadState(
  db: D1Database,
  entry: number,
): Promise<SquadStateRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM squad_state WHERE entry = ? ORDER BY event DESC LIMIT 1`)
    .bind(entry)
    .first<SquadStateDbRow>();
  return row === null ? null : squadStateFromDbRow(row);
}
