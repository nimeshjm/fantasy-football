/**
 * The prompt-drift lane.
 *
 * The replay lane cannot catch a prompt regression: `cassetteKey` hashes the
 * whole request, prompt included, so editing a prompt makes every cassette
 * miss and the lane reports "no cassette", not a regression. These snapshots
 * are what actually notices. A deliberate prompt change means updating them
 * (`vitest -u`) and then re-recording cassettes with a live run.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLineupPrompt, buildSquadPrompt, buildTransferPrompt } from '../src/ai/prompts';
import { fantasyCases } from '../eval/suites/fantasy/dataset';
import { adversarialLineupCases } from '../eval/suites/fantasy/adversarial';

const SNAP_DIR = path.join(import.meta.dirname, '../eval/prompts');

function snapshotPath(id: string): string {
  return path.join(SNAP_DIR, `${id}.snap.txt`);
}

function render(id: string, prompt: { system: string; user: string }): string {
  return `### case: ${id}\n### system\n${prompt.system}\n### user\n${prompt.user}\n`;
}

const cases = fantasyCases();

const rendered: [string, string][] = [
  ...cases.squad.map(
    (c) => [c.id, render(c.id, buildSquadPrompt(c.input.shortlist))] as [string, string],
  ),
  ...cases.lineup.map(
    (c) => [c.id, render(c.id, buildLineupPrompt(c.input.owned))] as [string, string],
  ),
  ...cases.transfer.map(
    (c) =>
      [
        c.id,
        render(c.id, buildTransferPrompt(c.input.squad, c.input.candidates, c.input.bankTenths)),
      ] as [string, string],
  ),
  ...adversarialLineupCases().map(
    (c) => [c.id, render(c.id, buildLineupPrompt(c.input.owned))] as [string, string],
  ),
];

describe('eval prompt snapshots', () => {
  it('covers every case in the suite', () => {
    expect(rendered.length).toBe(
      cases.squad.length +
        cases.lineup.length +
        cases.transfer.length +
        adversarialLineupCases().length,
    );
    expect(new Set(rendered.map(([id]) => id)).size).toBe(rendered.length);
  });

  for (const [id, text] of rendered) {
    it(`${id} prompt is unchanged`, async () => {
      await expect(text).toMatchFileSnapshot(snapshotPath(id));
    });
  }

  it('keeps Portuguese news text verbatim in the adversarial cases', () => {
    const injured = adversarialLineupCases().find((c) => c.id === 'injured-star');
    expect(injured).toBeDefined();
    const news = injured!.input.owned.map((o) => o.element.news).filter((n) => n.length > 0);
    expect(news.length).toBeGreaterThan(0);
    const prompt = buildLineupPrompt(injured!.input.owned);
    for (const n of news) expect(prompt.user).toContain(n);
  });

  it('a one-character prompt edit changes the rendered text', () => {
    const first = cases.lineup[0];
    expect(first).toBeDefined();
    const base = buildLineupPrompt(first!.input.owned);
    const tampered = { ...base, system: base.system + '.' };
    expect(render(first!.id, tampered)).not.toBe(render(first!.id, base));
  });
});
