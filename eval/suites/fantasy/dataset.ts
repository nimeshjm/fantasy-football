/**
 * Fixed dataset for the fantasy eval suite: squad, lineup and transfer cases
 * for gameweeks 2-4, built from `pointInTimeState` so every input respects
 * the leakage contract documented in fixtures.ts. `truth` is the only place
 * `realizedPoints` is ever read.
 */
import { RULES, type Element, type Pick, type SquadState, type Team } from '../../../src/types';
import type { ShortlistEntry, TransferCandidateEntry } from '../../../src/ai/prompts';
import { buildShortlist } from '../../../src/shortlist';
import { candidateTransfers } from '../../../src/optimizer/transfers';
import type {
  EvalCase,
  SquadCaseInput,
  LineupCaseInput,
  TransferCaseInput,
} from '../../core/types';
import { pointInTimeState, realizedPoints, type PointInTimeState } from './fixtures';

import bootstrapStatic from '../../../test/fixtures/bootstrap-static.json';

const teams = bootstrapStatic.teams as unknown as Team[];

const GAMEWEEKS = [2, 3, 4] as const;

/** Synthetic FPL entry id for the transfer cases: no real account exists in
 * these fixtures (see fixtures.ts's module doc), so any fixed constant
 * works -- `candidateTransfers` never reads it. */
const SYNTHETIC_ENTRY_ID = 1;

function teamShortName(teamId: number): string {
  return teams.find((t) => t.id === teamId)?.short_name ?? '?';
}

/** Mirrors `buildShortlistEntries` in src/workflows/decideCommit.ts (a
 * missing projection defaults xpts to 0), sorted by element id since
 * `buildShortlist`'s shortlist order is unspecified and cases must be
 * byte-identical across runs. */
function toShortlistEntries(
  elementIds: readonly number[],
  state: PointInTimeState,
): ShortlistEntry[] {
  const elementById = new Map(state.elements.map((e) => [e.id, e] as const));
  const xptsById = new Map(state.projections.map((p) => [p.element_id, p.xpts] as const));
  const entries: ShortlistEntry[] = [];
  for (const id of elementIds) {
    const element = elementById.get(id);
    if (!element) continue;
    entries.push({
      element,
      clubShortName: teamShortName(element.team),
      xpts: xptsById.get(id) ?? 0,
    });
  }
  return entries.sort((a, b) => a.element.id - b.element.id);
}

function picksToIds(picks: readonly Pick[]): number[] {
  return picks.map((p) => p.element);
}

function totalNowCost(picks: readonly Pick[], elements: readonly Element[]): number {
  const byId = new Map(elements.map((e) => [e.id, e] as const));
  let total = 0;
  for (const p of picks) total += byId.get(p.element)?.now_cost ?? 0;
  return total;
}

interface Built {
  squad: EvalCase<SquadCaseInput>[];
  lineup: EvalCase<LineupCaseInput>[];
  transfer: EvalCase<TransferCaseInput>[];
  notes: string[];
}

function build(): Built {
  const squad: EvalCase<SquadCaseInput>[] = [];
  const lineup: EvalCase<LineupCaseInput>[] = [];
  const transfer: EvalCase<TransferCaseInput>[] = [];
  const notes: string[] = [];

  const stateByGw = new Map<number, PointInTimeState>();
  const stateFor = (g: number): PointInTimeState => {
    let s = stateByGw.get(g);
    if (!s) {
      s = pointInTimeState(g);
      stateByGw.set(g, s);
    }
    return s;
  };

  for (const g of GAMEWEEKS) {
    const state = stateFor(g);
    const truth = { event: g, pointsByElement: realizedPoints(g) };
    const tags = (kind: string) => ({
      suite: 'fantasy',
      kind,
      origin: 'fixture',
      event: String(g),
    });

    const { shortlist, deterministicSquad } = buildShortlist(state.elements, state.projections);

    squad.push({
      id: `squad-gw${g}`,
      taskId: 'fantasy/squad',
      tags: tags('squad'),
      input: {
        kind: 'squad',
        shortlist: toShortlistEntries(
          shortlist.map((e) => e.id),
          state,
        ),
        elements: state.elements,
      },
      truth,
    });

    lineup.push({
      id: `lineup-gw${g}`,
      taskId: 'fantasy/lineup',
      tags: tags('lineup'),
      input: {
        kind: 'lineup',
        owned: toShortlistEntries(picksToIds(deterministicSquad.picks), state),
        elements: state.elements,
      },
      truth,
    });

    // Transfer case: owned 15 is the deterministic squad for gw g-1, so the
    // decision is a genuine "change my GW{g-1} squad for GW{g}" -- gw1's
    // squad is built the same way (pointInTimeState(1) fits on an empty
    // fixture set, which fitTeamRatings/projectAll both handle).
    const prevGw = g - 1;
    const prevState = stateFor(prevGw);
    const prevSquad = buildShortlist(prevState.elements, prevState.projections).deterministicSquad;
    const ownedPicks = prevSquad.picks;

    // bank: the budget left unspent by the gw{prevGw} deterministic build,
    // so squad value + bank reconstructs exactly the budget that build was
    // allowed to spend -- deliberate, not arbitrary.
    const spent = totalNowCost(ownedPicks, prevState.elements);
    const bank = RULES.budget - spent;
    const value = spent + bank;

    const squadState: SquadState = {
      entry: SYNTHETIC_ENTRY_ID,
      event: g,
      picks: ownedPicks,
      chip: null,
      bank,
      value,
      freeTransfers: 1,
      transfersMade: 0,
    };

    const candidates = candidateTransfers(squadState, state.elements, [state.projections]);
    const positiveGain = candidates.filter((c) => c.gain > 0);
    if (positiveGain.length === 0) {
      notes.push(
        `transfer-gw${g}: omitted -- candidateTransfers returned ${candidates.length} candidate(s), none with gain > 0.`,
      );
      continue;
    }
    if (positiveGain.length < candidates.length) {
      notes.push(
        `transfer-gw${g}: dropped ${candidates.length - positiveGain.length} non-improving candidate(s) (gain <= 0) out of ${candidates.length}.`,
      );
    }

    const candidateEntries: TransferCandidateEntry[] = positiveGain.map((c) => {
      const move = c.moves[0];
      if (!move) throw new Error(`transfer-gw${g}: candidate with no moves`);
      const [elementIn] = toShortlistEntries([move.element_in], state);
      const [elementOut] = toShortlistEntries([move.element_out], state);
      if (!elementIn || !elementOut) {
        throw new Error(`transfer-gw${g}: candidate references an element outside the pool`);
      }
      return { elementIn, elementOut, gain: c.gain };
    });

    transfer.push({
      id: `transfer-gw${g}`,
      taskId: 'fantasy/transfer',
      tags: tags('transfer'),
      input: {
        kind: 'transfer',
        squad: toShortlistEntries(picksToIds(ownedPicks), state),
        candidates: candidateEntries,
        bankTenths: bank,
        elements: state.elements,
      },
      truth,
    });
  }

  return { squad, lineup, transfer, notes };
}

let cached: Built | undefined;

function cases(): Built {
  if (!cached) cached = build();
  return cached;
}

export function fantasyCases(): {
  squad: EvalCase<SquadCaseInput>[];
  lineup: EvalCase<LineupCaseInput>[];
  transfer: EvalCase<TransferCaseInput>[];
} {
  const { squad, lineup, transfer } = cases();
  return { squad, lineup, transfer };
}

export function datasetNotes(): string[] {
  return cases().notes;
}
