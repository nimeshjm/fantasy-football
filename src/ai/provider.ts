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

export type LlmCompleteResult = { ok: true; text: string } | { ok: false; error: string };

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
      const text = extractResponseText(result);
      if (text === null) {
        return { ok: false, error: 'workers-ai returned no parsable response text' };
      }
      return { ok: true, text };
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
 * The implementation below already handles both recorded shapes correctly —
 * this correction is to the explanation, not the code. Callers want text
 * they can `JSON.parse`, so an object response is re-serialised rather than
 * returned as-is.
 */
function extractResponseText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const response = (result as Record<string, unknown>).response;

  if (typeof response === 'string') {
    return response.length > 0 ? response : null;
  }
  // JSON mode: already-parsed object (or array) straight from the runtime.
  if (response && typeof response === 'object') {
    try {
      return JSON.stringify(response);
    } catch {
      return null;
    }
  }
  return null;
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
