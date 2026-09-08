/**
 * Wrapper around the Workers AI binding (`env.AI`).
 *
 * Hard facts about the deployed model (@cf/meta/llama-3.3-70b-instruct-fp8-fast)
 * and this project's plan, verified against Cloudflare's docs - build to these:
 *
 *  - The context window is 24,000 tokens TOTAL (prompt + answer). Callers must
 *    leave room for `max_tokens` when sizing a prompt (see
 *    `CONTEXT_WINDOW_TOKENS` and `assertPromptFits` in prompts.ts).
 *  - `max_tokens` defaults to 256 on the binding and MUST be set explicitly,
 *    or answers truncate mid-JSON.
 *  - The free plan gives 10,000 Neurons/day. This model costs 26,668 Neurons
 *    per 1M input tokens and 204,805 Neurons per 1M output tokens - i.e.
 *    output is ~7.7x the price of input, token for token. Prompts may be
 *    generous; answers must stay terse (see schemas.ts). `estimateNeurons`
 *    below implements the pricing.
 *  - JSON mode (`response_format: { type: 'json_schema', json_schema }`) is
 *    OpenAI-compatible, but `json_schema` is the RAW JSON Schema object, not
 *    an OpenAI-style `{ name, schema }` wrapper. It does not support
 *    streaming, and the model can refuse a complex schema outright (Workers
 *    AI raises "JSON Mode couldn't be met"). A refusal or an unparseable
 *    body is a *failed call* here, never a thrown exception past this file.
 */

export const DEFAULT_LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Total context window for the deployed model, in tokens. Every prompt
 * (system + user) plus the requested `max_tokens` for the answer must fit
 * inside this. */
export const CONTEXT_WINDOW_TOKENS = 24_000;

/** Neuron pricing for @cf/meta/llama-3.3-70b-instruct-fp8-fast, per the
 * task's verified figures (Neurons per 1,000,000 tokens). Update these if
 * Cloudflare repriced the model. */
export const NEURONS_PER_1M_INPUT_TOKENS = 26_668;
export const NEURONS_PER_1M_OUTPUT_TOKENS = 204_805;

/** Estimated Neuron cost of a call with the given input/output token counts. */
export function estimateNeurons(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * NEURONS_PER_1M_INPUT_TOKENS + outputTokens * NEURONS_PER_1M_OUTPUT_TOKENS) /
    1_000_000
  );
}

export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmCompleteRequest {
  messages: LlmMessage[];
  /** A flat JSON Schema object (see src/ai/schemas.ts). Sent verbatim as
   * `response_format.json_schema` - Workers AI's JSON mode takes the raw
   * schema, not an OpenAI-style `{ name, schema }` wrapper. */
  jsonSchema: Record<string, unknown>;
  /** MUST be set: the binding defaults `max_tokens` to 256, which truncates
   * every one of this project's answers mid-JSON. */
  maxTokens: number;
}

/**
 * The metered token/Neuron figures Workers AI actually charged for a call,
 * lifted from `envelope.usage` (issue #27). Every one of the five recorded
 * fixtures in test/fixtures/workers-ai/ carries this block, and
 * `estimateNeurons(usage.promptTokens, usage.completionTokens)` reproduces
 * `usage.neurons` to the digit on all five - the pricing constants above
 * were never wrong, only what decide.ts fed them was (the pre-call estimate,
 * charged as if every call spent the full `max_tokens` reservation).
 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  neurons: number;
  /** `usage.prompt_tokens_details.cached_tokens` - 0 in all five captures.
   * Recorded because it costs one more nullable column on a migration this
   * issue already adds; nothing downstream reads it yet, so it stays
   * separately optional rather than gating `LlmUsage` itself on its
   * presence. */
  cachedTokens?: number;
}

export type LlmCompleteResult =
  { ok: true; text: string; usage?: LlmUsage } | { ok: false; error: string; rawResponse?: string };

/** One provider, one method. decide.ts depends only on this - never on a
 * concrete provider class - so a future provider is a drop-in. */
export interface LlmProvider {
  complete(request: LlmCompleteRequest): Promise<LlmCompleteResult>;
}

