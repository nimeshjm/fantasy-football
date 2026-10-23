# Architecture

One Cloudflare Worker (`src/index.ts`): an hourly cron plus a token-gated HTTP surface, two Workflows, one D1 database (`fantasy`), Workers AI. Config tiers and safety rules are in `docs/product-spec.md`.

## Module map (`src/`)

- `index.ts` entry: `fetch` routes (`/`, `/decisions`, `/decisions/:id`, `/version`, `POST /admin/login-probe`), `scheduled`, `buildCronPorts` wiring, Workflow class re-exports.
- `adminAuth.ts` token gate (`isAuthorized`, `notFound`, `timingSafeEqual`); every failure is a 404.
- `alert.ts` webhook alert POST to `ALERT_WEBHOOK_URL` (https only).
- `baseline.ts` wires the optimizer and projections into the `DeterministicBaseline` the AI layer uses.
- `cron.ts` pure planner (`planCronActions`, `planDeadlineAction`, `detectDataCheckedFlips`) plus `runScheduledTick` over `CronPorts`.
- `dashboard.ts` server-rendered HTML for `/`, `/decisions`, `/decisions/:id`.
- `env.ts` `Env` interface, `parseConfig`, defaults for entry identity.
- `loginProbe.ts` `POST /admin/login-probe`, rate-limited 1/min, never writes the session row.
- `opponentNote.ts` builds the `opp:` prompt fragment for a shortlist entry.
- `ownedPlayers.ts` joins squad picks to elements for validation and lineup solving.
- `scoring.ts` the game's scoring rules (not FPL's); per-fixture, then summed.
- `sessionHealth.ts` pure session heartbeat, failure streak, alert planning, cookie fingerprint.
- `sessionStore.ts` session cookie holder for the API client.
- `shortlist.ts` builds the ~60-candidate shortlist for the LLM.
- `telemetry.ts` `reportError`: exception on the active span plus one structured log line, exported to Honeycomb.
- `types.ts` shared game types (events, elements, picks, transfers).
- `uefaRotation.ts` UEFA rotation-risk note from recent appearances.
- `ai/decide.ts` one LLM decision end to end: budget check, call, parse, validate, retry (max 2), sanity gate.
- `ai/prompts.ts` compact prompt builders for squad, lineup, transfer.
- `ai/provider.ts` Workers AI wrapper, Neuron estimation and metering, `selectProvider`.
- `ai/schemas.ts` flat JSON schemas, TS types and runtime parsers per decision.
- `ai/validate.ts` hard-rule validation of every LLM answer.
- `api/client.ts` fetch wrapper for the Fantasy API. `api/endpoints.ts` typed endpoint wrappers. `api/session.ts` session acquisition and health check.
- `api/espn.ts`, `api/espnTeams.ts` keyless ESPN client and team-id map (live UEFA signal). `api/apiFootball.ts`, `api/apiFootballTeams.ts` dormant api-football client.
- `db/*.ts` typed hand-written D1 helpers, one file per table or concern; `db/bulk.ts` shared bulk upsert; `db/logging.ts` `actions_log`, `ai_calls`, `ai_budget`; `db/decisions.ts` decision grouping for the dashboard; `db/index.ts` re-exports.
- `model/projection.ts` per-player expected points (two strategies). `model/ratings.ts` Poisson attack/defence team ratings with ridge regularization.
- `optimizer/lineup.ts` exact XI, bench and captain solve. `optimizer/squad.ts` bounded legal 15 search. `optimizer/transfers.ts` legal single and double transfer candidates.
- `workflows/ingest.ts` `IngestWorkflow`. `workflows/decideCommit.ts` `DecideCommitWorkflow` and `runDecisionCore`. `workflows/index.ts` re-exports.

## Data flow

Cron tick (`0 * * * *`) -> `runScheduledTick`: if enabled, refresh bootstrap and upcoming fixtures into D1, check session health (one `session-health` beat per tick), then `planCronActions`:
- `data_checked` flipped true for a gameweek -> `INGEST` (per-gameweek live stats, then refit team ratings).
- 60-120 min before deadline -> `DECIDE` mode `full`; 0-60 min -> `DECIDE` mode `lineup-only` (`xi-recheck`).
Decide: baseline xPts -> shortlist -> LLM decision (`ai/decide.ts`) -> validate -> sanity gate vs deterministic optimum -> commit (`transfers/`, `my-team/{id}/`), else deterministic fallback. Everything is logged to D1. Dashboard reads D1 only.

## D1 tables (`migrations/0001-0005`)

`events`, `teams`, `elements`, `element_gw_stats`, `element_history_past`, `fixtures`, `team_ratings`, `projections`, `squad_state`, `actions_log` (kind, ok, intent, response JSON, never pruned), `ai_calls` (attempts, estimated and metered Neurons, gate verdicts), `ai_budget` (Neurons per day), `session` (single row, CHECK id=1), `config` (key/value: `enabled`, `dry_run`, `session_alert_open`), `uefa_appearances`. Migrations are append-only: add `migrations/000N_name.sql`, never edit an applied one.

## Workflows

`ingest` (binding `INGEST`, class `IngestWorkflow`) and `decide-commit` (binding `DECIDE`, class `DecideCommitWorkflow`). Instance ids derive from event id and action, so a duplicate create is rejected: that is the at-most-once latch.

## Cron rules

- Never hardcode a match day; deadlines come from D1.
- Dispatch buckets are exactly 60 minutes wide so one hourly tick always lands in each.
- `config.enabled = 0` returns before any write, including heartbeats and alerts.
- `runScheduledTick` never throws; failures go through `reportError` (errors to Honeycomb) or `logAction` (state to D1).
- Budgets per invocation: 10 ms CPU per Workflow step, 50 subrequests, 50 D1 queries.
