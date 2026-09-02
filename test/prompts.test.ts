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
  it('estimates roughly chars/4', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('does not throw when a prompt fits', () => {
    expect(() => assertPromptFits('short prompt', 1000)).not.toThrow();
  });

  it('throws when a prompt would exceed the budget', () => {
    expect(() => assertPromptFits('x'.repeat(4001), 1000)).toThrow();
  });
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
    // a small fraction of the whole window, not just barely under it.
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
