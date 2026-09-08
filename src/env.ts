/**
 * The single `Env` interface for this Worker: bindings from wrangler.jsonc
 * plus vars/secrets. Every var is typed `string` (never a literal union or
 * `number`) because wrangler always hands `vars` to the Worker as strings --
 * narrowing the type here would make `Env` stop being assignable to the
 * narrower `*Env` interfaces each layer already declares (`FantasyEnv` in
 * src/api/client.ts, `LlmEnv` in src/ai/provider.ts, `GateEnv` in
 * src/ai/decide.ts, `DbEnv` in src/db/types.ts), which this file composes
 * rather than reshapes.
 *
 * All numeric/boolean parsing happens in ONE place: `parseConfig` below.
 * Nothing else in this codebase should call `Number(env.SOMETHING)`
 * directly -- `Number('')` is `0`, which is finite and would silently turn
 * an unset `SQUAD_MARGIN` into a 0% margin (the gate would then override
 * every LLM squad that isn't exactly optimal) or an unset
 * `MAX_TRANSFERS_PER_GW` into "never transfer". `parseGateOptionsFromEnv`
 * from src/ai/decide.ts already guards SQUAD_MARGIN/LINEUP_ABS_FLOOR
 * correctly, so `parseConfig` reuses it rather than re-implementing that
 * guard for two of its six fields.
 */

import { parseGateOptionsFromEnv } from './ai/decide';

export interface Env {
  // Bindings
  DB: D1Database;
  AI: Ai;
  INGEST: Workflow;
  DECIDE: Workflow;

  // Vars (wrangler always supplies these as strings)
  DRY_RUN: string;
  SESSION_PROVIDER: string;
  LLM_PROVIDER: string;
  LLM_MODEL: string;
  FANTASY_BASE_URL: string;
  MAX_TRANSFERS_PER_GW: string;
  SQUAD_MARGIN: string;
  LINEUP_ABS_FLOOR: string;
  NEURON_DAILY_CAP: string;
  /** entry-create/ identity for a FUTURE squad creation only -- see the
   * `DEFAULT_ENTRY_*` constants below for why these exist and entry 35088's
   * real, unchanged values. */
  ENTRY_NAME: string;
  ENTRY_FAVOURITE_TEAM: string;
  ENTRY_REGION: string;

  // Secrets (optional: a fresh deploy or 'manual' session mode may lack some)
  FANTASY_EMAIL?: string;
  FANTASY_PASSWORD?: string;
  FANTASY_SESSION_COOKIE?: string;
  DASHBOARD_TOKEN?: string;
  /** Where a dead-session alert is POSTed. Unset means alerting is off, so
   * CI and local dev post nowhere. Must be https -- see src/alert.ts. */
  ALERT_WEBHOOK_URL?: string;
}

const DEFAULT_MAX_TRANSFERS_PER_GW = 1;
const DEFAULT_NEURON_DAILY_CAP = 8000;

/**
 * `entry-create/` identity defaults (issue #16). These are the ONLY place
 * these three values should live -- `parseConfig` reads them below, and
 * `runSquadCreation` (src/workflows/decideCommit.ts) imports
 * `DEFAULT_ENTRY_FAVOURITE_TEAM`/`DEFAULT_ENTRY_REGION` directly as its
 * fallback when a configured id turns out not to be a real team/region.
 * Changing a default is a one-line edit here (plus mirroring it into
 * wrangler.jsonc's `vars` so the effective configuration stays visible in
 * one place) -- nowhere else in the codebase should hardcode these numbers.
 *
 * `DEFAULT_ENTRY_FAVOURITE_TEAM` is 2 (SL Benfica), a deliberate choice by
 * the repo owner -- NOT 1 (FC Arouca), which was picked only as a small
 * plausible id while reverse-engineering the payload. Entry 35088, already
 * live, keeps `favourite_team: 1` and is NOT being changed by this default;
 * it only takes effect on a future `entry-create/` call (at most once per
 * season -- see runSquadCreation's own doc comment).
 *
 * `DEFAULT_ENTRY_REGION` is 171 (Portugal, the league's own country -- a
 * defensible default rather than a coincidence of id order) out of the
 * 242-country list `GET regions/` returns. The server does not actually
 * honour `entry-create/`'s `region` field -- see `EntryCreateRequest.region`
 * in src/api/endpoints.ts for the entry-35088 evidence -- but a valid id is
 * still worth sending over an arbitrary one.
 */
