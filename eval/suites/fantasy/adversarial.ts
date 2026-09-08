/**
 * Hand-built adversarial lineup cases: a fully synthetic, always-legal owned
 * 15 per case, each probing one specific way a model can go wrong that the
 * deterministic optimizer either can't see (free-text `news`) or resolves by
 * blind argmax (captaincy, near-tied projections). No `truth` — synthetic,
 * there is no realized outcome.
 */
import { Position, type Element, type Pick } from '../../../src/types';
import type { ShortlistEntry } from '../../../src/ai/prompts';
import type { EvalCase, LineupCaseInput } from '../../core/types';

export function makeElement(overrides: Partial<Element> & { id: number }): Element {
  return {
    code: overrides.id,
    web_name: `P${overrides.id}`,
    first_name: '',
    second_name: `P${overrides.id}`,
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
    ep_next: '0.0',
    ep_this: null,
    selected_by_percent: '0.0',
    minutes: 900,
    removed: false,
    can_select: true,
    can_transact: true,
    ...overrides,
  };
}

// A legal 15: 2 GK, 5 DEF, 5 MID, 3 FWD (RULES.squadSelect), no club above
// RULES.teamLimit (team1/2/3 each hold 3; the rest hold 1-2), total cost 755
// (<= RULES.budget). Reused, with fresh Element instances, by every case
// below so per-case xpts/status/news overrides never leak across cases.
const SQUAD_SPEC: { id: number; position: Position; team: number; cost: number }[] = [
  { id: 1, position: Position.GK, team: 1, cost: 40 },
  { id: 2, position: Position.GK, team: 2, cost: 40 },
  { id: 3, position: Position.DEF, team: 1, cost: 40 },
  { id: 4, position: Position.DEF, team: 2, cost: 40 },
  { id: 5, position: Position.DEF, team: 3, cost: 40 },
  { id: 6, position: Position.DEF, team: 4, cost: 45 },
  { id: 7, position: Position.DEF, team: 5, cost: 45 },
  { id: 8, position: Position.MID, team: 1, cost: 50 },
  { id: 9, position: Position.MID, team: 2, cost: 50 },
  { id: 10, position: Position.MID, team: 3, cost: 55 },
  { id: 11, position: Position.MID, team: 6, cost: 55 },
  { id: 12, position: Position.MID, team: 7, cost: 60 },
  { id: 13, position: Position.FWD, team: 3, cost: 60 },
  { id: 14, position: Position.FWD, team: 4, cost: 65 },
  { id: 15, position: Position.FWD, team: 8, cost: 70 },
];

/** These cases are synthetic and belong to no real gameweek; the value only
 * has to be consistent inside a case, since nothing reads it. */
const SYNTHETIC_EVENT = 0;

type ElementOverrides = Record<number, Partial<Element>>;

function buildOwned(
  xpts: Record<number, number>,
  overrides: ElementOverrides = {},
): ShortlistEntry[] {
  return SQUAD_SPEC.map((s) => ({
    element: makeElement({
      id: s.id,
      element_type: s.position,
      team: s.team,
      now_cost: s.cost,
      ...overrides[s.id],
    }),
    clubShortName: `C${s.team}`,
    xpts: xpts[s.id] ?? 0,
  }));
}

function buildCase(
  id: string,
  probe: string,
  xpts: Record<number, number>,
  overrides: ElementOverrides = {},
): EvalCase<LineupCaseInput> {
  const owned = buildOwned(xpts, overrides);
  const ownedPicks: Pick[] = owned.map((o, i) => ({
    element: o.element.id,
    position: i + 1,
    is_captain: false,
    is_vice_captain: false,
  }));
  return {
    id,
    taskId: 'fantasy/lineup',
    tags: { suite: 'fantasy', kind: 'lineup', origin: 'adversarial', probe },
    input: {
      kind: 'lineup',
      owned,
      elements: owned.map((o) => o.element),
      projections: owned.map((o) => ({
        element_id: o.element.id,
        event: SYNTHETIC_EVENT,
        xmins: 90,
        xpts: o.xpts,
      })),
      ownedPicks,
    },
  };
}

export function adversarialLineupCases(): EvalCase<LineupCaseInput>[] {
  return [
    // The highest-xpts outfielder is injured, with news text the optimizer
    // can't read. A good answer benches them despite the xpts; starting them
    // is a hard violation (hardLineupViolations, status !== 'a').
    buildCase(
      'injured-star',
      'benches-injured-star-despite-highest-xpts',
      {
        1: 3.0,
        2: 2.8,
        3: 4.5,
        4: 4.3,
        5: 4.1,
        6: 3.9,
        7: 3.7,
        8: 6.5,
        9: 6.2,
        10: 5.9,
        11: 5.6,
        12: 5.3,
        13: 6.8,
        14: 7.2,
        15: 11.5,
      },
      {
        15: {
          status: 'i',
          news: 'Lesão muscular no isquiotibial. Sem data de regresso confirmada.',
          news_added: '2026-09-01T10:00:00Z',
          chance_of_playing_this_round: 0,
          chance_of_playing_next_round: 0,
        },
      },
    ),

    // Softer than injured-star: 'd' with a real chance of playing, but still
    // not 'a' (still a hard violation to start), against a stronger xpts pull.
    buildCase(
      'doubtful-flagged',
      'weighs-doubtful-status-against-strong-xpts-pull',
      {
        1: 2.5,
        2: 2.3,
        3: 4.0,
        4: 3.8,
        5: 3.6,
        6: 3.4,
        7: 3.2,
        8: 6.5,
        9: 6.2,
        10: 5.9,
        11: 10.0,
        12: 5.3,
        13: 7.5,
        14: 8.0,
        15: 8.5,
      },
      {
        11: {
          status: 'd',
          chance_of_playing_this_round: 25,
          chance_of_playing_next_round: 25,
          news: 'Dores no joelho. Dúvida para a próxima jornada.',
          news_added: '2026-09-05T09:00:00Z',
        },
      },
    ),

    // Highest xpts is a goalkeeper, two forwards close behind. Captaining the
    // GK is legal but poor; probes captaincy judgement, not just the argmax.
    buildCase('captain-trap', 'avoids-captaining-highest-xpts-goalkeeper', {
      1: 9.0,
      2: 3.0,
      3: 4.5,
      4: 4.3,
      5: 4.1,
      6: 3.9,
      7: 3.7,
      8: 5.5,
      9: 5.3,
      10: 5.1,
      11: 4.9,
      12: 4.7,
      13: 8.8,
      14: 8.6,
      15: 6.0,
    }),

    // Every outfielder within 0.1 xpts of every other: the deterministic
    // argmax is essentially arbitrary. The regret grader should read ~0 here
    // regardless of what the model picks — that flatness is itself the
    // useful observation.
    buildCase('flat-xpts', 'flat-projection-makes-argmax-arbitrary', {
      1: 3.0,
      2: 2.8,
      3: 5.0,
      4: 5.01,
      5: 5.02,
      6: 5.03,
      7: 5.04,
      8: 5.05,
      9: 5.06,
      10: 5.07,
      11: 5.08,
      12: 5.09,
      13: 5.03,
      14: 5.06,
      15: 5.02,
    }),
  ];
}
