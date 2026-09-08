-- Records the METERED Neuron/token figures Workers AI actually charged,
-- alongside the pre-call estimate `est_neurons_in`/`est_neurons_out` already
-- carry (issue #27).
--
-- `envelope.usage` (prompt_tokens, completion_tokens, neurons) was there in
-- every one of the five real Workers AI responses captured for #15
-- (test/fixtures/workers-ai/, commit 797bc37) and was simply never read.
-- Comparing the three json_schema captures against what this project was
-- recording before this fix: squad charged 86.0 Neurons for a call metered
-- at 21.4 (4.0x); lineup 84.6 vs 20.6 (4.1x); transfer 63.5 vs 10.9 (5.9x) --
-- because the reservation, sized pessimistically at `max_tokens` for the
-- pre-call budget check, was never trued up against what the model actually
-- used.
--
-- These columns do NOT replace est_neurons_in/est_neurons_out -- keeping the
-- estimate next to the actual is what makes it possible to notice, from the
-- data, when `estimateTokens`'s calibration next drifts from reality, the
-- same way this issue itself was diagnosed. Nullable because a failed call
-- (refusal, truncation, provider error) still runs the model but returns no
-- metered `usage` to true up against -- it keeps charging the pre-call
-- estimate (see decide.ts's `callLlm`), so it has nothing to record here.
--
--  * metered_prompt_tokens      -- envelope.usage.prompt_tokens
--  * metered_completion_tokens  -- envelope.usage.completion_tokens
--  * metered_neurons            -- envelope.usage.neurons (the actual spend)
--  * cached_tokens              -- envelope.usage.prompt_tokens_details.cached_tokens.
--                                  0 in all five captures; recorded because
--                                  it is one more nullable column on a
--                                  migration already being written, not
--                                  because anything reads it yet.
ALTER TABLE ai_calls ADD COLUMN metered_prompt_tokens INTEGER;
ALTER TABLE ai_calls ADD COLUMN metered_completion_tokens INTEGER;
ALTER TABLE ai_calls ADD COLUMN metered_neurons REAL;
ALTER TABLE ai_calls ADD COLUMN cached_tokens INTEGER;