export const DEFAULT_ENTRY_NAME = 'Fantasy Agent';
export const DEFAULT_ENTRY_FAVOURITE_TEAM = 2;
export const DEFAULT_ENTRY_REGION = 171;

export interface ParsedConfig {
  /** `env.DRY_RUN` parsed. Defaults TRUE -- only the literal strings
   * "false"/"0" turn it off. Ships true; nothing POSTs to the live account
   * until this (or the D1 `config.dry_run` override, see the workflow) is
   * flipped. */
  dryRun: boolean;
  maxTransfersPerGw: number;
  squadMargin: number;
  lineupAbsFloor: number;
  neuronDailyCap: number;
  /** `env.ENTRY_NAME`, defaulting to `DEFAULT_ENTRY_NAME` when unset/blank.
   * Only consumed by `runSquadCreation` -- a fresh `entry-create/`, at most
   * once per season. */
  entryName: string;
  /** `env.ENTRY_FAVOURITE_TEAM`, defaulting to `DEFAULT_ENTRY_FAVOURITE_TEAM`
   * when unset/empty/non-positive. `runSquadCreation` still validates this
   * against the live `teams` table before submitting it -- see that
   * function's comment for why a config-time default is not enough on its
   * own. */
  entryFavouriteTeam: number;
  /** `env.ENTRY_REGION`, defaulting to `DEFAULT_ENTRY_REGION` when
   * unset/empty/non-positive. `runSquadCreation` best-effort validates this
   * against `GET regions/` -- see that function's comment. */
  entryRegion: number;
}

/** Parses `env.DRY_RUN`. Only "false" or "0" (case-insensitive) count as
 * off; anything else -- including an empty/missing var -- defaults to the
 * safe TRUE. */
export function parseDryRun(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== 'false' && normalized !== '0';
}

/** Parses a positive-integer var, falling back to `fallback` when missing,
 * empty, non-finite, or non-positive (guards the same `Number('')===0`
 * footgun `parseGateOptionsFromEnv` guards for the gate vars). */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Parses a string var, falling back to `fallback` when missing or blank
 * (whitespace-only counts as blank -- an accidental `ENTRY_NAME: " "` in
 * wrangler.jsonc must not submit a blank name). */
function parseNonEmptyString(raw: string | undefined, fallback: string): string {
  return raw !== undefined && raw.trim() !== '' ? raw : fallback;
}

/** Parses every numeric/boolean var out of `env` in one place. Call this
 * once per request/step and thread the result, rather than re-parsing
 * `env.*` strings ad hoc throughout the codebase. */
export function parseConfig(env: Env): ParsedConfig {
  const { squadMargin, lineupAbsFloor } = parseGateOptionsFromEnv(env);
  return {
    dryRun: parseDryRun(env.DRY_RUN),
    maxTransfersPerGw: parsePositiveInt(env.MAX_TRANSFERS_PER_GW, DEFAULT_MAX_TRANSFERS_PER_GW),
    squadMargin,
    lineupAbsFloor,
    neuronDailyCap: parsePositiveInt(env.NEURON_DAILY_CAP, DEFAULT_NEURON_DAILY_CAP),
    entryName: parseNonEmptyString(env.ENTRY_NAME, DEFAULT_ENTRY_NAME),
    entryFavouriteTeam: parsePositiveInt(env.ENTRY_FAVOURITE_TEAM, DEFAULT_ENTRY_FAVOURITE_TEAM),
    entryRegion: parsePositiveInt(env.ENTRY_REGION, DEFAULT_ENTRY_REGION),
  };
}
