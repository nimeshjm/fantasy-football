/**
 * Row-level types for the D1 layer.
 *
 * Everything importable from `src/types.ts` is re-exported unchanged where a
 * table maps onto it directly. Where a table's shape diverges from the
 * shared domain type (an extra column D1 needs but the API contract
 * doesn't, or a naming mismatch), the divergence is captured here as an
 * explicit `*Row` type rather than by casting.
 */

import type {
  Element,
  Fixture,
  GameEvent,
  GwStats,
  Pick,
  Projection,
  SquadState,
  Team,
} from '../types';

/** Minimal environment shape this module needs. Callers may pass `env`
 * directly (it has a `DB` property) or construct this narrower type. */
export interface DbEnv {
  DB: D1Database;
}

// ---------------------------------------------------------------------------
// Tables that map 1:1 onto a shared type (D1 stores booleans as 0/1; readers
// coerce back with `toBool`).
// ---------------------------------------------------------------------------

export type TeamRow = Team;
export type EventRow = GameEvent;
export type FixtureRow = Fixture;

/** `elements` adds `updated_at`, which is ours (not part of the API contract
 * carried by `Element`). */
export interface ElementRow extends Element {
  updated_at: string;
}

/**
 * One player's stat line for one fixture.
 *
 * `fixture_id` now lives on `GwStats` itself, so this is a plain alias kept
 * only so existing `src/db` call sites read consistently with the other
 * `*Row` types. Prefer `GwStats` in new code outside this directory.
 */
export type GwStatsRow = GwStats;

/** `projections` adds `computed_at`, which is ours. */
export interface ProjectionRow extends Projection {
  computed_at: string;
}

export interface TeamRatingRow {
  team_id: number;
  attack: number;
  defence: number;
  updated_at: string;
}

/** Prior-season aggregates. Not part of src/types.ts -- there is no shared
 * interface for this, so the shape lives here only. */
export interface ElementHistoryPastRow {
  element_code: number;
  season_name: string;
  total_points: number;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
}

/**
 * `squad_state` mapped onto `SquadState`. The interface uses camelCase
 * (`freeTransfers`, `transfersMade`); the column names are snake_case, and
 * `cumulative_transfers` has no place on `SquadState` at all, so it is kept
 * here as an addition rather than folded into the shared type. `picks` is
 * stored as a JSON TEXT blob; readers parse it, writers stringify it -- never
 * pass the raw column value where a `Pick[]` is expected.
 */
export interface SquadStateRow extends SquadState {
  cumulativeTransfers: number;
}

/** Raw shape of one `squad_state` row as it comes back from D1, before
 * `picks` is JSON-parsed and the snake_case columns are relabelled. */
export interface SquadStateDbRow {
  entry: number;
  event: number;
  picks: string;
  chip: string | null;
  bank: number;
  value: number;
  free_transfers: number;
  transfers_made: number;
  cumulative_transfers: number;
}

export function squadStateFromDbRow(row: SquadStateDbRow): SquadStateRow {
  return {
    entry: row.entry,
    event: row.event,
    picks: JSON.parse(row.picks) as Pick[],
    chip: row.chip,
    bank: row.bank,
    value: row.value,
    freeTransfers: row.free_transfers,
    transfersMade: row.transfers_made,
    cumulativeTransfers: row.cumulative_transfers,
  };
}

// ---------------------------------------------------------------------------
// Logging / budget / session / config -- no shared domain type; defined here.
// ---------------------------------------------------------------------------

export type DecisionSourceKind = 'squad' | 'lineup' | 'transfer';

export interface ActionLogInput {
  ts: string;
  kind: string;
  /** Serialised to JSON TEXT. Pass the object, not a pre-stringified blob. */
  intent: unknown;
  response?: unknown;
  dryRun: boolean;
  source: string;
  ok: boolean;
}

