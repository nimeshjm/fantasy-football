# LLM eval framework

This directory answers a question the rest of the repo cannot: **is the model any
good?** The agent (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI) makes
three decisions — squad, lineup, transfer — and deterministic code in `src/`
guarantees those decisions are _legal_. It says nothing about whether they're
_good_. This is the benchmark for that, built as issue
[#29](https://github.com/nimeshjm/fantasy-football/issues/29).

## Five axes, never one score

Every trial is graded on five separate axes:

1. **Conformance** — did the response parse into a valid squad/lineup/transfer
   shape at all (`parse_ok@1`, refusal rate, truncation rate)?
2. **Legality** — does the parsed answer satisfy the game's rules (club limits,
   formation, captain-not-starting, …)?
3. **Regret vs. optimizer** — how far the model's pick is, in points, from this
   repo's own deterministic optimizer, reported _alongside_ a differentiation
   stat (Jaccard distance between the model's XI/15 and the optimizer's).
4. **Realized points** — how the chosen lineup actually scored, captain doubled.
5. **Cost** — metered Neurons per decision, and how far off the pre-call
   estimate was.

These are never collapsed into a composite. The clearest reason is that axes 3
and 4 actively trade against each other: a model that just copies the
optimizer's own output scores _zero_ regret while adding nothing — which is
exactly why regret is always reported next to differentiation, not alone. Any
single weighted score would reward that copy, and would also hide _which_ axis
broke when a prompt or model change regresses something. Five numbers you can
read is more honest than one number you can't unpack.

## Two lanes

**Replay** is the default. It runs in CI inside `npm run test`, at zero network
cost and zero Neurons. `ReplayAi` looks up a recorded response envelope for each
`(model, input)` pair in `eval/cassettes/` and returns it. This lane guards the
**harness and the graders** — it re-asserts that a known-good recorded answer
still parses, validates, gates, and costs the same. It does not call a model.

**Live** (`EVAL_LIVE=1 npm run eval`) makes real calls against Workers AI's REST
API. It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, prints a
pre-flight worst-case Neuron estimate, and refuses to start if that estimate
exceeds `EVAL_MAX_NEURONS` (default **800**). A successful live run writes new
cassettes for the replay lane to use afterward.

### Replay does not catch a prompt regression

This is the single most confusing thing about the design, so it is stated
plainly: **a cassette is keyed on `hash(model, input)`, and `input` contains the
prompt.** Edit a prompt and every cassette for that case misses. The replay lane
does not report "regression" — it reports "no cassette", and that is not a bug
in the harness, it is the lane doing exactly what it is for.

Two different things can go wrong with a prompt, and they are caught by two
different mechanisms:

- **Prompt-shape drift** (an accidental edit to what gets sent) is deterministic
  and needs no model call — it is caught by the prompt-snapshot assertions in
  `eval/prompts/`, on the pattern already established by `test/prompts.test.ts`.
- **Model-behavior change** (the same prompt, a different or updated model
  answering differently) can only be measured by a live re-record.

So a deliberate prompt change costs two steps: update the prompt snapshots, then
re-record cassettes with a live run. That is the real cost of touching a
prompt, and it is worth remembering before the first "no cassette" error reads
as something broken.

## Do not re-record casually

Live runs spend real Neurons on the same Cloudflare free-tier account (10,000
Neurons/day) that the production agent draws from. The agent reserves 8,000 of
that via `NEURON_DAILY_CAP` and tracks its own spend in D1 — but the eval's
spend happens from Node, outside that counter, so it is **invisible** to the
agent's own budget tracking. An unbudgeted live run can quietly starve the
agent's deadline decision on gameweek day. Run live captures outside gameweek
deadline windows, and treat `EVAL_MAX_NEURONS` as a real ceiling, not a
formality.

## Honest limits

- **Regret measures agreement with this repo's own projection model, not
  skill.** A model that reproduces the optimizer's output exactly scores zero
  regret while adding no value — which is why it is never reported without the
  differentiation stat beside it.
- **Realized points is descriptive only**, never a pass/fail threshold. It
  covers three gameweeks, which is no statistical power to distinguish models,
  and the input state used to reconstruct "as of just before gameweek g" carries
  the two leaks documented in `test/backtest.test.ts:1-44` (stale `status`/
  availability, and `now_cost` having partly moved on GW1-4 form by the time of
  the one snapshot this repo has). There is no autosub simulation — this game's
  bench-autosub semantics aren't established anywhere in this repo.
- NaN is a legitimate score value where a metric is undefined for a given
  input (mirroring `spearman` in `test/backtest.test.ts`, which returns NaN
  rather than a silently misleading 0). The report prints NaN as NaN.

## Where things live

- `eval/core/` — the harness: `types.ts` (the contract), `runner.ts`
  (`runSuite`), `budget.ts` (Neuron budgeting), `sink.ts` (the audit sink that
  captures each attempt), `report.ts` (aggregation and the markdown/console/JSON
  report).
- `eval/suites/fantasy/` — the fantasy-football decision suite: `fixtures.ts`
  (the point-in-time rebuild, shared with `test/backtest.test.ts`),
  `dataset.ts` (nine fixture cases, GW2-4), `adversarial.ts` (four synthetic
  lineups), `tasks.ts` (the three tasks), and `graders/` (the five axes).
- `eval/cassettes/` — committed recorded response envelopes, one per
  `(model, input)` pair the replay lane depends on. Empty until the first live
  run records some.
- `eval/prompts/` — committed prompt snapshots, one per case, asserted against
  on every run to catch prompt-shape drift independent of any model call.
- `eval/runs/` — gitignored output: `trials.jsonl`, `summary.json`, and
  `report.md` per run, written under `eval/runs/<runId>/`.

`test/eval.test.ts` is the single vitest entry point, in three lanes:

- **harness** — always runs, no network and no cassettes needed. It drives all
  13 cases with a dead provider and checks each one still yields a legal,
  graded, recorded trial. This is the CI guard, and it is what catches a broken
  harness rather than a bad model.
- **replay** — skipped until `eval/cassettes/` has something in it. Re-grades
  recorded answers.
- **live** — `EVAL_LIVE=1` only. Needs `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`, capped by `EVAL_MAX_NEURONS` (default 2000).

Run the replay and harness lanes with `npm run eval`, or just `npm run test`,
which includes them.

## What a live run costs

Measured, not guessed. Per _call_ ceilings are squad ~297, lineup ~126 and
transfer ~81 Neurons — that is the pre-call `max_tokens` reservation
`decide.ts` charges when a call fails. Per _decision_ the ceiling is three
times that, since `MAX_RETRIES` is 2, and the whole 13-case suite's worst case
is ~6,030 Neurons. Expected cost is far lower: ~241 Neurons for the suite, from
the ~21/21/11 metered figures in the recorded captures.

The runner gates each trial on one call's ceiling rather than the decision's,
because `callLlm` re-checks the budget before every attempt and stops cleanly
on its own. Gating on the retry ceiling would refuse trials that in practice
cost about 4% of it.

The 2000 default is the honest headroom: the free plan allows 10,000
Neurons/day and the production agent reserves 8,000 via `NEURON_DAILY_CAP`.
