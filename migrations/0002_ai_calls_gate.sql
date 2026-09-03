-- The per-decision sanity gate decides whether the LLM's answer is used or
-- overridden by the deterministic optimizer. `gate_verdict` existed from
-- 0001 but was written as NULL on every row, so no gate decision was ever
-- persisted and the gate's calibration could not be judged from the data.
--
-- `gate_verdict` now carries 'accept' | 'override'. These four columns carry
-- the rest of what is needed to JUDGE an override rather than merely observe
-- one: which side won, why, and the two scores that decided it. Nullable
-- because the gate only runs after a schema-valid, rules-legal LLM answer --
-- an attempt that never got that far has no verdict, and that distinction is
-- exactly what must stay readable.
ALTER TABLE ai_calls ADD COLUMN gate_source TEXT;
ALTER TABLE ai_calls ADD COLUMN gate_override_reason TEXT;
ALTER TABLE ai_calls ADD COLUMN llm_score REAL;
ALTER TABLE ai_calls ADD COLUMN deterministic_score REAL;