/**
 * Whether the sanity gate let the model's answer through, or replaced it
 * with the deterministic optimum. Written to `ai_calls.gate_verdict`.
 *
 * NULL (the absence of a verdict) is a third, meaningful state: the gate
 * only runs after a schema-valid, rules-legal LLM answer, so a NULL verdict
 * says the attempt never got that far. Never write a placeholder here to
 * avoid the null -- that erases the distinction the column exists for.
 */
export type GateVerdict = 'accept' | 'override';

export interface AiCallInput {
  ts: string;
  decisionKind: string;
  model: string;
  prompt: string;
  rawResponse?: string;
  schemaValid?: boolean;
  validationOutcome?: string;
  repaired: boolean;
  gateVerdict?: GateVerdict;
  /** `DecisionSource` the gate settled on ('llm' on accept,
   * 'deterministic-gate' on override). */
  gateSource?: string;
  /** `gateDecision`'s human-readable justification. Set iff overridden. */
  gateOverrideReason?: string;
  /** Deterministic-model score of the LLM's own answer, and of the
   * deterministic optimum it was measured against. Both recorded on accept
   * as well as override -- an override is only judgeable next to the margin
   * it cleared, and an accept is only judgeable next to the margin it
   * did not. */
  llmScore?: number;
  deterministicScore?: number;
  estNeuronsIn: number;
  estNeuronsOut: number;
}

/** The gate half of an `ai_calls` row, applied to an already-inserted row
 * by `updateAiCallGate` once the gate has run. */
export interface AiCallGateUpdate {
  gateVerdict: GateVerdict;
  gateSource: string;
  gateOverrideReason?: string;
  llmScore?: number;
  deterministicScore?: number;
}

export interface SessionRow {
  cookie: string | null;
  expiresAt: string | null;
  lastOkAt: string | null;
}

/**
 * The heartbeat's view of the `session` row: the three columns the hourly
 * tick writes, deliberately NOT part of `SessionRow`.
 *
 * Kept separate so the new columns never travel through
 * `getSession`/`setSession`, whose `cookie` column src/sessionStore.ts
 * documents itself as the only reader/writer of. `setSessionOk` names only
 * these three columns, so a password-provider login (the only other writer
 * of this row) leaves them intact, and this writer leaves `cookie` intact.
 */
export interface SessionOkState {
  /** Last heartbeat that proved the session good. */
  lastOkAt: string | null;
  /** When the CURRENT cookie first proved good. Restarts whenever
   * `cookieFingerprint` changes, so (failure time - firstOkAt) is the
   * observed lifetime of one cookie rather than the age of the column. */
  firstOkAt: string | null;
  /** SHA-256 prefix of the sessionid -- enough to notice a re-paste, never
   * enough to reconstruct the cookie. See `fingerprintCookie`. */
  cookieFingerprint: string | null;
}

/**
 * One `actions_log` session heartbeat, projected down to what the alert
 * planner and the dashboard need. Everything but `ts`/`ok` is parsed out of
 * the row's `response` JSON, so every field is nullable: rows written before
 * a field existed simply lack it.
 */
export interface SessionBeat {
  ts: string;
  ok: boolean;
  /** The authenticated team id. Present only on a healthy beat. */
  entry: number | null;
  /** Which cookie this beat was made with -- the archive that makes
   * per-cookie lifetime measurable after a re-paste has overwritten
   * `session.first_ok_at`. */
  fingerprint: string | null;
  /** The thrown message, when the beat failed by exception (401/403 from the
   * site, or a transport failure) rather than by `player: null`. */
  error: string | null;
}

export interface ConfigRow {
  key: string;
  value: string;
}

/** D1 stores booleans as INTEGER 0/1. Coerce before it crosses the src/db
 * boundary -- a bare cast compiles but ships `is_current: 1` into JSON and
 * silently breaks `=== true` comparisons downstream. */
export function toBool(v: unknown): boolean {
  return v === 1 || v === true;
}

export function toBit(v: boolean): 0 | 1 {
  return v ? 1 : 0;
}
