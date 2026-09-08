# Workers AI response fixtures

These five files are **real, live Workers AI response envelopes**, captured for
issue #15 ("StubProvider does not match the real Workers AI response
envelope"). Nothing in them was hand-written or hand-edited.

- `json-schema-squad.json`
- `json-schema-lineup.json`
- `json-schema-transfer.json`
- `plain-text-json-content.json`
- `plain-text-prose.json`

## Shape

Each file is `{ "_captured": {...provenance...}, "request": {...} | null, "envelope": {...} }`.

- `_captured` records how and when the capture was made, and a human-readable
  note on what it demonstrates (see each file's `note` field).
- `request` is the input sent to `env.AI.run` (`null` for the two plain-text
  captures, which were driven by a fixed prompt rather than a built request).
- `envelope` is **verbatim** `JSON.stringify(await env.AI.run(model, input,
  {}))` — exactly the value `WorkersAiProvider.complete()` in
  `src/ai/provider.ts` passes to `extractResponseText`. No REST wrapper, no
  reshaping.

## How they were captured

A throwaway Worker was run under `wrangler dev`. The `ai` binding always
reaches remote Workers AI even in dev — there is no local emulation of the
model — so every capture here is a real, Neuron-spending call against
`nimeshjm`'s Cloudflare account (free plan). The captures cover both modes
this project's requests can take: `response_format: { type: 'json_schema' }`
with each of the three decision schemas (squad/lineup/transfer), and plain
text with no `response_format` at all (once where the model happened to
answer with JSON content, once where it answered with prose).

## Do not re-capture casually

Re-running the capture costs real Neurons (this batch cost roughly 63 Neurons
combined — see each file's `_captured.neurons`) against the free plan's
10,000/day allowance, and — more importantly — Workers AI is a remote service
this project does not control: its response shape, its default model
routing, and even the *specific* model that answers (see
`_captured.respondingModel` — it never matches the requested model id) can
change without notice, exactly as the model root-caused in #15 already did
once. These fixtures are the closest thing this project has to a snapshot of
that external contract, and `test/provider.test.ts` asserts against
`typeof envelope.response` specifically so a future Workers AI shape change
fails the test suite loudly instead of silently degrading to
`deterministic-fallback` in production.

If Workers AI's shape genuinely changes and these fixtures need updating,
do it deliberately: capture fresh envelopes the same way (a throwaway Worker
under `wrangler dev`, `JSON.stringify(await env.AI.run(...))`, no editing),
replace the affected file(s), and update the doc comment on
`extractResponseText` in `src/ai/provider.ts` if the new shape changes what
that function needs to assume.
