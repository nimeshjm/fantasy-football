import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ReplayAi,
  CassetteMissError,
  writeCassette,
  writeErrorCassette,
  cassetteKey,
  listCassetteKeys,
} from '../eval/core/replayAi';
import { assertBindingShape } from '../eval/core/restAi';

const FIX = path.join(import.meta.dirname, 'fixtures/workers-ai');
const cap = JSON.parse(readFileSync(path.join(FIX, 'json-schema-lineup.json'), 'utf8'));
const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const input = cap.request as Record<string, unknown>;

describe('eval AI shims', () => {
  it('replays a recorded envelope verbatim and it passes the REST shape gate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cass-'));
    writeCassette(dir, model, input, cap.envelope, { neurons: cap._captured.neurons });
    const got = await new ReplayAi(dir).run(model, input, {});
    expect(JSON.stringify(got)).toBe(JSON.stringify(cap.envelope));
    expect(() => assertBindingShape(got)).not.toThrow();
  });

  it('replays a recorded provider failure as a throw', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cass-'));
    writeErrorCassette(dir, model, input, 'workers-ai refused the request: nope');
    const r = new ReplayAi(dir);
    await expect(r.run(model, input, {})).rejects.toThrow(/refused/);
    expect(r.calls[0]?.error).toBeDefined();
  });

  it('treats a prompt edit as a miss and says a re-record is needed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cass-'));
    writeCassette(dir, model, input, cap.envelope);
    const edited = structuredClone(input) as { messages: { content: string }[] };
    edited.messages[0]!.content += ' extra';
    expect(cassetteKey(model, edited)).not.toBe(cassetteKey(model, input));
    let msg = '';
    try {
      await new ReplayAi(dir).run(model, edited as unknown as Record<string, unknown>, {});
    } catch (e) {
      expect(e).toBeInstanceOf(CassetteMissError);
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/EVAL_LIVE=1/);
    expect(listCassetteKeys(dir)).toHaveLength(1);
  });

  it('does not let a caller mutate a cassette and poison a repeat', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cass-'));
    writeCassette(dir, model, input, cap.envelope);
    const r = new ReplayAi(dir);
    const a = (await r.run(model, input, {})) as Record<string, unknown>;
    a.model = 'tampered';
    const b = (await r.run(model, input, {})) as Record<string, unknown>;
    expect(b.model).toBe(cap.envelope.model);
  });
});
