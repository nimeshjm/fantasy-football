import type { AiCallLog, AiShim } from './types';

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';

export interface RestAiOptions {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

interface CloudflareRestEnvelope {
  result?: unknown;
  success?: boolean;
  errors?: unknown;
}

export class RestAi implements AiShim {
  readonly mode = 'live' as const;
  readonly calls: AiCallLog[] = [];

  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: RestAiOptions) {
    this.accountId = opts.accountId;
    this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  async run(
    model: string,
    input: Record<string, unknown>,
    _options?: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/accounts/${this.accountId}/ai/run/${model}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        },
      );

      const bodyText = await res.text();
      let body: CloudflareRestEnvelope | undefined;
      try {
        body = JSON.parse(bodyText) as CloudflareRestEnvelope;
      } catch {
        body = undefined;
      }

      if (!res.ok) {
        const detail = body?.errors !== undefined ? ` errors: ${safeStringify(body.errors)}` : '';
        throw new Error(`Cloudflare AI REST call failed with HTTP ${res.status}.${detail}`);
      }
      if (body?.success === false) {
        throw new Error(
          `Cloudflare AI REST call reported success: false, errors: ${safeStringify(body.errors)}`,
        );
      }

      const envelope = body?.result;
      assertBindingShape(envelope);
      this.calls.push({ model, input, envelope });
      return envelope;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.calls.push({ model, input, error });
      throw err;
    }
  }
}

export function restAiFromEnv(env: NodeJS.ProcessEnv = process.env): RestAi {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const missing = [
    !accountId ? 'CLOUDFLARE_ACCOUNT_ID' : undefined,
    !apiToken ? 'CLOUDFLARE_API_TOKEN' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
  return new RestAi({ accountId: accountId as string, apiToken: apiToken as string });
}

const REQUIRED_BINDING_KEYS = ['choices', 'model', 'response', 'usage'] as const;

// The REST endpoint's `result` is assumed to match the `Ai` binding's return shape;
// that equivalence is unverified against a live REST call, checked only against the
// five recorded envelopes in test/fixtures/workers-ai/.
export function assertBindingShape(result: unknown): void {
  if (result === null || typeof result !== 'object') {
    throw new Error(
      `Cloudflare REST unwrap no longer matches the recorded binding envelopes: ` +
        `expected an object with keys ${REQUIRED_BINDING_KEYS.join(', ')}, got ${
          result === null ? 'null' : typeof result
        }`,
    );
  }
  const present = Object.keys(result as Record<string, unknown>);
  const missing = REQUIRED_BINDING_KEYS.filter((key) => !present.includes(key));
  if (missing.length > 0) {
    throw new Error(
      `Cloudflare REST unwrap no longer matches the recorded binding envelopes: ` +
        `missing key(s) ${missing.join(', ')}; keys present: ${present.join(', ') || '(none)'}`,
    );
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
