/**
 * Tests for src/shortlist.ts -- the ORDERING requirement in particular:
 * seeding the shortlist with `buildSquad`'s deterministic optimum BEFORE the
 * value-per-cost fill is what guarantees a legal 15 exists inside it.
 */
import { describe, expect, it } from 'vitest';

import { buildShortlist, ShortlistInvariantError } from '../src/shortlist';
import { shortlistContainsLegalSquad } from '../src/ai/validate';
import { Position, RULES, type Element, type Projection } from '../src/types';

let nextElementId = 1;
function makeElement(overrides: Partial<Element> = {}): Element {
  const id = overrides.id ?? nextElementId++;
  return {
    id,
    code: id,
    web_name: `Player${id}`,
    first_name: 'First',
    second_name: 'Last',
    team: 1,
    element_type: Position.MID,
    now_cost: 50,
    status: 'a',
    news: '',
    news_added: null,
    chance_of_playing_this_round: null,
    chance_of_playing_next_round: null,
    total_points: 0,
    event_points: 0,
    points_per_game: '0.0',
    form: '0.0',
    ep_next: null,
    ep_this: null,
    selected_by_percent: '0.0',
    minutes: 0,
    removed: false,
    can_select: true,
    can_transact: true,
    ...overrides,
  };
}

function projectionFor(
  elements: readonly Element[],
  event: number,
  xptsById: Map<number, number>,
): Projection[] {
  return elements.map((e) => ({
    element_id: e.id,
    event,
    xmins: 90,
    xpts: xptsById.get(e.id) ?? 1,
  }));
}

