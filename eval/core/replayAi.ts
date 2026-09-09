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
  constructor(key: string, occurrence: number, model: string, dir: string, cassetteCount: number) {
    const which =
      occurrence === 0
        ? `No cassette for key ${key}`
        : `No cassette for call ${occurrence + 1} of key ${key} (${occurrence} recorded)`;
    super(
      `${which} (model ${model}) in ${dir} (${cassetteCount} cassette${cassetteCount === 1 ? '' : 's'} present). ` +
        `A prompt or input change invalidates recorded cassettes - re-record with EVAL_LIVE=1 npm run eval.`,
    );
    this.name = 'CassetteMissError';
  }
}

/**
 * One decision can send the SAME prompt twice: decideSquad appends the
 * previous answer's violations to the retry prompt, so two attempts that
 * broke identical rules get byte-identical prompts. The model is free to
 * answer them differently, and it does. Keying on (model, input) alone
 * therefore collapsed both calls onto one file, the second write clobbered
 * the first, and replay could no longer reproduce the chain - a real
 * squad-gw4 recording died exactly this way. So repeated calls get an
 * occurrence suffix and are served in recording order. Occurrence 0 keeps
 * the bare `<key>.json` name, which is what every cassette recorded before
 * this already is.
 */
function cassetteFileName(key: string, occurrence: number): string {
  return occurrence === 0 ? `${key}.json` : `${key}-${occurrence}.json`;
}

const CASSETTE_FILE = /^([0-9a-f]{16})(?:-(\d+))?\.json$/;

interface CassetteFile {
  request?: Record<string, unknown>;
  envelope?: unknown;
  error?: string;
}

export class ReplayAi implements AiShim {
  readonly mode = 'replay' as const;
  readonly calls: AiCallLog[] = [];
  private cassettes?: Map<string, CassetteFile[]>;
  private readonly served = new Map<string, number>();

  constructor(private readonly dir: string) {}

  private load(): Map<string, CassetteFile[]> {
    if (this.cassettes) return this.cassettes;
    const cassettes = new Map<string, CassetteFile[]>();
    if (existsSync(this.dir)) {
      for (const file of readdirSync(this.dir)) {
        const match = CASSETTE_FILE.exec(file);
        if (!match) continue;
        const key = match[1]!;
        const occurrence = match[2] === undefined ? 0 : Number(match[2]);
        const list = cassettes.get(key) ?? [];
        list[occurrence] = JSON.parse(
          readFileSync(path.join(this.dir, file), 'utf8'),
        ) as CassetteFile;
        cassettes.set(key, list);
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
    const occurrence = this.served.get(key) ?? 0;
    this.served.set(key, occurrence + 1);
    const cassette = cassettes.get(key)?.[occurrence];
    if (!cassette) {
      throw new CassetteMissError(
        key,
        occurrence,
        model,
        this.dir,
        [...cassettes.values()].reduce((n, list) => n + list.filter(Boolean).length, 0),
      );
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
  occurrence = 0,
): string {
  const key = cassetteKey(model, input);
  mkdirSync(dir, { recursive: true });
  const body = {
    _captured: { capturedAt: new Date().toISOString(), requestedModel: model, ...meta },
    request: input,
    envelope,
  };
  writeFileSync(
    path.join(dir, cassetteFileName(key, occurrence)),
    JSON.stringify(body, null, 2) + '\n',
    'utf8',
  );
  return key;
}

/** Records a whole run's calls, counting repeats per key so `ReplayAi` can
 * serve them back in the order they happened. The only correct way to write
 * cassettes for a run: writing them one by one loses the ordinal. */
export function writeRunCassettes(
  dir: string,
  calls: readonly AiCallLog[],
  meta?: Record<string, unknown>,
): void {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = cassetteKey(call.model, call.input);
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    if (call.error !== undefined) {
      writeErrorCassette(dir, call.model, call.input, call.error, meta, occurrence);
    } else {
      writeCassette(dir, call.model, call.input, call.envelope, meta, occurrence);
    }
  }
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
  occurrence = 0,
): string {
  const key = cassetteKey(model, input);
  mkdirSync(dir, { recursive: true });
  const body = {
    _captured: { capturedAt: new Date().toISOString(), requestedModel: model, ...meta },
    request: input,
    error,
  };
  writeFileSync(
    path.join(dir, cassetteFileName(key, occurrence)),
    JSON.stringify(body, null, 2) + '\n',
    'utf8',
  );
  return key;
}

/** Distinct cassette keys, ignoring occurrence suffixes. */
export function listCassetteKeys(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const keys = new Set<string>();
  for (const file of readdirSync(dir)) {
    const match = CASSETTE_FILE.exec(file);
    if (match) keys.add(match[1]!);
  }
  return [...keys];
}
