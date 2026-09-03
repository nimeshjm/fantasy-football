/**
 * Typed wrappers for every Fantasy Liga Portugal API endpoint used by this
 * agent. Every path below carries the API's required trailing slash.
 *
 * Response shapes reuse src/types.ts wherever that shape was actually
 * verified against the live API (Element, Team, GameEvent, Pick,
 * TransferMove, and `fixtures/?event=` -> Fixture[]). Endpoints whose exact
 * response shape was not part of that verification (entry/, entry/history/,
 * entry/transfers/, entry/event/{n}/picks/, element-summary/'s `fixtures`
 * and `history` arrays) are typed loosely on purpose — narrow them further
 * only once their real shape has been confirmed, rather than guessing.
 *
 * No endpoint here loops over players: event/{n}/live/ returns every
 * player's stats for a gameweek in one request specifically so nothing
 * needs to fan out over element-summary/{id}/ (50 subrequest cap).
 */

import type { Element, Fixture, GameEvent, Pick, Team, TransferMove } from '../types';
import { FantasyApiClient } from './client';
import type { AuthContext } from './session';

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/** bootstrap-static/ is ~1 MB. Parse once (the client already does this) and
 * never deep-clone or re-parse it — that alone costs ~1.7 ms of the 10 ms
 * per-invocation CPU budget. Callers project what they need out of `elements`
 * rather than this layer transforming it upfront. */
export interface BootstrapStatic {
  chips: unknown[];
  events: GameEvent[];
  game_settings: Record<string, unknown>;
  game_config: Record<string, unknown>;
  phases: unknown[];
  teams: Team[];
  total_players: number;
  element_stats: unknown[];
  elements: Element[];
}

export function getBootstrapStatic(client: FantasyApiClient): Promise<BootstrapStatic> {
  return client.get<BootstrapStatic>('bootstrap-static/');
}

export function getFixtures(client: FantasyApiClient, event: number): Promise<Fixture[]> {
  return client.get<Fixture[]>('fixtures/', { query: { event } });
}

/** One identifier/points/value/points_modification triple inside a live
 * element's explain block for one fixture. */
export interface LiveExplainStat {
  identifier: string;
  points: number;
  value: number;
  points_modification: number;
}

export interface LiveExplainFixture {
  fixture: number;
  stats: LiveExplainStat[];
}

export interface LiveElement {
  id: number;
  /** Raw per-stat counters plus total_points/bonus for this gameweek. Kept
   * loose (not RawStats) since this endpoint's stats block has not been
   * field-for-field verified against RawStats. */
  stats: Record<string, number>;
  explain: LiveExplainFixture[];
}

export interface EventLive {
  elements: LiveElement[];
}

/** All 656 players' stats for one gameweek in a single request. This is the
 * one-shot alternative to fanning out over getElementSummary for a squad —
 * never loop element-summary calls when this endpoint covers the need. */
export function getEventLive(client: FantasyApiClient, event: number): Promise<EventLive> {
  return client.get<EventLive>(`event/${event}/live/`);
}

/** Single-player detail only. Never call this in a loop over a roster —
 * that is exactly the 656-subrequest fan-out event/{n}/live/ exists to
 * avoid, and it would blow the 50-subrequest-per-invocation cap. */
export function getElementSummary(
  client: FantasyApiClient,
  elementId: number,
): Promise<ElementSummary> {
  return client.get<ElementSummary>(`element-summary/${elementId}/`);
}

export interface ElementSummary {
  /** Upcoming fixtures for this element. Not the same shape as
   * `fixtures/`'s Fixture[] (this includes difficulty/is_home-style
   * fields) — left loose rather than mistyped as Fixture[]. */
  fixtures: Record<string, unknown>[];
  /** Past gameweek-by-gameweek performance for the current season. */
  history: Record<string, unknown>[];
  /** Season-level totals for prior seasons. */
  history_past: Record<string, unknown>[];
}

export interface MeResponsePlayer {
  entry: number;
  [key: string]: unknown;
}

export interface MeResponse {
  player: MeResponsePlayer | null;
  watched: unknown;
}

/** Public: `player` is null when unauthenticated (no cookie, or a dead one),
 * non-null when the passed cookie is a live session. */
export function getMe(client: FantasyApiClient, cookie?: string): Promise<MeResponse> {
  return client.get<MeResponse>('me/', cookie ? { cookie } : undefined);
}

export interface Entry {
  id: number;
  [key: string]: unknown;
}

export function getEntry(client: FantasyApiClient, entryId: number): Promise<Entry> {
  return client.get<Entry>(`entry/${entryId}/`);
}

export function getEntryHistory(
  client: FantasyApiClient,
  entryId: number,
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(`entry/${entryId}/history/`);
}