/** Minimal environment shape this module needs. */
export interface LlmEnv {
  AI: Ai;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
}

export class WorkersAiProvider implements LlmProvider {
  private readonly model: string;

  constructor(
    private readonly ai: Ai,
    model?: string,
  ) {
    this.model = model && model.length > 0 ? model : DEFAULT_LLM_MODEL;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    try {
      const result = await this.ai.run(
        this.model,
        {
          messages: request.messages,
          response_format: {
            type: 'json_schema',
            json_schema: request.jsonSchema,
          },
          max_tokens: request.maxTokens,
        } as Record<string, unknown>,
        {},
      );

      // A refusal and a truncation are both real signals about THIS call,
      // not evidence the envelope is malformed — surface each as its own
      // legible `error` string rather than folding them into the generic
      // "no parsable response text" below (issue #28). Checked in this
      // order, and checked ahead of extraction:
      //  1. A refusal is the model declining outright. It is a real answer
      //     about the request (e.g. "JSON Mode couldn't be met" for a
      //     complex schema), and retrying the identical prompt is unlikely
      //     to change that — so it is reported even if a refusal message
      //     somehow ALSO carried usable text.
      //  2. A `finish_reason: 'length'` means the model hit `maxTokens`
      //     before finishing. Every answer this project asks for must
      //     `JSON.parse`, so a body cut off mid-JSON is effectively never
      //     valid JSON by accident — this is reported even when `response`
      //     or `choices[0].message.content` happens to extract a string,
      //     because returning `{ ok: true }` with truncated JSON is exactly
      //     the illegible failure #15 was about (it would pass this
      //     function only to blow up in validate.ts with no hint why).
      // Neither case is in the five recorded fixtures (all captured
      // `refusal: null`, `finish_reason: "stop"`) — both are reachable only
      // by construction in tests.
      const message = firstChoiceMessage(result);
      const refusal = message?.refusal;
      if (refusal !== null && refusal !== undefined) {
        const detail = typeof refusal === 'string' ? refusal : safeStringify(refusal);
        return {
          ok: false,
          error: `workers-ai refused the request: ${capLength(detail, 300)}`,
          rawResponse: rawMessageContent(result),
        };
      }

      const finishReason = firstChoice(result)?.finish_reason;
      if (finishReason === 'length') {
        return {
          ok: false,
          error:
            'workers-ai truncated the response at max_tokens (finish_reason: "length") - answer likely cut off mid-JSON',
          // The partial body is exactly what a truncation investigation
          // needs and, before this, is exactly what vanished from the audit
          // trail: `ai_calls.raw_response` was only ever written on the `ok`
          // branch, so a truncated call - now correctly a *failed* one per
          // issue #28 - left no trace of what the model actually produced
          // (issue #27, task 6). `message.content` is the raw, unparsed
          // string Workers AI sent back regardless of whether it happens to
          // be valid JSON, which is the right thing to keep here (the
          // `response` field's parse-or-fail convenience is not).
          rawResponse: rawMessageContent(result),
        };
      }

      const text = extractResponseText(result);
      if (text === null) {
        return { ok: false, error: 'workers-ai returned no parsable response text' };
      }
      return { ok: true, text, usage: extractUsage(result) };
    } catch (err) {
      // JSON mode can refuse a complex schema outright ("JSON Mode couldn't
      // be met"), or the binding can throw for other reasons (rate limit,
      // context exceeded, transient error). Either way this is a failed
      // call, not a crash - the caller (decide.ts) treats it as one more
      // reason to retry or fall back.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Pulls the model's answer out of the Workers AI response envelope.
 *
 * The original implementation accepted only a string, so in JSON mode — the
 * only mode this agent uses — every call was discarded as unparsable *after*
 * the Neurons had been spent. It cost ~530 Neurons and two fallback decisions
 * before the audit trail made it visible (d2a959c fixed it by also accepting
 * an object `response`).
 *
 * That fix's own doc comment then stated the wrong reason. It claimed the
 * shape depends on the MODE: string in plain text, object in JSON mode. Five
 * real Workers AI responses were captured to check that claim (see
 * test/fixtures/workers-ai/, `_captured.method` for how) and it is false.
 * `test/fixtures/workers-ai/plain-text-json-content.json` has NO
 * `response_format` at all — plain text mode — yet the model's answer
 * happened to be JSON and `response` came back as a parsed **object**, same
 * as the three json_schema captures
 * (json-schema-squad.json/json-schema-lineup.json/json-schema-transfer.json).
 * `response` was a string in exactly one capture,
 * `plain-text-prose.json`, where the answer was prose that does not parse as
 * JSON. The real rule, per these captures: **the runtime parses `response`
 * whenever the answer text parses as JSON, independent of which mode was
 * requested.** Mode correlates with the outcome (JSON mode all but forces a
 * JSON answer) but does not cause it.
 *
 * The implementation below already handled both recorded shapes correctly —
 * that part of the correction was to the explanation, not the code. Callers
 * want text they can `JSON.parse`, so an object response is re-serialised
 * rather than returned as-is.
 *
 * Issue #28 added the part that follows: `response` is the runtime's
 * convenience field, layered on top of the actual answer, which every one of
 * the five captures also carries verbatim at `choices[0].message.content` (a
 * raw string, whether or not it happens to parse as JSON). Nothing in the
 * five captures ever needed it — `response` was populated in all five — but
 * a `null` here becomes `workers-ai returned no parsable response text` in
 * `complete()`, which issue #15 already proved is indistinguishable from a
 * real model failure: the call gets retried, then the decision silently
 * degrades to `deterministic-fallback`, after the Neurons are spent. If
 * Workers AI ever stops populating `response` — or populates it with
 * something this function doesn't recognise — falling back to
 * `choices[0].message.content` turns that into a non-event instead. Preferred
 * order is unchanged: `response` first (it is already the parsed, convenient
 * shape), `choices[0].message.content` only when `response` is absent, an
 * empty string, or neither a string nor an object.
 *
 * `choices` is otherwise-untrusted shape from an external service, so every
 * step here is defensive — missing `choices`, an empty or non-array
 * `choices`, a missing `message`, or a non-string `content` all fall through
 * to `null` rather than throwing. This function never throws.
 *
 * Two other fields on `choices[0]` matter but are NOT this function's job:
 * `message.refusal` (non-null in a real refusal — a model declining the
 * request outright, e.g. "JSON Mode couldn't be met" — a genuine answer
 * about the request, not a parsing failure) and `finish_reason` (`'length'`
 * means the answer was truncated at `max_tokens`, per the header comment on
 * this file, likely mid-JSON). Both are `null` / `"stop"` in all five
 * captures. `WorkersAiProvider.complete()` checks them directly, ahead of
 * calling this function, and reports each as its own `error` string rather
 * than letting a truncated answer either extract successfully here (a
 * partial-JSON `text` that would then fail validation with no clue why) or
 * fall into the generic no-parsable-text message.
 */
function extractResponseText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const response = (result as Record<string, unknown>).response;

  if (typeof response === 'string') {
    if (response.length > 0) return response;
  } else if (response && typeof response === 'object') {
    // JSON mode: already-parsed object (or array) straight from the runtime.
    try {
      return JSON.stringify(response);
    } catch {
      // Fall through to the choices[0].message.content fallback below.
    }
  }

  const content = firstChoiceMessage(result)?.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/** Defensively pulls `choices[0]` out of a Workers AI envelope. `choices` may
 * be absent, empty, or not an array on a malformed/unexpected envelope —
 * returns `null` rather than throwing for any of those. Shared by
 * `extractResponseText` (for `message.content`) and `complete()` (for
 * `message.refusal` and `finish_reason`), so both read the same shape the
 * same defensive way. */
function firstChoice(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const choices = (result as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
}

/** Defensively pulls `choices[0].message` out of a Workers AI envelope;
 * `null` if `choices[0]` is missing or `message` isn't an object. */
function firstChoiceMessage(result: unknown): Record<string, unknown> | null {
  const message = firstChoice(result)?.message;
  return message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
}

/** Raw `choices[0].message.content` string, for the failure branches that
 * want to keep the model's actual output alongside the `error` -- a refusal
 * or a truncation is a genuine answer about the request, not proof there was
 * nothing worth logging. Deliberately NOT `extractResponseText`: that
 * function also tries the parsed `response` field and can return `null` for
 * inputs this one still has real content for (e.g. a truncated, not-quite-
 * valid-JSON body). `undefined` (not `null`) so callers can spread it into
 * an object literal and have it vanish rather than serialise as a null. */
function rawMessageContent(result: unknown): string | undefined {
  const content = firstChoiceMessage(result)?.content;
  return typeof content === 'string' && content.length > 0 ? content : undefined;
}

/**
 * Extracts the metered `usage` block from a Workers AI envelope, per the
 * three real fields `estimateNeurons` needs (see `LlmUsage`). `usage` is
 * otherwise-untrusted shape from an external service, same as `choices`
 * above, so this is defensive the same way: if `prompt_tokens`,
 * `completion_tokens`, or `neurons` is missing or not a finite number, the
 * WHOLE block is omitted rather than shipping a partial/guessed figure that
 * would silently corrupt `estimateNeurons`'s arithmetic downstream. All five
 * captures in test/fixtures/workers-ai/ carry a complete, well-typed
 * `usage`, so this should never actually fire in production -- it exists so
 * a future envelope shape change degrades to "no metered figure" (falls back
 * to the pre-call estimate, per decide.ts) rather than to a wrong one.
 * `prompt_tokens_details.cached_tokens` is read separately and does not gate
 * this -- see `LlmUsage.cachedTokens`.
 */
function extractUsage(result: unknown): LlmUsage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const usage = (result as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const promptTokens = u.prompt_tokens;
  const completionTokens = u.completion_tokens;
  const neurons = u.neurons;
  if (
    typeof promptTokens !== 'number' ||
    !Number.isFinite(promptTokens) ||
    typeof completionTokens !== 'number' ||
    !Number.isFinite(completionTokens) ||
    typeof neurons !== 'number' ||
    !Number.isFinite(neurons)
  ) {
    return undefined;
  }
  const usageOut: LlmUsage = { promptTokens, completionTokens, neurons };
  const details = u.prompt_tokens_details;
  if (details && typeof details === 'object') {
    const cachedTokens = (details as Record<string, unknown>).cached_tokens;
    if (typeof cachedTokens === 'number' && Number.isFinite(cachedTokens)) {
      usageOut.cachedTokens = cachedTokens;
    }
  }
  return usageOut;
}

/** Caps a string at `max` characters for embedding in an `error` string, so
 * an unexpectedly long refusal message can't blow up the `ai_calls` audit
 * row. */
function capLength(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Stringifies a non-string `refusal` value defensively — Workers AI's
 * documented shape is a string, but this project doesn't control the
 * envelope, and `error` must never throw building its own message. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Deterministic provider for tests. Never touches `env.AI`, so no test run
 * ever spends real Neurons. Queues responses to return in call order; once
 * only one response remains it is returned for every subsequent call, which
 * is convenient for retry-loop tests that don't want to hand-count exactly
 * how many times the model gets asked.
 */
export class StubProvider implements LlmProvider {
  private readonly queue: LlmCompleteResult[];
  readonly calls: LlmCompleteRequest[] = [];

  constructor(responses: LlmCompleteResult | LlmCompleteResult[]) {
    this.queue = Array.isArray(responses) ? [...responses] : [responses];
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    this.calls.push(request);
    if (this.queue.length === 0) {
      throw new Error('StubProvider: no response queued for this call');
    }
    return this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
  }
}

/**
 * Selects a provider from Env. Only 'workers-ai' is implemented today. A
 * future 'anthropic' provider (calling the Claude API directly rather than
 * through the Workers AI binding) can be added as another branch here
 * without any caller changing - decide.ts depends only on `LlmProvider`.
 */
export function selectProvider(env: LlmEnv): LlmProvider {
  const providerName = env.LLM_PROVIDER ?? 'workers-ai';
  if (providerName === 'workers-ai') {
    return new WorkersAiProvider(env.AI, env.LLM_MODEL);
  }
  throw new Error(`Unknown LLM_PROVIDER: "${providerName}"`);
}

/** Test-only export of the envelope parser; see test/provider.test.ts. */
export const extractResponseTextForTest = extractResponseText;
