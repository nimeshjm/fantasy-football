/**
 * Test-only stand-in for the `Ai` binding (`env.AI`), one layer lower than
 * `StubProvider` in src/ai/provider.ts.
 *
 * Why a second stub rather than reusing `StubProvider` (issue #15): `StubProvider`
 * implements `LlmProvider` and returns `{ ok, text }` -- the shape *after*
 * `WorkersAiProvider.complete()` has already parsed the Workers AI envelope.
 * The bug that mattered (d2a959c, see the doc comment on `extractResponseText`
 * in src/ai/provider.ts) lived entirely in that parsing step, which
 * `StubProvider`-based tests skip by construction: the mock encoded the same
 * wrong assumption about the envelope shape as the code it was testing, so
 * the two could only ever agree with each other. `StubAi` stubs `env.AI.run`
 * itself, one layer lower, so a test built on it exercises
 * `WorkersAiProvider.complete()`'s real parsing against a queued envelope --
 * typically one of the recorded fixtures in test/fixtures/workers-ai/ (see
 * that directory's README.md for how they were captured).
 *
 * `StubProvider` itself is left exactly as it is: it is used across
 * test/workflows.test.ts, test/gateAudit.test.ts and test/validate.test.ts,
 * all of which test `decide.ts`'s retry/gate/repair orchestration and
 * correctly do not care how an `LlmProvider` gets its text. Rewriting it to
 * stub at the envelope layer would churn that whole suite for no benefit --
 * this file adds a second, lower-level double instead of replacing the
 * higher-level one.
 *
 * Mirrors `StubProvider`'s "queue responses, last one repeats" convenience
 * and its call recording, for the same reason: retry-loop tests that don't
 * want to hand-count exactly how many times `env.AI.run` gets called. A
 * queued `Error` is thrown instead of returned, so the `catch` branch of
 * `WorkersAiProvider.complete()` is reachable from a test without needing a
 * real binding failure.
 *
 * `Ai` (from `@cloudflare/workers-types`) is an abstract class with a large,
 * overloaded surface (`gateway`, `aiSearch`, `autorag`, plus separate `run`
 * overloads for batch/raw-response/websocket/streaming modes) that
 * `WorkersAiProvider` never touches -- it only ever calls the plain
 * `run(model, input, options)` overload. `StubAi` implements only that, and
 * callers cast `as unknown as Ai` at the point they hand it to
 * `WorkersAiProvider`. That is the same house pattern as `fakeConfigD1` in
 * test/loginProbe.test.ts (mirroring `fakeConfigOnlyD1` in
 * test/workflows.test.ts): fake the surface actually used, never the whole
 * binding.
 */

/** One recorded call: the model id and input `WorkersAiProvider.complete()`
 * handed to `env.AI.run`, plus the options bag (always `{}` today, but
 * recorded rather than assumed). */
export interface StubAiCall {
  model: string;
  input: Record<string, unknown>;
  options: Record<string, unknown>;
}

export class StubAi {
  private readonly queue: Array<unknown | Error>;
  readonly calls: StubAiCall[] = [];

  constructor(responses: unknown | Error | Array<unknown | Error>) {
    this.queue = Array.isArray(responses) ? [...responses] : [responses];
  }

  async run(
    model: string,
    input: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.calls.push({ model, input, options });
    if (this.queue.length === 0) {
      throw new Error('StubAi: no response queued for this call');
    }
    const next = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]!;
    if (next instanceof Error) throw next;
    return next;
  }
}