export function getEntryTransfers(
  client: FantasyApiClient,
  entryId: number,
): Promise<Record<string, unknown>[]> {
  return client.get<Record<string, unknown>[]>(`entry/${entryId}/transfers/`);
}

export interface EntryPicksResponse {
  picks: Pick[];
  [key: string]: unknown;
}

export function getEntryPicks(
  client: FantasyApiClient,
  entryId: number,
  event: number,
): Promise<EntryPicksResponse> {
  return client.get<EntryPicksResponse>(`entry/${entryId}/event/${event}/picks/`);
}

// ---------------------------------------------------------------------------
// Auth-required read
// ---------------------------------------------------------------------------

export interface EntryChip {
  chip_type: string;
  status_for_entry: string;
  [key: string]: unknown;
}

/** picks[].selling_price / purchase_price here are authoritative — never
 * recompute them (see Pick in types.ts). */
export interface MyTeamResponse {
  picks: Pick[];
  chips: EntryChip[];
  [key: string]: unknown;
}

export function getMyTeam(
  client: FantasyApiClient,
  entryId: number,
  auth: AuthContext,
): Promise<MyTeamResponse> {
  return client.get<MyTeamResponse>(`my-team/${entryId}/`, { cookie: auth.cookie });
}

// ---------------------------------------------------------------------------
// Writes (auth required)
// ---------------------------------------------------------------------------

function writeOptions(auth: AuthContext) {
  return { cookie: auth.cookie, csrfToken: auth.csrfToken };
}

export interface EntryCreatePick {
  element: number;
  purchase_price: number;
}

export interface EntryCreateRequest {
  name: string;
  favourite_team: number;
  region: number;
  kit: unknown;
  /**
   * Required. The live API rejects a submission without it:
   * `terms_agreed: [{ message: "You must agree to the Terms and Conditions.",
   * code: "required" }]`. Not discoverable from the JS bundle — only a real
   * POST surfaced it.
   */
  terms_agreed: boolean;
  /**
   * Exactly 15 picks, and they MUST be ordered by `element_type` ascending
   * (GK, then DEF, then MID, then FWD). Submitting them in squad-position
   * order fails with
   * `{ code: "squad_not_type_order", message: "Elements must be submitted in
   * type order. We received type 2 after type 4" }`.
   *
   * Use `sortPicksByTypeOrder` rather than assembling this by hand.
   */
  picks: EntryCreatePick[];
}

/**
 * Orders picks by position type for `entry-create/`, which requires type
 * order and rejects anything else. Squad-position order (1-11 starters then
 * 12-15 bench) interleaves types and is exactly what the API refuses.
 */
export function sortPicksByTypeOrder<T extends { element: number }>(
  picks: readonly T[],
  elementTypeById: ReadonlyMap<number, number>,
): T[] {
  return [...picks].sort(
    (a, b) => (elementTypeById.get(a.element) ?? 0) - (elementTypeById.get(b.element) ?? 0),
  );
}

export function createEntry(
  client: FantasyApiClient,
  auth: AuthContext,
  payload: EntryCreateRequest,
): Promise<Entry> {
  return client.post<Entry>('entry-create/', payload, writeOptions(auth));
}

export interface MyTeamUpdateRequest {
  /** Literally `null` when no chip is active — never "" and never omitted. */
  chip: string | null;
  picks: Pick[];
}

export function updateMyTeam(
  client: FantasyApiClient,
  entryId: number,
  auth: AuthContext,
  payload: MyTeamUpdateRequest,
): Promise<MyTeamResponse> {
  return client.post<MyTeamResponse>(`my-team/${entryId}/`, payload, writeOptions(auth));
}

export interface TransfersRequest {
  /** Literally `null` when no chip is active — never "" and never omitted. */
  chip: string | null;
  entry: number;
  event: number;
  transfers: TransferMove[];
}

export interface TransfersResponse {
  [key: string]: unknown;
}

export function postTransfers(
  client: FantasyApiClient,
  auth: AuthContext,
  payload: TransfersRequest,
): Promise<TransfersResponse> {
  return client.post<TransfersResponse>('transfers/', payload, writeOptions(auth));
}

// ---------------------------------------------------------------------------
// Login (used by session.ts; kept here so all endpoint knowledge lives in one file)
// ---------------------------------------------------------------------------

export interface LoginRequest {
  email: string;
  password: string;
}

/** Returns the raw Response alongside the parsed body so the caller
 * (session.ts) can read the Set-Cookie header — the response body has
 * already been consumed to produce `data`, so don't re-read it. */
export function loginRaw(
  client: FantasyApiClient,
  payload: LoginRequest,
): Promise<{ data: unknown; response: Response }> {
  return client.postRaw<unknown>('player/login/', payload);
}
