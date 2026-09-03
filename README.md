# Fantasy Liga Portugal Betclic — autonomous agent

An agent that plays [Fantasy Liga Portugal Betclic](https://fantasy.ligaportugal.pt/): it ingests
match results and player stats, builds a squad, and sets the lineup and transfers each gameweek.
Runs entirely on the Cloudflare free tier. Team selection and substitution decisions are made by
an LLM (Workers AI), with a deterministic optimizer as both guardrail and fallback.

Design and reasoning: **[issue #1](https://github.com/nimeshjm/fantasy-football/issues/1)**.

## How it works

An hourly Cron Trigger wakes a Worker, which reads gameweek deadlines from D1 and decides what to
do — ingest finished-gameweek stats, or run the decision pipeline in the window before a deadline.
Match days are never hardcoded.

```
Cron (hourly) ──> tick(): refresh prices, check session, read deadlines
                    │
      ┌─────────────┴──────────────┐
      ▼                            ▼
IngestWorkflow              DecideCommitWorkflow
event/{n}/live/             baseline xPts (all 656)
fixtures/?event                 ↓ shortlist ~60
    ↓                        LLM decision (JSON)
D1 + team ratings               ↓ validate / repair
                             sanity gate vs optimum
                                ↓ commit
                            POST transfers/ + my-team/
```

The LLM decides; code guarantees legality. Every option it is offered is pre-validated, its output
is checked against every hard rule, and a per-decision sanity gate can override it. Any hard
failure falls back to the deterministic optimizer, which always produces a legal team by the
deadline.

## Scoring

The game is a rebranded Fantasy Premier League engine, but **the scoring is not FPL's** and the
`game_config.scoring` payload omits its divisors. The real rules were recovered by aggregating
every `explain[]` block from `event/{1..4}/live/` across all 656 players, and are verified in
`test/scoring.test.ts` against 2,322 player-fixture rows.

The differences that matter:

| Stat | This game | FPL |
|---|---|---|
| saves | `floor(n / 2)` | `floor(n / 3)` |
| shots on target | `floor(n / 2)`, all outfield positions | not scored at all |
| goals conceded | `-floor(n / 2)` (GK/DEF) | `-floor(n / 2)` |
| goals | GK/DEF 6, MID 5, FWD 4 | GK/DEF 6, MID 5, FWD 4 |

Shots on target scoring at all — and saves at `/2` rather than `/3` — makes shot-volume forwards
and high-workload goalkeepers worth materially more than FPL intuition suggests, and attacking
full-backs earn shot points too.

Two rules that are easy to get wrong and are guarded by tests:

- Appearance points require `minutes > 0`, but **cards score without an appearance** — an unused
  substitute booked on the bench scores −1.
- The `floor(n/2)` divisors **do not distribute over addition**: 3 saves in each of two fixtures is
  2 points, not `floor(6/2) = 3`. Scoring is therefore per-fixture and summed, never applied to a
  gameweek total. This only bites on a rescheduled double gameweek, and it bites silently.

## Safety

Writes to the live account are irreversible and cost points, so:

- `DRY_RUN` is **`false`** — the agent posts to the live account. It shipped `true` and was
  flipped in `2c9db47` once the rails below were in place.
- One transfer per gameweek by default; no points hits in v1.
- No chip is ever played automatically — `pdbus` / `2capt` / `uteam` semantics are inferred, not
  documented.
- The season-long 20-transfer cap is tracked cumulatively.
- A kill switch in the `config` table halts all writes without a redeploy.
- Every decision, prompt, validation outcome and write is logged for audit.

## Session health

The `sessionid` is a pasted secret (`SESSION_PROVIDER=manual`) because the
site rejects `POST player/login/` for this account. It expires and cannot
re-authenticate itself, and the failure is quiet: the agent still commits a
legal team, it just stops reading the injury text. So the tick logs a
`session-health` heartbeat every hour, and **three consecutive failures POST
to `ALERT_WEBHOOK_URL`** — once per incident, latched only on actual
delivery, cleared automatically on recovery.

Two limits worth knowing:

- **The kill switch silences alerting too.** `config.enabled = 0` returns
  before any write, heartbeat included, so a disabled agent says nothing
  about a dead cookie. That is the deliberate cost of "no writes at all"
  being absolute.
- **This cannot detect a dead cron.** The streak is counted in beats, not
  elapsed time, so a Cloudflare cron outage raises no false alarm — and
  equally raises no alarm. Catching that needs an external dead-man's switch.

`CONTRIBUTING.md` covers rotating the cookie, reading the observed lifetime
out of the heartbeat archive, and the `/admin/login-probe` route.

## Setup

Requires a Cloudflare account and a Fantasy Liga Portugal account. See `CONTRIBUTING.md` for local
development, and note that the fantasy site credentials are set **only** via
`wrangler secret put` — never through CI, since this repo is public.
