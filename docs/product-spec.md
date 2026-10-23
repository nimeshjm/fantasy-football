# Product spec

## Purpose

An autonomous agent that plays Fantasy Liga Portugal Betclic on one live account (entry 35088). Each gameweek it ingests results and stats, projects points, and sets the lineup and at most one transfer. An LLM (Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) chooses among options that code has already validated; a deterministic optimizer is the guardrail and the fallback, so a legal team is always committed before the deadline. Runs entirely on the Cloudflare free tier. Original design: issue #1.

## Safety rules (never weaken)

- Writes to the live account are irreversible and cost points. `DRY_RUN` is `"false"` in production.
- One transfer per gameweek (`MAX_TRANSFERS_PER_GW=1`), no points hits, season cap of 20 transfers tracked cumulatively.
- No chip (`wildcard`, `pdbus`, `2capt`, `uteam`) is ever played automatically; chip semantics are inferred, not documented.
- Kill switch: D1 `config.enabled = 0` halts all writes without a redeploy. D1 `config.dry_run` can only force dry-run on.
- Workers AI budget: free plan is 10,000 Neurons/day; the agent reserves 8,000 (`NEURON_DAILY_CAP`). Anything that spends Neurons outside the agent's own counter (live eval) is invisible to it and can starve a deadline decision.
- Fail closed: no fixtures in D1 for the gameweek means abstain and alert, never decide on zero projections.
- LLM output is never trusted: every answer passes `src/ai/validate.ts` and the sanity gate before it can become a write.
- Public repo: no secret, cookie or webhook URL in code, logs, span attributes, PR text or issues.

## Config tiers

1. Non-secret vars in `wrangler.jsonc` (`DRY_RUN`, `LLM_MODEL`, caps, margins, entry identity). Changing `DRY_RUN` or a cap is a human decision.
2. Worker secrets via `wrangler secret put` (`FANTASY_SESSION_COOKIE`, `DASHBOARD_TOKEN`, `ALERT_WEBHOOK_URL`, `API_FOOTBALL_KEY`). Set by hand only.
3. GitHub repo secrets: only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, used by `deploy.yml`.
4. D1 `config` table runtime overrides (`enabled`, `dry_run`, `session_alert_open`). Operator SQL only.
Deploy-injected vars `GIT_SHA` and `DEPLOYED_AT` (from `deploy.yml`) are served by `GET /version` and carry no behaviour.

## What agents may never do

- Deploy, run migrations against `--remote`, run `wrangler secret`, or run live eval (`EVAL_LIVE`).
- Flip `DRY_RUN`, raise a cap, enable a chip, add a transfer path, or touch the kill switch.
- Edit `.github/**`, `package.json` scripts, `wrangler.jsonc` vars, `factory.yml` or `.agents/**` (human-owned).
- Re-record eval cassettes or change a prompt without updating its snapshots and flagging the live re-record as a human follow-up.
- Merge anything that is not `autonomy:dark`, or approve their own work.

## Backlog seeds

Candidates for triage to turn into issues (each is `size:S` or `size:M` unless noted). Acceptance criteria are written to be checked by a test or command.

1. **Dashboard: show deployed version.** Render `GIT_SHA` (short) and `DEPLOYED_AT` in the `GET /` header.
   - `GET /` HTML contains the 7-char SHA when `GIT_SHA` is set and the text `unknown` when not.
   - Value passes through `escapeHtml`; a dashboard test covers both cases. `risk:low`, dark.
2. **Docs: fix stale UEFA-signal references.** README and AGENTS.md still say the rotation signal comes from api-football.com; issue #58 moved it to ESPN (`src/api/espn.ts`).
   - `grep -rn "api-football" README.md AGENTS.md` returns only mentions that describe the dormant client.
   - No files outside `*.md` change. `chore`, `size:S`, `risk:low`, dark.
3. **Session cookie expiry reminder.** Alert once when the cookie's observed age passes a configurable threshold.
   - Pure function in `src/sessionHealth.ts` decides; unit tests cover below, at and above threshold and the latch.
   - Reuses `sendWebhookAlert` and the `session_alert_open` latch pattern; no new secret. `risk:high` (alerting path).
4. **Eval: fail `npm test` when a prompt snapshot is missing a case.** Close the gap between `eval/prompts/` and the dataset.
   - A test enumerates dataset case ids and asserts one committed snapshot each.
   - No live calls, no cassette changes. `risk:low`.
5. **Neuron spend history on the dashboard.** Show the last 7 days of `ai_budget.neurons_spent` against the cap.
   - Reads existing table through a new `src/db` helper with a unit test; no migration.
   - Output escaped; empty history renders "no data". `risk:low`, dark.
6. **Second LLM provider (issue #35), split.** Provider-neutral cost type first (replace `LlmUsage.neurons`), then a Gemini `LlmProvider`.
   - Child issues with `Depends on #N`; first child keeps behaviour byte-identical (existing tests unchanged).
   - Gemini key is a Worker secret, absent means provider unavailable, never a failure. `size:L`, `risk:high`.
7. **Cover `reportError` call sites.** Every `reportError` slug has a test asserting slug and attrs, and no `actions_log` row of that kind.
   - Slugs: `cron-tick-error`, `fixtures-refresh-error`, `cron-dispatch-*`, `decide-commit-error`. `risk:low`, dark.
8. **Add root-span attributes for the tick result.** Add `app.deadline_action` and `app.session_healthy` as attributes on the active span in `scheduled`.
   - Attributes only, no new spans; guarded so no active span is a no-op; unit test with a fake span. `risk:low`.
