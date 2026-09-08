/**
 * Prompt-building tests: token budget and the one thing this whole LLM
 * layer exists for - the Portuguese `news` free text - must survive
 * verbatim into the prompt.
 */
import { describe, expect, it } from 'vitest';

import {
  assertPromptFits,
  buildLineupPrompt,
  buildSquadPrompt,
  buildTransferPrompt,
  estimateTokens,
  formatPlayerLine,
  type ShortlistEntry,
} from '../src/ai/prompts';
import { CONTEXT_WINDOW_TOKENS } from '../src/ai/provider';
import { Position, type Element, type Team } from '../src/types';
import bootstrapStatic from './fixtures/bootstrap-static.json';

import jsonSchemaSquad from './fixtures/workers-ai/json-schema-squad.json';
import jsonSchemaLineup from './fixtures/workers-ai/json-schema-lineup.json';
import jsonSchemaTransfer from './fixtures/workers-ai/json-schema-transfer.json';
import plainTextJsonContent from './fixtures/workers-ai/plain-text-json-content.json';
import plainTextProse from './fixtures/workers-ai/plain-text-prose.json';

interface FixtureElement {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
  now_cost: number;
  status: string;
  news: string;
  ep_next: string | null;
  total_points: number;
  minutes: number;
  chance_of_playing_next_round: number | null;
  selected_by_percent: string;
  form: string;
}

const fixtureElements = bootstrapStatic.elements as unknown as FixtureElement[];
const fixtureTeams = bootstrapStatic.teams as unknown as Team[];
const teamById = new Map(fixtureTeams.map((t) => [t.id, t]));

function toElement(raw: FixtureElement): Element {
  return {
    id: raw.id,
    code: raw.id,
    web_name: raw.web_name,
    first_name: '',
    second_name: raw.web_name,
    team: raw.team,
    element_type: raw.element_type as Position,
    now_cost: raw.now_cost,
    status: raw.status,
    news: raw.news,
    news_added: null,
    chance_of_playing_this_round: raw.chance_of_playing_next_round,
    chance_of_playing_next_round: raw.chance_of_playing_next_round,
    total_points: raw.total_points,
    event_points: 0,
    points_per_game: '0.0',
    form: raw.form,
    ep_next: raw.ep_next,
    ep_this: null,
    selected_by_percent: raw.selected_by_percent,
    minutes: raw.minutes,
    removed: false,
    can_select: true,
    can_transact: true,
  };
}

function toShortlistEntry(raw: FixtureElement): ShortlistEntry {
  const element = toElement(raw);
  const club = teamById.get(element.team);
  return {
    element,
    clubShortName: club?.short_name ?? `T${element.team}`,
    xpts: Number(element.ep_next ?? '0') || 0,
  };
}

/** A realistic ~60-player shortlist: roughly the top selectable players per
 * position, the shape a real shortlist builder would hand to buildSquadPrompt. */
function realisticShortlist(size = 60): ShortlistEntry[] {
  const wanted: Record<Position, number> = {
    [Position.GK]: Math.round(size * (2 / 15)),
    [Position.DEF]: Math.round(size * (5 / 15)),
    [Position.MID]: Math.round(size * (5 / 15)),
    [Position.FWD]: Math.round(size * (3 / 15)),
  };
  const byPosition = new Map<Position, FixtureElement[]>();
  for (const raw of fixtureElements) {
    const pos = raw.element_type as Position;
    const list = byPosition.get(pos) ?? [];
    list.push(raw);
    byPosition.set(pos, list);
  }
  const chosen: FixtureElement[] = [];
  for (const pos of [Position.GK, Position.DEF, Position.MID, Position.FWD]) {
    const list = (byPosition.get(pos) ?? []).slice(0, wanted[pos]);
    chosen.push(...list);
  }
  return chosen.map(toShortlistEntry);
}

