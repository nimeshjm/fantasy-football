import type { GameEvent } from '../types';
import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import { toBit, toBool, type EventRow } from './types';

const SPEC: JsonUpsertSpec = {
  table: 'events',
  columns: [
    'id',
    'name',
    'deadline_time',
    'is_current',
    'is_next',
    'is_previous',
    'finished',
    'data_checked',
  ],
  conflictColumns: ['id'],
  guardColumns: [
    'name',
    'deadline_time',
    'is_current',
    'is_next',
    'is_previous',
    'finished',
    'data_checked',
  ],
};

interface RawEventRow {
  id: number;
  name: string;
  deadline_time: string;
  is_current: number;
  is_next: number;
  is_previous: number;
  finished: number;
  data_checked: number;
}

function fromRaw(row: RawEventRow): EventRow {
  return {
    id: row.id,
    name: row.name,
    deadline_time: row.deadline_time,
    is_current: toBool(row.is_current),
    is_next: toBool(row.is_next),
    is_previous: toBool(row.is_previous),
    finished: toBool(row.finished),
    data_checked: toBool(row.data_checked),
  };
}

/** Upserts the gameweek calendar (~38 events/season -- one chunk, one D1
 * query). Skips rows whose flags/deadline are unchanged. */
export async function upsertEvents(db: D1Database, events: readonly GameEvent[]): Promise<void> {
  const rows = events.map((e) => ({
    id: e.id,
    name: e.name,
    deadline_time: e.deadline_time,
    is_current: toBit(e.is_current),
    is_next: toBit(e.is_next),
    is_previous: toBit(e.is_previous),
    finished: toBit(e.finished),
    data_checked: toBit(e.data_checked),
  }));
  const statements = buildChunkedJsonUpserts(db, SPEC, rows);
  if (statements.length > 0) await db.batch(statements);
}

/** Reads the current and next gameweek in one query, using
 * idx_events_current_next. Either may be null (e.g. season not started, or
 * between the final event finishing and next season's data landing). */
export async function getCurrentAndNextEvent(
  db: D1Database,
): Promise<{ current: EventRow | null; next: EventRow | null }> {
  const { results } = await db
    .prepare(
      'SELECT id, name, deadline_time, is_current, is_next, is_previous, finished, data_checked ' +
        'FROM events WHERE is_current = 1 OR is_next = 1',
    )
    .all<RawEventRow>();

  let current: EventRow | null = null;
  let next: EventRow | null = null;
  for (const row of results) {
    if (row.is_current === 1) current = fromRaw(row);
    if (row.is_next === 1) next = fromRaw(row);
  }
  return { current, next };
}

export async function getAllEvents(db: D1Database): Promise<EventRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, name, deadline_time, is_current, is_next, is_previous, finished, data_checked FROM events ORDER BY id',
    )
    .all<RawEventRow>();
  return results.map(fromRaw);
}
