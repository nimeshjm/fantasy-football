import type { Element, Position } from '../types';
import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import { toBit, toBool, type ElementRow } from './types';

const COLUMNS = [
  'id',
  'code',
  'web_name',
  'first_name',
  'second_name',
  'team',
  'element_type',
  'now_cost',
  'status',
  'news',
  'news_added',
  'chance_of_playing_this_round',
  'chance_of_playing_next_round',
  'ep_next',
  'ep_this',
  'total_points',
  'event_points',
  'form',
  'points_per_game',
  'selected_by_percent',
  'minutes',
  'removed',
  'can_select',
  'can_transact',
  'updated_at',
] as const;

const SPEC: JsonUpsertSpec = {
  table: 'elements',
  columns: [...COLUMNS],
  conflictColumns: ['id'],
  // Everything mutable except id (conflict key) and updated_at (our own
  // stamp -- including it here would make every row "changed" every call).
  guardColumns: COLUMNS.filter((c) => c !== 'id' && c !== 'updated_at'),
};

interface RawElementRow {
  id: number;
  code: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  element_type: number;
  now_cost: number;
  status: string;
  news: string;
  news_added: string | null;
  chance_of_playing_this_round: number | null;
  chance_of_playing_next_round: number | null;
  ep_next: string | null;
  ep_this: string | null;
  total_points: number;
  event_points: number;
  form: string;
  points_per_game: string;
  selected_by_percent: string;
  minutes: number;
  removed: number;
  can_select: number;
  can_transact: number;
  updated_at: string;
}

function fromRaw(row: RawElementRow): ElementRow {
  return {
    ...row,
    element_type: row.element_type as Position,
    removed: toBool(row.removed),
    can_select: toBool(row.can_select),
    can_transact: toBool(row.can_transact),
  };
}

/**
 * Daily upsert of the ~656-row `elements` table. At UPSERT_CHUNK_SIZE=100
 * this is `ceil(656/100)` = 7 D1 queries, submitted as one `db.batch()`
 * call. Rows whose mutable fields are unchanged are skipped by the WHERE
 * guard on the DO UPDATE, so a quiet day writes far fewer than 656 rows.
 */
export async function upsertElements(
  db: D1Database,
  elements: readonly Element[],
  updatedAt: string,
): Promise<void> {
  const rows = elements.map((e) => ({
    id: e.id,
    code: e.code,
    web_name: e.web_name,
    first_name: e.first_name,
    second_name: e.second_name,
    team: e.team,
    element_type: e.element_type,
    now_cost: e.now_cost,
    status: e.status,
    news: e.news,
    news_added: e.news_added,
    chance_of_playing_this_round: e.chance_of_playing_this_round,
    chance_of_playing_next_round: e.chance_of_playing_next_round,
    ep_next: e.ep_next,
    ep_this: e.ep_this,
    total_points: e.total_points,
    event_points: e.event_points,
    form: e.form,
    points_per_game: e.points_per_game,
    selected_by_percent: e.selected_by_percent,
    minutes: e.minutes,
    removed: toBit(e.removed),
    can_select: toBit(e.can_select),
    can_transact: toBit(e.can_transact),
    updated_at: updatedAt,
  }));
  const statements = buildChunkedJsonUpserts(db, SPEC, rows);
  if (statements.length > 0) await db.batch(statements);
}

export async function getElementById(db: D1Database, id: number): Promise<ElementRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM elements WHERE id = ?`)
    .bind(id)
    .first<RawElementRow>();
  return row === null ? null : fromRaw(row);
}

export async function getElementsByTeam(db: D1Database, team: number): Promise<ElementRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM elements WHERE team = ? ORDER BY id`)
    .bind(team)
    .all<RawElementRow>();
  return results.map(fromRaw);
}

export async function getAllElements(db: D1Database): Promise<ElementRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM elements ORDER BY id`)
    .all<RawElementRow>();
  return results.map(fromRaw);
}