describe('buildShortlist', () => {
  it('adversarial pool: value-per-cost-only ranking would concentrate one position on a single club, but buildShortlist still guarantees a legal squad', () => {
    nextElementId = 1;
    const elements: Element[] = [];
    const xpts = new Map<number, number>();

    // Club 1 (team=1): extremely cheap, high-scoring DEFENDERS ONLY --
    // exactly what a pure value-per-cost ranking would rank first for that
    // position. There are enough of them to fill a "top 12 by value/cost"
    // shortlist on their own, but only RULES.teamLimit (3) of them can ever
    // appear in a legal squad. Deliberately confined to one position (real
    // squads spread a dominant club's value across a couple of positions,
    // not literally every position) so this exercises the ordering
    // requirement without also tripping `shortlistContainsLegalSquad`'s own
    // documented greedy-heuristic false-negative case (see its doc comment)
    // via cross-position club-cap interactions that have nothing to do with
    // what this test is checking.
    for (let i = 0; i < 12; i++) {
      const el = makeElement({ element_type: Position.DEF, team: 1, now_cost: 40 });
      elements.push(el);
      xpts.set(el.id, 10); // very high score, very low cost -> top value/cost
    }

    // A legal, diverse alternative pool of defenders across many other
    // clubs, at a worse (but still positive) value/cost ratio -- so a pure
    // top-12-by-value/cost DEF shortlist never reaches far enough down the
    // list to include a second club.
    let team = 2;
    for (let i = 0; i < 8; i++) {
      const el = makeElement({
        element_type: Position.DEF,
        team: ((team++ - 2) % 17) + 2,
        now_cost: 55,
      });
      elements.push(el);
      xpts.set(el.id, 5);
    }

    // Normal, diverse pools for every other position -- deliberately never
    // club 1, so team 1's club-cap usage (spent entirely on DEF) cannot
    // interact with GK/MID/FWD selection at all.
    let otherTeam = 2;
    const perPosition: Record<number, number> = {
      [Position.GK]: 4,
      [Position.MID]: 10,
      [Position.FWD]: 8,
    };
    for (const pos of [Position.GK, Position.MID, Position.FWD]) {
      for (let i = 0; i < perPosition[pos]!; i++) {
        const el = makeElement({
          element_type: pos,
          team: ((otherTeam++ - 2) % 17) + 2,
          now_cost: 45 + i,
        });
        elements.push(el);
        xpts.set(el.id, 3);
      }
    }

    const projections = projectionFor(elements, 1, xpts);

    // Sanity check the adversarial setup: a shortlist built from ONLY the
    // top-12-by-value/cost DEF ranking (no buildSquad seed) must NOT
    // provably contain a legal squad -- otherwise this test wouldn't be
    // exercising the ordering requirement at all.
    const defOnly = elements.filter((e) => e.element_type === Position.DEF);
    const rankedDef = [...defOnly].sort(
      (a, b) => xpts.get(b.id)! / b.now_cost - xpts.get(a.id)! / a.now_cost,
    );
    const valueOnlyDef = rankedDef.slice(0, 12);
    const valueOnlyShortlist = [
      ...valueOnlyDef,
      ...elements.filter((e) => e.element_type !== Position.DEF),
    ];
    expect(shortlistContainsLegalSquad(valueOnlyShortlist, elements)).toBe(false);

    // The real function, WITH the buildSquad seed, must succeed.
    const { shortlist, deterministicSquad } = buildShortlist(elements, projections, new Set());
    expect(deterministicSquad.feasible).toBe(true);
    expect(shortlistContainsLegalSquad(shortlist, elements)).toBe(true);

    // And the seed's own 15 picks must actually be present in the shortlist.
    const shortlistIds = new Set(shortlist.map((e) => e.id));
    for (const pick of deterministicSquad.picks) {
      expect(shortlistIds.has(pick.element)).toBe(true);
    }
  });

  it('includes every currently-owned player and every player with news, even outside the top-N fill', () => {
    nextElementId = 1;
    const elements: Element[] = [];
    const xpts = new Map<number, number>();
    let team = 1;
    const perPosition: Record<Position, number> = {
      [Position.GK]: 4,
      [Position.DEF]: 10,
      [Position.MID]: 10,
      [Position.FWD]: 8,
    };
    for (const pos of [Position.GK, Position.DEF, Position.MID, Position.FWD]) {
      for (let i = 0; i < perPosition[pos]; i++) {
        const el = makeElement({
          element_type: pos,
          team: ((team++ - 1) % 18) + 1,
          now_cost: 45 + i,
        });
        elements.push(el);
        xpts.set(el.id, 1); // uniformly low/uninteresting score
      }
    }

    // A deliberately worthless, expensive, newsworthy player who would
    // never make the top-12-per-position cut.
    const injured = makeElement({
      element_type: Position.MID,
      team: 18,
      now_cost: 200,
      news: 'Lesão muscular, fora 3 semanas',
    });
    elements.push(injured);
    xpts.set(injured.id, 0);

    // A deliberately worthless, expensive, currently-owned player.
    const owned = makeElement({ element_type: Position.FWD, team: 18, now_cost: 200 });
    elements.push(owned);
    xpts.set(owned.id, 0);

    const projections = projectionFor(elements, 1, xpts);
    const { shortlist } = buildShortlist(elements, projections, new Set([owned.id]));
    const shortlistIds = new Set(shortlist.map((e) => e.id));

    expect(shortlistIds.has(injured.id)).toBe(true);
    expect(shortlistIds.has(owned.id)).toBe(true);
  });

  it('throws ShortlistInvariantError when the full pool cannot form any legal squad', () => {
    nextElementId = 1;
    // Only goalkeepers and midfielders -- RULES.squadSelect requires DEF and
    // FWD too, so no legal 15 can ever exist.
    const elements: Element[] = [];
    const xpts = new Map<number, number>();
    for (let i = 0; i < 3; i++) {
      const el = makeElement({ element_type: Position.GK, team: i + 1, now_cost: 45 });
      elements.push(el);
      xpts.set(el.id, 3);
    }
    for (let i = 0; i < 6; i++) {
      const el = makeElement({ element_type: Position.MID, team: i + 1, now_cost: 50 });
      elements.push(el);
      xpts.set(el.id, 3);
    }
    const projections = projectionFor(elements, 1, xpts);

    expect(() => buildShortlist(elements, projections, new Set())).toThrow(ShortlistInvariantError);
  });

  it('RULES sanity: squadSelect requires more than GK+MID alone (guards the invariant test above)', () => {
    expect(RULES.squadSelect[Position.DEF]).toBeGreaterThan(0);
    expect(RULES.squadSelect[Position.FWD]).toBeGreaterThan(0);
  });
});
