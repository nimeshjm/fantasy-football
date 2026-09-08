import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AiCallLog, AiShim } from './types';

function sortForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForHash);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortForHash(source[key]);
    return out;
  }
  return value;
}

/** Recursively sorts object keys so the same logical request hashes the same
 * regardless of build order. Array order is left intact - it's meaningful
 * (`messages`, `picks`). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForHash(value));
}

export function cassetteKey(model: string, input: Record<string, unknown>): string {
  const hash = createHash('sha256').update(canonicalJson({ model, input })).digest('hex');
  return hash.slice(0, 16);
}

export class CassetteMissError extends Error {
  constructor(key: string, model: string, dir: string, cassetteCount: number) {
    super(
      `No cassette for key ${key} (model ${model}) in ${dir} (${cassetteCount} cassette${cassetteCount === 1 ? '' : 's'} present). ` +
        `A prompt or input change invalidates recorded cassettes - re-record with EVAL_LIVE=1 npm run eval.`,
    );
    this.name = 'CassetteMissError';
  }
}

interface CassetteFile {
  request?: Record<string, unknown>;
  envelope?: unknown;
  error?: string;
}

export class ReplayAi implements AiShim {
  readonly mode = 'replay' as const;
  readonly calls: AiCallLog[] = [];
  private cassettes?: Map<string, CassetteFile>;

  constructor(private readonly dir: string) {}

  private load(): Map<string, CassetteFile> {
    if (this.cassettes) return this.cassettes;
    const cassettes = new Map<string, CassetteFile>();
    if (existsSync(this.dir)) {
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith('.json')) continue;
        const key = file.slice(0, -'.json'.length);
        cassettes.set(
          key,
          JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as CassetteFile,
        );
      }
    }
    this.cassettes = cassettes;
    return cassettes;
  }

  async run(
    model: string,
    input: Record<string, unknown>,
    _options?: Record<string, unknown>,
  ): Promise<unknown> {
    const key = cassetteKey(model, input);
    const cassettes = this.load();
    const cassette = cassettes.get(key);
    if (!cassette) {
      throw new CassetteMissError(key, model, this.dir, cassettes.size);
    }
    if (typeof cassette.error === 'string') {
      this.calls.push({ model, input, error: cassette.error });
      throw new Error(cassette.error);
    }
    const envelope = structuredClone(cassette.envelope);
    this.calls.push({ model, input, envelope });
    return envelope;
  }
}

export function writeCassette(
  dir: string,
  model: string,
  input: Record<string, unknown>,
  envelope: unknown,
  meta?: Record<string, unknown>,
): string {
  const key = cassetteKey(model, input);
  mkdirSync(dir, { recursive: true });
  const body = {
    _captured: { capturedAt: new Date().toISOString(), requestedModel: model, ...meta },
    request: input,
    envelope,
  };
  writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(body, null, 2) + '\n', 'utf8');
  return key;
}

/** A provider failure is a real observation about a request — a refusal, a
 * truncation, a 5xx — so the live lane records it as its own cassette and
 * `ReplayAi.run` rethrows it. Without this, replay could only ever reproduce
 * the calls that succeeded. */
export function writeErrorCassette(
  dir: string,
  model: string,
  input: Record<string, unknown>,
  error: string,
  meta?: Record<string, unknown>,
): string {
  const key = cassetteKey(model, input);
  mkdirSync(dir, { recursive: true });
  const body = {
    _captured: { capturedAt: new Date().toISOString(), requestedModel: model, ...meta },
    request: input,
    error,
  };
  writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(body, null, 2) + '\n', 'utf8');
  return key;
}

export function listCassetteKeys(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}
