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
  };
}
