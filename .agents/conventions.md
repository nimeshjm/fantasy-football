# Conventions

## Commits and PRs
- Subject: imperative, no trailing period, issue in parentheses at the end. Examples: `Fix the europe note and show the upcoming opponent (#69)`, `Treat an information-free response as absent in the Detail cell (#68)`.
- Body explains the why in a few lines. Trailer on every agent commit: `Co-Authored-By: <model name> <noreply@anthropic.com>` (as in existing history).
- One concern per commit. PR body has `Closes #N`. Branches `feat/<N>-<slug>`, `fix/<N>-<slug>`.
- Diffs at or under 300 lines and 8 files; vertical slices (code, test and docs for one behaviour).

## Code
- Config parsing: all numeric and boolean var parsing lives in `parseConfig` (`src/env.ts`). Never call `Number(env.X)` elsewhere (`Number('')` is 0). Every var is typed `string` in `Env`. New vars: add to `Env`, `parseConfig` with a safe default and `test/env.test.ts`, and mirror in `wrangler.jsonc` (human-owned). Deploy-injected `GIT_SHA` and `DEPLOYED_AT` are the exception: read-only strings served by `/version`.
- No `console.*` in `src/`, with one sanctioned exception: `src/telemetry.ts` (`reportError`). Errors go to Honeycomb through `reportError({ slug, err, attrs })`; state and decision outcomes go to D1 through `logAction`. `reportError` never throws and attrs are low-cardinality (never a cookie, token or prompt).
- Telemetry on instrumented code: add attributes to the active span or to `reportError` attrs, do not add new spans. Names `app.*` for custom attributes.
- Dependency injection: logic that can run without a Workers runtime takes narrow ports (`CronPorts`, `DecisionCoreDeps`), not `Env` or `D1Database`.
- Module scope must not do I/O, timers, randomness or construct `Response` bodies (workerd rejects the upload, error 10021). `notFound()` is a factory for that reason.
- Auth: every operator route calls `isAuthorized` from `src/adminAuth.ts` and returns `notFound()` on failure, never 401/403.
- D1: bound parameters are capped at 100 per statement. Bulk writes go through `src/db/bulk.ts` (one JSON parameter unpacked with `json_each`), chunked. Never build SQL from values.
- Booleans are INTEGER 0/1 in SQLite and coerced to real booleans in `src/db`. Timestamps are ISO 8601 TEXT.
- CPU: 10 ms per Workflow step. One large parse per step; split steps rather than add work to one.
- Scoring is per fixture, then summed; never apply `floor(n/2)` to a gameweek total.
- Prettier: single quotes, semicolons, width 100, trailing commas (`.prettierrc.json`). Run `npm run format`.
- Comments explain why, and are kept short.

## Eval, prompts and cassettes
- A cassette is keyed on `hash(model, input)` and the input contains the prompt. Editing a prompt makes every cassette for that case miss ("no cassette"), which is expected.
- Prompt change = update `eval/prompts/*.snap.txt` (and `test/prompts.test.ts` expectations) in the same PR. Re-recording cassettes needs `EVAL_LIVE=1` and spends production Neurons: agents must not do it. Flag it in the PR as a human follow-up.
- Never hand-edit `eval/cassettes/` or `test/fixtures/` (prettier-ignored, generated).

## Tests and checks
- Before any PR: `npm run typecheck && npm run lint && npm test`. `lint` is `prettier --check src test eval vitest.config.ts` (Markdown and YAML are not linted).
- Two vitest projects: `node` (most tests, `cloudflare:workers` aliased to `test/stubs/cloudflareWorkers.ts`) and `workers` (`test/workers/**`, real workerd, bundles via `wrangler deploy --dry-run`). New tests go in `test/<name>.test.ts`; a new `cloudflare:workers` import needs a stub export.
- Safe in parallel worktrees: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npx vitest run test/<file>`, `npm run format`.
- Unsafe or forbidden: `npm run deploy`, `npx wrangler deploy` (without `--dry-run`), `wrangler secret`, `npm run migrate:remote`, anything `--remote`, `EVAL_LIVE=1`, `npm run dev` on a shared port, `npm run migrate:local` (writes `.wrangler/` state shared across worktrees of one checkout).
- Pure functions get unit tests with plain data; impure orchestration is tested through fake ports.