describe('estimateTokens / assertPromptFits', () => {
  it('estimates ~chars/1.75 plus a fixed +32 per-call overhead (see the doc comment on estimateTokens)', () => {
    // ceil(400 / 1.75) + 32 = 229 + 32 = 261.
    expect(estimateTokens('a'.repeat(400))).toBe(261);
  });

  it('does not throw when a prompt fits', () => {
    expect(() => assertPromptFits('short prompt', 1000)).not.toThrow();
  });

  it('throws when a prompt would exceed the budget', () => {
    expect(() => assertPromptFits('x'.repeat(4001), 1000)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue #27: estimateTokens must never underestimate a real Workers AI
// prompt_tokens figure. Checked against all five real captures in
// test/fixtures/workers-ai/ (commit 797bc37) - none are hand-written.
// ---------------------------------------------------------------------------

/** `chars` per the calibration table in `estimateTokens`'s doc comment: the
 * sum of `request.messages[].content.length`, joined the same way
 * `assertPromptFits` sizes a real prompt (`` `${system}\n${user}` ``, i.e.
 * ONE call to `estimateTokens` over the concatenated text) rather than the
 * way `decide.ts`'s `callLlm` does it (`estimateTokens(system) +
 * estimateTokens(user)`, two calls). The two-call form is only MORE
 * conservative than this - `ceil(a/r) + ceil(b/r) >= ceil((a+b)/r)` for any
 * positive `r`, so both call sites are covered by this test asserting on
 * the tighter, single-call bound. */
const CALIBRATION_CAPTURES = [
  { name: 'json-schema-squad', fixture: jsonSchemaSquad },
  { name: 'json-schema-lineup', fixture: jsonSchemaLineup },
  { name: 'json-schema-transfer', fixture: jsonSchemaTransfer },
  { name: 'plain-text-json-content', fixture: plainTextJsonContent },
  // Deliberately kept in this set even though it produces the WIDEST margin:
  // it is the one sample where the old chars/4 ratio was already about
  // right (3.86 chars/token), so it is what would catch a future
  // recalibration that over-inflates ordinary prose along with the dense
  // tabular content this ratio is actually tuned for. Its `request` is
  // backfilled from the capture worker's source rather than recorded live
  // (see the fixture's `_captured.requestBackfilled`), but
  // `envelope.usage.prompt_tokens` - the number this test checks against -
  // is still the authoritative metered figure either way.
  { name: 'plain-text-prose', fixture: plainTextProse },
];

describe('estimateTokens: one-sided invariant against real Workers AI captures (issue #27)', () => {
  for (const { name, fixture } of CALIBRATION_CAPTURES) {
    it(`${name}: estimate >= the real metered prompt_tokens (never a tolerance band - only >=)`, () => {
      const joined = fixture.request.messages.map((m) => m.content).join('\n');
      const estimated = estimateTokens(joined);
      const real = fixture.envelope.usage.prompt_tokens;

      // ONE-SIDED. Underestimating breaks the context guard in
      // assertPromptFits; overestimating costs a rounding error in a cheap
      // pre-call Neuron reservation (input Neurons price at ~0.027 each -
      // see NEURONS_PER_1M_INPUT_TOKENS in provider.ts). There is
      // deliberately no upper-bound assertion here - see estimateTokens's
      // doc comment for the measured margins (12%-53% across these five).
      expect(estimated).toBeGreaterThanOrEqual(real);
    });
  }
});

describe('buildSquadPrompt', () => {
  it('fits a realistic ~60-player shortlist inside the 24k context window', () => {
    const shortlist = realisticShortlist(60);
    expect(shortlist.length).toBeGreaterThanOrEqual(55);

    const { system, user } = buildSquadPrompt(shortlist);
    const fullPrompt = `${system}\n${user}`;

    // Must fit with generous room left for the answer (max_tokens).
    expect(() => assertPromptFits(fullPrompt, CONTEXT_WINDOW_TOKENS - 600)).not.toThrow();
    // And comfortably so - a ~60-line shortlist at ~35 tokens/line should be
    // a small fraction of the whole window, not just barely under it. Under
    // the recalibrated estimateTokens (issue #27) this measures ~1,800
    // tokens against a ~23,400-token budget, in line with the issue's own
    // rough estimate of a realistic prompt landing around 2,000-2,500.
    expect(estimateTokens(fullPrompt)).toBeLessThan(CONTEXT_WINDOW_TOKENS / 2);
  });

  it("keeps a flagged player's Portuguese news text verbatim in the prompt", () => {
    const flagged = fixtureElements.find((e) => e.news && e.news.length > 0);
    expect(flagged).toBeDefined();

    const shortlist = realisticShortlist(60);
    // Make sure the flagged player is actually present in the shortlist sent
    // to the model, regardless of whether it happened to already be there.
    const withFlagged = [
      toShortlistEntry(flagged!),
      ...shortlist.filter((s) => s.element.id !== flagged!.id),
    ];

    const { user } = buildSquadPrompt(withFlagged);
    expect(user).toContain(flagged!.news);
  });

  it('never truncates news even when it is long', () => {
    const longNews =
      'Lesão muscular na coxa esquerda, sofrida no treino de terça-feira; ' +
      'reavaliação médica agendada para a próxima semana, ausência estimada de 3 a 4 semanas.';
    const raw = fixtureElements[0]!;
    const entry = toShortlistEntry({ ...raw, news: longNews });

    const line = formatPlayerLine(entry);
    expect(line).toContain(longNews);
  });
});

describe('buildLineupPrompt', () => {
  it('includes all 15 owned players and their news', () => {
    const owned = realisticShortlist(15);
    const flagged = fixtureElements.find((e) => e.news && e.news.length > 0)!;
    owned[0] = toShortlistEntry(flagged);

    const { user } = buildLineupPrompt(owned);
    for (const entry of owned) {
      expect(user).toContain(String(entry.element.id));
    }
    expect(user).toContain(flagged.news);
  });
});

describe('buildTransferPrompt', () => {
  it('lists candidates with ids and gain, and fits the context window', () => {
    const squad = realisticShortlist(15);
    const shortlist = realisticShortlist(60);
    const candidates = [
      { elementIn: shortlist[20]!, elementOut: squad[0]!, gain: 2.4 },
      { elementIn: shortlist[21]!, elementOut: squad[1]!, gain: 0.3 },
    ];

    const { system, user } = buildTransferPrompt(squad, candidates, 15);
    const fullPrompt = `${system}\n${user}`;

    expect(() => assertPromptFits(fullPrompt, CONTEXT_WINDOW_TOKENS - 150)).not.toThrow();
    expect(user).toContain(`element_in=${candidates[0]!.elementIn.element.id}`);
    expect(user).toContain(`element_out=${candidates[0]!.elementOut.element.id}`);
    expect(user).toContain('gain:+2.4');
  });
});

// ---------------------------------------------------------------------------
// Issue #27 raised the recalibrated estimateTokens as "an accounting defect,
// not an imminent overflow" - a fixed +32 overhead and a ~1.75 chars/token
// ratio don't scale with shortlist size the way a per-schema or per-player
// cost would. This confirms that holds against REAL prompt builders fed a
// deliberately worst-case shortlist, not just the ~60-player, mostly-
// unflagged one the tests above use.
// ---------------------------------------------------------------------------

const WORST_CASE_NEWS =
  'Lesão muscular na coxa esquerda, sofrida no treino de terça-feira; ' +
  'reavaliação médica agendada para a próxima semana, ausência estimada de 3 a 4 semanas.';

/** Every entry flagged with a long Portuguese `news` string - per the module
 * docstring in src/ai/prompts.ts, `news` is never truncated, so this is the
 * genuine worst case for prompt size, not an artificial one: a real
 * gameweek with a fully-fit squad in the shortlist has none of this; an
 * injury-crisis gameweek could plausibly have most of it. */
function worstCaseShortlist(size: number): ShortlistEntry[] {
  return realisticShortlist(size).map((entry) => ({
    ...entry,
    element: { ...entry.element, news: WORST_CASE_NEWS },
  }));
}

describe('real prompts stay well inside the context budget under a worst-case shortlist (issue #27)', () => {
  // decide.ts's DEFAULT_MAX_ANSWER_TOKENS - duplicated here as literals
  // (not imported) because this suite is about prompts.ts's own promise
  // ("the prompt fits"), independent of decide.ts's current defaults ever
  // changing.
  const MAX_ANSWER_TOKENS = { squad: 600, lineup: 500, transfer: 150 };

  it('buildSquadPrompt: a full ~80-player, fully-flagged shortlist fits with room to spare', () => {
    const shortlist = worstCaseShortlist(80);
    const { system, user } = buildSquadPrompt(shortlist);
    const fullPrompt = `${system}\n${user}`;
    const budget = CONTEXT_WINDOW_TOKENS - MAX_ANSWER_TOKENS.squad;

    expect(() => assertPromptFits(fullPrompt, budget)).not.toThrow();
    // Measured (not asserted-tight): ~9,450 tokens against a ~23,400-token
    // budget - ~60% headroom left even flagging every one of 81 shortlisted
    // players with a full injury note, an artificially pessimistic scenario
    // real gameweeks never actually hit. The recalibration in estimateTokens
    // (task 4) did not turn "an accounting defect" (the issue's own framing)
    // into an imminent overflow. See this file's other estimateTokens tests
    // for the calibration itself.
    expect(estimateTokens(fullPrompt)).toBeLessThan(budget / 2);
  });

  it('buildLineupPrompt: 15 owned players, all flagged, fits with room to spare', () => {
    const owned = worstCaseShortlist(15);
    const { system, user } = buildLineupPrompt(owned);
    const fullPrompt = `${system}\n${user}`;
    const budget = CONTEXT_WINDOW_TOKENS - MAX_ANSWER_TOKENS.lineup;

    expect(() => assertPromptFits(fullPrompt, budget)).not.toThrow();
    // Measured: ~2,190 tokens against a ~23,500-token budget.
    expect(estimateTokens(fullPrompt)).toBeLessThan(budget / 2);
  });

  it('buildTransferPrompt: full squad plus several flagged candidates fits with room to spare', () => {
    const squad = worstCaseShortlist(15);
    const pool = worstCaseShortlist(60);
    const candidates = pool.slice(0, 8).map((elementIn, i) => ({
      elementIn,
      elementOut: squad[i % squad.length]!,
      gain: 1.5,
    }));
    const { system, user } = buildTransferPrompt(squad, candidates, 15);
    const fullPrompt = `${system}\n${user}`;
    const budget = CONTEXT_WINDOW_TOKENS - MAX_ANSWER_TOKENS.transfer;

    expect(() => assertPromptFits(fullPrompt, budget)).not.toThrow();
    // Measured: ~4,270 tokens against a ~23,850-token budget.
    expect(estimateTokens(fullPrompt)).toBeLessThan(budget / 2);
  });
});
