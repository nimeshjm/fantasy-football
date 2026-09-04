/**
 * `DecideCommitWorkflow`: the end-to-end squad/transfer/lineup decision and
 * commit pipeline.
 *
 * The heavy lifting lives in `runDecisionCore`, a dependency-injected async
 * function with NO direct D1/fetch/env access -- every read and write is a
 * callback on `DecisionCoreDeps`. This is what makes DRY_RUN, the kill
 * switch, the transfer cap and the neuron-budget fallback all testable
 * without a Workers runtime (see test/workflows.test.ts): tests call
 * `runDecisionCore` directly with fake deps, the same function the real
 * `DecideCommitWorkflow.run` calls from inside a few `step.do` blocks.
 *
 * ## Two integration hazards from the task brief, handled here
 *
 *  - HAZARD #2: every path below calls `decideLineup` AFTER the squad or
 *    transfer decision settles, and only ever POSTs the result of THAT
 *    lineup decision -- never a squad/transfer decision's own placeholder
 *    `Pick.position` values (`decideSquad`'s `assignSquadFormation` split,
 *    or a freshly-applied transfer's untouched positions).
 *  - HAZARD #3: `makeLineupBaseline`/`makeSquadBaseline`/`makeTransferBaseline`
 *    (src/baseline.ts) wire `scoreLineup` to the real
 *    `src/optimizer/lineup.ts` implementation, which doubles the captain.
 *
 * ## Step split and CPU risk (10ms CPU/step budget)
 *
 * `buildShortlist` (via `buildSquad`) is the single most CPU-expensive pure
 * computation this pipeline can run -- ~7-8ms in the worst case per
 * src/optimizer/squad.ts's own reference measurement, i.e. most of a whole
 * step's budget on its own. It runs ONLY on the squad-creation path (a
 * fresh entry with no existing squad -- structurally rare, at most once per
 * managed entry), inside the `decide-and-commit` step below, alongside the
 * LLM calls' own (much cheaper) validate/gate CPU. The steady-state
 * transfer/lineup path never calls `buildSquad` at all (`candidateTransfers`
 * is a different, bounded search). `check-enabled` and
 * `load-squad-and-config` are kept as their own steps specifically so the
 * one CPU-heavy step never also has to redo D1 reads or the live
 * `me/`/`my-team/` round trip on a retry.
 *
 * A fourth step, `project`, sits between `read-neuron-spend` and
 * `decide-and-commit`: computing projections (`model-v2` in particular --
 * a multi-thousand-row trailing-stats read plus per-player Poisson-sum
 * arithmetic over ~656 elements) used to happen inside `decide-and-commit`
 * itself, which would stack that cost directly on top of the CPU-heaviest
 * step above. `project` persists projections to D1 (`upsertProjections`)
 * and returns only a small summary, never the projection rows themselves
 * (`step.do` results are serialized into workflow storage); `decide-and-
 * commit` reads them back with `getProjectionsForEvent` rather than having
 * them threaded through the step boundary -- see the comments at both ends
 * of that hand-off below for why.
 */

import { sendOpsAlert } from '../alert';
import type { AlertDelivery } from '../sessionHealth';
import { getAuthContext, type AuthContext } from '../api/session';
import { FantasyApiClient } from '../api/client';
import {
  createEntry as apiCreateEntry,
  getMe,
  getMyTeam,
  postTransfers as apiPostTransfers,
  updateMyTeam as apiUpdateMyTeam,
  type EntryCreateRequest,
  type MyTeamResponse,
  orderPicksForMyTeam,
  sortPicksByTypeOrder,
} from '../api/endpoints';
import { ApiValidationError } from '../api/client';
import {
  getAllElements,
  getFixturesForEvent,
  getGwStatsSince,
  getLatestSquadState,
  getProjectionsForEvent,
  getProjectionStrategy,
  getTeams,
  isDryRun as dbIsDryRun,
  isEnabled,
  loadRatingsModel,
  logAction,
  logAiCall,
  updateAiCallGate,
  upsertProjections,
  upsertSquadState,
  type ActionLogInput,
  type AiCallGateUpdate,
  type AiCallInput,
  type GateVerdict,
  type TeamRow,
} from '../db';
import {
  decideLineup,
  decideSquad,
  decideTransfer,
  type LlmAuditSink,
  type NeuronBudget,
} from '../ai/decide';
import type { ShortlistEntry } from '../ai/prompts';
import { selectProvider, type LlmProvider } from '../ai/provider';
import { candidateTransfers } from '../optimizer/transfers';
import { projectAll, STRATEGY_MODEL_V2, type UpcomingFixtureInfo } from '../model/projection';
import type { RatingsModel } from '../model/ratings';
import { buildShortlist, ShortlistInvariantError } from '../shortlist';
import { makeLineupBaseline, makeSquadBaseline, makeTransferBaseline } from '../baseline';
import { createSessionStore } from '../sessionStore';
import { parseConfig, type Env, type ParsedConfig } from '../env';
import {
  RULES,
  type Decision,
  type DecisionKind,
  type Element,
  type GwStats,
  type Pick,
  type Projection,
  type TransferMove,
} from '../types';

// ---------------------------------------------------------------------------
// Pure(ish) helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/** One canonical string per squad, so a live `my-team/` state and a
 * proposed commit can be compared for equality without the `selling_price`/
 * `purchase_price` fields (present on one side, absent on the other)
 * defeating a naive deep-equal. */
export function canonicalizePicks(picks: readonly Pick[]): string {
  return [...picks]
    .sort((a, b) => a.position - b.position)
    .map((p) => `${p.element}:${p.position}:${p.is_captain ? 1 : 0}:${p.is_vice_captain ? 1 : 0}`)
    .join('|');
}

export function picksEqual(a: readonly Pick[], b: readonly Pick[]): boolean {
  return canonicalizePicks(a) === canonicalizePicks(b);
}

/** Applies one transfer to a 15-pick squad: swaps `move.element_out` for
 * `move.element_in` at the same slot, resetting captaincy -- `decideLineup`
 * always runs next and reassigns captain/vice/positions from scratch
 * (HAZARD #2), so there is no reason to try to preserve them here. */
export function applyTransfer(picks: readonly Pick[], move: TransferMove): Pick[] {
  return picks.map((p) =>
    p.element === move.element_out
      ? {
          element: move.element_in,
          position: p.position,
          is_captain: false,
          is_vice_captain: false,
        }
      : { ...p },
  );
}

function teamShortName(teams: readonly TeamRow[], teamId: number): string {
  return teams.find((t) => t.id === teamId)?.short_name ?? '?';
}

/** Builds one `ShortlistEntry` per element in `elementIds`, in the order
 * given. Elements or projections missing for an id are skipped (never
 * invented) -- callers that need every id resolved should check the output
 * length. */
export function buildShortlistEntries(
  elementIds: readonly number[],
  elements: readonly Element[],
  projections: readonly Projection[],
  teams: readonly TeamRow[],
): ShortlistEntry[] {
  const elementById = new Map(elements.map((e) => [e.id, e] as const));
  const xptsById = new Map(projections.map((p) => [p.element_id, p.xpts] as const));
  const entries: ShortlistEntry[] = [];
  for (const id of elementIds) {
    const element = elementById.get(id);
    if (!element) continue;
    entries.push({
      element,
      clubShortName: teamShortName(teams, element.team),
      xpts: xptsById.get(id) ?? 0,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Core decision pipeline
// ---------------------------------------------------------------------------

export type CreateEntryResult =
  { ok: true; entry: number } | { ok: false; status: number; error: unknown };

/** An existing managed squad, as understood by this workflow: the live 15
 * (from `my-team/`, authoritative for `selling_price`) and the season's
 * cumulative transfer count (from D1's `squad_state` ledger -- `my-team/`
 * does not expose this). `null` means no entry/squad exists yet -- the
 * squad-creation path runs instead. */
export interface ExistingSquad {
  entry: number;
  picks: Pick[];
  bank: number;
  cumulativeTransfers: number;
}

type AuditEntry = Parameters<LlmAuditSink['record']>[0];
type GateEntry = Parameters<NonNullable<LlmAuditSink['recordGate']>>[0];

/**
 * Adapts the `LlmAuditSink` shape onto the `ai_calls` row shape.
 *
 * `logAiCall` was previously wired as a port here but never invoked from
 * anywhere, so `ai_calls` stayed empty. That made a `deterministic-fallback`
 * decision undiagnosable from the data: there was no way to distinguish the
 * model refusing the JSON schema from the model never having been called.
 * Every attempt now lands a row, whatever the outcome.
 *
 * `recordGate` stamps the gate's verdict onto that same row rather than
 * inserting a new one (see `AiCallGateUpdate`'s doc comment in
 * src/db/types.ts for why the verdict belongs on the row carrying the answer
 * it judged, not a separate one).
 *
 * Rows are remembered per (decisionKind, attempt), NOT just per kind. Both
 * sink methods carry an `attempt`, and keying on it is what makes the stamp
 * land on the right row in the one case where the two diverge: the squad
 * repair path gates an EARLIER attempt's picks, so a later attempt that
 * failed at the provider or at JSON parsing has since logged the
 * most-recent row for that kind. Keyed by kind alone, the verdict would be
 * stamped onto that unrelated `provider-error` row -- a wrong answer to the
 * exact question this audit trail exists to answer.
 */
// Exported (only) for test/gateAudit.test.ts's direct unit test of the
// row-id-tracking/fallback logic below -- every production caller in this
// file still goes through the `decideSquad`/`decideLineup`/`decideTransfer`
// call sites further down.
export function makeAuditSink(deps: {
  logAiCall: (input: AiCallInput) => Promise<number>;
  updateAiCallGate: (id: number, gate: AiCallGateUpdate) => Promise<void>;
  modelName: string;
}): LlmAuditSink {
  /** Keyed `${decisionKind}:${attempt}` -- see the doc comment above for
   * why the attempt number has to be part of the key. */
  const rowIdByAttempt = new Map<string, number>();
  const key = (decisionKind: DecisionKind, attempt: number): string => `${decisionKind}:${attempt}`;

  return {
    record: async (e: AuditEntry) => {
      const id = await deps.logAiCall({
        ts: new Date().toISOString(),
        decisionKind: e.decisionKind,
        model: deps.modelName,
        prompt: `attempt ${e.attempt}`,
        rawResponse: e.rawResponse ?? e.reason ?? undefined,
        schemaValid: e.outcome === 'ok',
        validationOutcome: e.outcome,
        repaired: false,
        estNeuronsIn: e.estNeuronsIn,
        estNeuronsOut: e.estNeuronsOut,
      });
      rowIdByAttempt.set(key(e.decisionKind, e.attempt), id);
    },
    recordGate: async (e: GateEntry) => {
      const gateVerdict: GateVerdict = e.accept ? 'accept' : 'override';
      const id = rowIdByAttempt.get(key(e.decisionKind, e.attempt));
      if (id !== undefined) {
        await deps.updateAiCallGate(id, {
          gateVerdict,
          gateSource: e.source,
          gateOverrideReason: e.overrideReason,
          llmScore: e.llmScore,
          deterministicScore: e.deterministicScore,
        });
        return;
      }
      // Should never happen -- the gate only runs on an answer that a
      // `record` call already logged for that same (kind, attempt), so a row
      // id is always remembered by the time `recordGate` fires. This is a
      // safety net, not the normal path: if that invariant is ever violated,
      // the verdict must still land somewhere rather than silently vanish --
      // which is exactly the bug this whole feature exists to fix. The
      // prompt names it explicitly as a gate-only record so it reads
      // correctly in the dashboard rather than looking like a provider
      // response that never happened.
      await deps.logAiCall({
        ts: new Date().toISOString(),
        decisionKind: e.decisionKind,
        model: deps.modelName,
        prompt: `gate-only record (attempt ${e.attempt}): no logged call row was found to stamp`,
        repaired: false,
        gateVerdict,
        gateSource: e.source,
        gateOverrideReason: e.overrideReason,
        llmScore: e.llmScore,
        deterministicScore: e.deterministicScore,
        estNeuronsIn: 0,
        estNeuronsOut: 0,
      });
    },
  };
}

export interface DecisionCoreDeps {
  elements: Element[];
  teams: TeamRow[];
  projections: Projection[];
  eventId: number;
  config: ParsedConfig;
  existingSquad: ExistingSquad | null;
  provider: LlmProvider;
  neuronBudget: NeuronBudget;
  /** Model id, recorded on every ai_calls row. */
  modelName: string;

  /**
   * True iff the active projection strategy needed fixtures (`model-v2`)
   * and D1 came back with ZERO fixture rows for the WHOLE of `eventId` --
   * see the guard at the top of `runDecisionCore` (issue #24). Always
   * `false` under `ep-next`, which never reads `fixtures` at all, and false
   * whenever the event has a fixture for at least one team: a blank
   * gameweek for SOME teams is normal (`UpcomingFixtureInfo`'s own doc) and
   * must never trip this. This is the one signal that turns "every
   * projection for this event is 0 because there is nothing to project
   * from" into "stop before a decision is made from it", rather than
   * silently producing an arbitrary lineup and committing it.
   */
  blankFixturesForEvent: boolean;
  /** Fires the ops webhook (`sendOpsAlert`, src/alert.ts) for something
   * that is not a session-health event. Never throws -- same contract as
   * `sendOpsAlert` itself -- so a dead/misconfigured webhook can only ever
   * cost a `{delivered: false}`, never break the abort path that calls it. */
  sendOpsAlert: (summary: string, fields?: Record<string, unknown>) => Promise<AlertDelivery>;

  /** Re-reads fresh `now_cost`/`selling_price` immediately before a write --
   * prices move hourly and `price_change_locked_until` exists, so a
   * transfer costed at T-2h can be invalid by T-90m. Returns `null` if the
   * live squad can no longer be read (session dead, entry gone, etc). */
  reloadLivePrices: () => Promise<{ elements: Element[]; myTeam: MyTeamResponse } | null>;

  createEntry: (payload: EntryCreateRequest) => Promise<CreateEntryResult>;
  postTransfers: (moves: TransferMove[]) => Promise<unknown>;
  postMyTeam: (picks: Pick[]) => Promise<unknown>;

  logAction: (input: ActionLogInput) => Promise<void>;
  /** Returns the inserted `ai_calls` row id -- `updateAiCallGate` stamps the
   * gate's verdict onto that same row once the gate has run. */
  logAiCall: (input: AiCallInput) => Promise<number>;
  updateAiCallGate: (id: number, gate: AiCallGateUpdate) => Promise<void>;
  saveSquadState: (picks: Pick[], bank: number, cumulativeTransfers: number) => Promise<void>;
}

export interface DecisionCoreResult {
  ok: boolean;
  posted: boolean;
  reason: string;
  squadDecision?: Decision;
  transferDecision?: Decision;
  lineupDecision?: Decision;
}

async function logDecision(
  deps: DecisionCoreDeps,
  kind: string,
  decision: Decision,
  ok: boolean,
): Promise<void> {
  await deps.logAction({
    ts: nowIso(),
    kind,
    intent: decision,
    dryRun: deps.config.dryRun,
    source: decision.source,
    ok,
  });
}

/** Squad-creation path: no existing entry/squad. Builds a shortlist, picks a
 * squad, then a lineup (HAZARD #2), then either creates the entry or --
 * under DRY_RUN, or if entry-create 400s (mid-season registration can be
 * refused server-side) -- logs the intended squad without failing hard. */
async function runSquadCreation(deps: DecisionCoreDeps): Promise<DecisionCoreResult> {
  let shortlistResult;
  try {
    shortlistResult = buildShortlist(deps.elements, deps.projections, new Set());
  } catch (err) {
    // Fail loudly toward the deterministic path: a shortlist invariant
    // failure (ShortlistInvariantError) is a construction bug, not a model
    // failure, and must never silently become a Neuron spent on an
    // impossible task. There is no deterministic path to fall back to here
    // (buildShortlist's own internal buildSquad over the FULL pool already
    // failed), so this decision is abandoned for this tick rather than
    // committing nothing.
    const isInvariantFailure = err instanceof ShortlistInvariantError;
    await deps.logAction({
      ts: nowIso(),
      kind: 'squad-creation',
      intent: { stage: 'shortlist', invariantFailure: isInvariantFailure },
      response: { error: err instanceof Error ? err.message : String(err) },
      dryRun: deps.config.dryRun,
      source: 'deterministic-fallback',
      ok: false,
    });
    return { ok: false, posted: false, reason: 'shortlist construction failed; see actions_log' };
  }

  const { shortlist, deterministicSquad } = shortlistResult;
  const shortlistEntries = buildShortlistEntries(
    shortlist.map((e) => e.id),
    deps.elements,
    deps.projections,
    deps.teams,
  );
  const squadBaseline = makeSquadBaseline(
    deps.elements,
    deps.projections,
    deterministicSquad.picks,
  );

  const squadDecision = await decideSquad({
    audit: makeAuditSink(deps),
    shortlist: shortlistEntries,
    elements: deps.elements,
    provider: deps.provider,
    budget: deps.neuronBudget,
    baseline: squadBaseline,
    squadMargin: deps.config.squadMargin,
  });
  await logDecision(deps, 'squad', squadDecision, true);

  // HAZARD #2: decideLineup MUST run and supersede the squad decision's
  // placeholder positions before anything is committed.
  const ownedPicks = squadDecision.picks ?? deterministicSquad.picks;
  const lineupBaseline = makeLineupBaseline(deps.elements, deps.projections, ownedPicks);
  const ownedEntries = buildShortlistEntries(
    ownedPicks.map((p) => p.element),
    deps.elements,
    deps.projections,
    deps.teams,
  );
  const lineupDecision = await decideLineup({
    audit: makeAuditSink(deps),
    owned: ownedEntries,
    elements: deps.elements,
    provider: deps.provider,
    budget: deps.neuronBudget,
    baseline: lineupBaseline,
    lineupAbsFloor: deps.config.lineupAbsFloor,
  });
  await logDecision(deps, 'lineup', lineupDecision, true);

  const finalPicks = lineupDecision.picks ?? ownedPicks;

  if (deps.config.dryRun) {
    return {
      ok: true,
      posted: false,
      reason: 'dry run: squad creation computed, nothing posted',
      squadDecision,
      lineupDecision,
    };
  }

  const elementById = new Map(deps.elements.map((e) => [e.id, e] as const));
  const elementTypeById = new Map(deps.elements.map((e) => [e.id, e.element_type as number]));

  // Both of these were learned from a real 400, not from the JS bundle:
  // picks must be in element_type order, and terms_agreed is required.
  const orderedPicks = sortPicksByTypeOrder(
    finalPicks.map((p) => ({
      element: p.element,
      purchase_price: elementById.get(p.element)?.now_cost ?? 0,
    })),
    elementTypeById,
  );

  const payload: EntryCreateRequest = {
    name: 'Fantasy Agent',
    favourite_team: 1,
    region: 1,
    kit: null,
    terms_agreed: true,
    picks: orderedPicks,
  };

  const created = await deps.createEntry(payload);
  if (!created.ok) {
    await deps.logAction({
      ts: nowIso(),
      kind: 'entry-create',
      intent: payload,
      response: { status: created.status, error: created.error },
      dryRun: false,
      source: lineupDecision.source,
      ok: false,
    });
    return {
      ok: false,
      posted: false,
      reason: `entry-create failed (status ${created.status}); intended squad logged`,
      squadDecision,
      lineupDecision,
    };
  }

  await deps.logAction({
    ts: nowIso(),
    kind: 'entry-create',
    intent: payload,
    response: { entry: created.entry },
    dryRun: false,
    source: lineupDecision.source,
    ok: true,
  });
  await deps.saveSquadState(finalPicks, 0, 0);

  return { ok: true, posted: true, reason: 'entry created', squadDecision, lineupDecision };
}

/** Steady-state path: an existing squad. Considers at most one transfer
 * (respecting `RULES.transfersCap` and `config.maxTransfersPerGw`), then
 * always re-runs the lineup decision (HAZARD #2) on the resulting 15, then
 * re-reads live prices immediately before POSTing. */
async function runTransferAndLineup(
  deps: DecisionCoreDeps,
  squad: ExistingSquad,
): Promise<DecisionCoreResult> {
  let transferDecision: Decision | undefined;
  let chosenMove: TransferMove | null = null;

  const transfersAllowed =
    deps.config.maxTransfersPerGw >= 1 && squad.cumulativeTransfers < RULES.transfersCap;

  if (!transfersAllowed) {
    transferDecision = {
      kind: 'transfer',
      source: 'deterministic-fallback',
      transfers: [],
      reasoning:
        squad.cumulativeTransfers >= RULES.transfersCap
          ? `season transfer cap (${RULES.transfersCap}) reached; no transfer attempted`
          : 'transfers disabled by configuration; no transfer attempted',
    };
    await logDecision(deps, 'transfer', transferDecision, true);
  } else {
    const state = {
      entry: squad.entry,
      event: deps.eventId,
      picks: squad.picks,
      chip: null,
      bank: squad.bank,
      value: 0,
      freeTransfers: 1,
      transfersMade: 0,
    };
    const candidates = candidateTransfers(state, deps.elements, [deps.projections]).filter(
      (c) => c.moves.length === 1,
    );
    const fallbackMove =
      candidates.length > 0 && (candidates[0]?.gain ?? 0) > 0 ? [candidates[0]!.moves[0]!] : [];
    const transferBaseline = makeTransferBaseline(
      deps.elements,
      deps.projections,
      squad.picks,
      fallbackMove,
    );

    const squadEntries = buildShortlistEntries(
      squad.picks.map((p) => p.element),
      deps.elements,
      deps.projections,
      deps.teams,
    );
    const candidateInputs = candidates
      .map((c) => {
        const move = c.moves[0];
        if (!move) return null;
        const [inEntry] = buildShortlistEntries(
          [move.element_in],
          deps.elements,
          deps.projections,
          deps.teams,
        );
        const [outEntry] = buildShortlistEntries(
          [move.element_out],
          deps.elements,
          deps.projections,
          deps.teams,
        );
        if (!inEntry || !outEntry) return null;
        return { elementIn: inEntry, elementOut: outEntry, move, gain: c.gain };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    transferDecision = await decideTransfer({
      audit: makeAuditSink(deps),
      squad: squadEntries,
      candidates: candidateInputs,
      bankTenths: squad.bank,
      provider: deps.provider,
      budget: deps.neuronBudget,
      baseline: transferBaseline,
    });
    await logDecision(deps, 'transfer', transferDecision, true);

    if (transferDecision.transfers && transferDecision.transfers.length === 1) {
      chosenMove = transferDecision.transfers[0] ?? null;
    }
  }

  const newOwnedPicks = chosenMove ? applyTransfer(squad.picks, chosenMove) : squad.picks;

  // HAZARD #2: decideLineup MUST run and supersede any transfer's
  // untouched positions before anything is committed.
  const lineupBaseline = makeLineupBaseline(deps.elements, deps.projections, newOwnedPicks);
  const ownedEntries = buildShortlistEntries(
    newOwnedPicks.map((p) => p.element),
    deps.elements,
    deps.projections,
    deps.teams,
  );
  const lineupDecision = await decideLineup({
    audit: makeAuditSink(deps),
    owned: ownedEntries,
    elements: deps.elements,
    provider: deps.provider,
    budget: deps.neuronBudget,
    baseline: lineupBaseline,
    lineupAbsFloor: deps.config.lineupAbsFloor,
  });
  await logDecision(deps, 'lineup', lineupDecision, true);

  // `my-team/` rejects an XI that is not in element_type order, so the
  // decision's slot ordering is normalised BEFORE anything consumes it --
  // the idempotency check, the POST and the saved squad state all have to
  // agree on positions or the next tick sees a phantom mismatch.
  const finalPicks = orderPicksForMyTeam(
    lineupDecision.picks ?? newOwnedPicks,
    new Map(deps.elements.map((e) => [e.id, e.element_type as number])),
  );

  if (deps.config.dryRun) {
    return {
      ok: true,
      posted: false,
      reason: 'dry run: transfer/lineup computed, nothing posted',
      transferDecision,
      lineupDecision,
    };
  }

  // Re-read live prices/state immediately before POSTing.
  const fresh = await deps.reloadLivePrices();
  if (!fresh) {
    await deps.logAction({
      ts: nowIso(),
      kind: 'price-reread',
      intent: {},
      response: { error: 'could not reload live prices/state' },
      dryRun: false,
      source: lineupDecision.source,
      ok: false,
    });
    return {
      ok: false,
      posted: false,
      reason: 'could not re-read live prices before posting',
      transferDecision,
      lineupDecision,
    };
  }

  let posted = false;

  if (chosenMove) {
    const freshElementById = new Map(fresh.elements.map((e) => [e.id, e] as const));
    const freshOutgoing = fresh.myTeam.picks.find((p) => p.element === chosenMove!.element_out);
    const freshSellingPrice = freshOutgoing?.selling_price ?? chosenMove.selling_price;
    const freshPurchasePrice =
      freshElementById.get(chosenMove.element_in)?.now_cost ?? chosenMove.purchase_price;
    const stillAffordable = squad.bank + freshSellingPrice >= freshPurchasePrice;

    if (!stillAffordable) {
      await deps.logAction({
        ts: nowIso(),
        kind: 'transfer-post',
        intent: chosenMove,
        response: { error: 'no longer affordable after re-reading live prices' },
        dryRun: false,
        source: transferDecision.source,
        ok: false,
      });
      chosenMove = null;
    } else {
      const refreshedMove: TransferMove = {
        ...chosenMove,
        selling_price: freshSellingPrice,
        purchase_price: freshPurchasePrice,
      };
      const resp = await deps.postTransfers([refreshedMove]);
      await deps.logAction({
        ts: nowIso(),
        kind: 'transfer-post',
        intent: refreshedMove,
        response: resp,
        dryRun: false,
        source: transferDecision.source,
        ok: true,
      });
      posted = true;
    }
  }

  // Idempotency: skip the lineup POST if live state already matches intent.
  if (!picksEqual(fresh.myTeam.picks, finalPicks)) {
    const resp = await deps.postMyTeam(finalPicks);
    await deps.logAction({
      ts: nowIso(),
      kind: 'lineup-post',
      intent: finalPicks,
      response: resp,
      dryRun: false,
      source: lineupDecision.source,
      ok: true,
    });
    posted = true;
  }

  await deps.saveSquadState(
    finalPicks,
    squad.bank - (chosenMove ? chosenMove.purchase_price - chosenMove.selling_price : 0),
    squad.cumulativeTransfers + (chosenMove ? 1 : 0),
  );

  return {
    ok: true,
    posted,
    reason: posted ? 'posted' : 'already matched live state',
    transferDecision,
    lineupDecision,
  };
}

/** `mode: 'lineup-only'` re-check: re-runs ONLY the lineup decision on the
 * existing squad (to catch late-breaking news close to the deadline) and
 * re-POSTs the XI if it changed. Never touches transfers or the squad
 * itself. */
async function runLineupOnly(
  deps: DecisionCoreDeps,
  squad: ExistingSquad,
): Promise<DecisionCoreResult> {
  const lineupBaseline = makeLineupBaseline(deps.elements, deps.projections, squad.picks);
  const ownedEntries = buildShortlistEntries(
    squad.picks.map((p) => p.element),
    deps.elements,
    deps.projections,
    deps.teams,
  );
  const lineupDecision = await decideLineup({
    audit: makeAuditSink(deps),
    owned: ownedEntries,
    elements: deps.elements,
    provider: deps.provider,
    budget: deps.neuronBudget,
    baseline: lineupBaseline,
    lineupAbsFloor: deps.config.lineupAbsFloor,
  });
  await logDecision(deps, 'lineup-recheck', lineupDecision, true);

  // `my-team/` rejects an XI that is not in element_type order, so the
  // decision's slot ordering is normalised BEFORE anything consumes it --
  // the idempotency check, the POST and the saved squad state all have to
  // agree on positions or the next tick sees a phantom mismatch.
  const finalPicks = orderPicksForMyTeam(
    lineupDecision.picks ?? squad.picks,
    new Map(deps.elements.map((e) => [e.id, e.element_type as number])),
  );

  if (deps.config.dryRun) {
    return {
      ok: true,
      posted: false,
      reason: 'dry run: lineup recheck computed, nothing posted',
      lineupDecision,
    };
  }

  const fresh = await deps.reloadLivePrices();
  if (fresh && picksEqual(fresh.myTeam.picks, finalPicks)) {
    return { ok: true, posted: false, reason: 'lineup already matches live state', lineupDecision };
  }

  const resp = await deps.postMyTeam(finalPicks);
  await deps.logAction({
    ts: nowIso(),
    kind: 'lineup-post',
    intent: finalPicks,
    response: resp,
    dryRun: false,
    source: lineupDecision.source,
    ok: true,
  });
  await deps.saveSquadState(finalPicks, squad.bank, squad.cumulativeTransfers);

  return { ok: true, posted: true, reason: 'posted lineup recheck', lineupDecision };
}

/**
 * Issue #24: the fail-closed path for a whole event with zero fixtures in
 * D1. Before this guard existed, EVERY decision ever made ran on `xpts: 0`
 * for all ~667 players -- the deterministic optimum degenerated to an
 * arbitrary legal formation, and `src/ai/validate.ts`'s gate compared `0`
 * against `0` and accepted unconditionally, so the LLM's answer (also
 * shaped by nothing) went straight to a live POST. Structural validity
 * (`hardLineupViolations`) was the only check actually protecting a commit.
 *
 * Committing a blind lineup here is strictly worse than doing nothing: the
 * previously-committed squad/lineup is a real, considered decision from the
 * last tick that DID have fixtures, and it keeps playing (and scoring)
 * exactly as it would have anyway. Overwriting it with a coin-flip formation
 * trades a good, slightly-stale decision for a worthless fresh one, on the
 * one asset (the live FPL entry) this whole system exists to manage. So
 * this returns before either `decideSquad`/`decideTransfer`/`decideLineup`
 * or any `post*` call runs -- there is no "safer" partial decision to make
 * from zero signal, only the choice between abstaining and gambling.
 *
 * Deliberately narrow: `deps.blankFixturesForEvent` is true only when the
 * WHOLE event has no fixtures, never for a blank gameweek affecting some
 * teams (normal, and handled by `projectModelV2` itself per-player) -- see
 * the field's own doc comment on `DecisionCoreDeps`.
 */
async function abortForBlankFixtures(
  mode: 'full' | 'lineup-only',
  deps: DecisionCoreDeps,
): Promise<DecisionCoreResult> {
  const reason = `no fixtures stored in D1 for gameweek ${deps.eventId}; refusing to decide or commit (issue #24)`;
  const summary =
    `Gameweek ${deps.eventId}: D1 has zero fixtures stored for this event, so every player's ` +
    `projection would be xpts=0 and the deterministic/LLM gate would accept blindly. No squad, ` +
    `transfer or lineup was committed -- the previously-committed lineup is left in place.`;

  await deps.logAction({
    ts: nowIso(),
    kind: 'decide-commit-blank-fixtures',
    intent: { mode, eventId: deps.eventId },
    response: { error: reason },
    dryRun: deps.config.dryRun,
    source: 'deterministic-fallback',
    ok: false,
  });

  // `sendOpsAlert` is contracted never to throw (src/alert.ts) -- an unset
  // or unreachable webhook must degrade to `{delivered: false}`, never to an
  // exception that would make the fail-closed path itself the thing that
  // breaks the tick. The delivery outcome isn't otherwise consulted here:
  // whether or not anyone was told, the abort still holds.
  await deps.sendOpsAlert(summary, { eventId: deps.eventId, mode });

  return { ok: false, posted: false, reason };
}

/**
 * Runs one full decision-and-commit cycle. Never throws -- every failure
 * path returns `{ ok: false, ... }` with the reason logged via
 * `deps.logAction`, per the task brief's "never throw past the workflow
 * boundary" rail.
 */
export async function runDecisionCore(
  mode: 'full' | 'lineup-only',
  deps: DecisionCoreDeps,
): Promise<DecisionCoreResult> {
  try {
    // Issue #24: checked before anything else, ahead of even the
    // lineup-only/squad-creation/transfer branching below -- a blank event
    // invalidates every one of those paths identically, since they all run
    // on the same all-zero `deps.projections`.
    if (deps.blankFixturesForEvent) {
      return await abortForBlankFixtures(mode, deps);
    }
    if (mode === 'lineup-only') {
      if (!deps.existingSquad) {
        return { ok: false, posted: false, reason: 'lineup-only requested but no existing squad' };
      }
      return await runLineupOnly(deps, deps.existingSquad);
    }
    if (!deps.existingSquad) {
      return await runSquadCreation(deps);
    }
    return await runTransferAndLineup(deps, deps.existingSquad);
  } catch (err) {
    await deps.logAction({
      ts: nowIso(),
      kind: 'decide-commit-error',
      intent: { mode },
      // `fieldErrors` is the only place the live API says WHY it rejected a
      // write (`squad_not_type_order` and friends). Logging just the message
      // leaves 'Validation error from POST my-team/{id}/' as the whole record
      // of a failed commit -- useless in the minutes before a deadline.
      response: {
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof ApiValidationError ? { fieldErrors: err.fieldErrors } : {}),
      },
      dryRun: deps.config.dryRun,
      source: 'deterministic-fallback',
      ok: false,
    });
    return { ok: false, posted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// In-memory NeuronBudget backed by D1's ai_budget table
// ---------------------------------------------------------------------------

/** Reads today's spend once and tracks additional spend locally so
 * `remaining()` (checked before every LLM call, including retries) doesn't
 * re-query D1 each time; `record()` persists the increment. */
export function createNeuronBudget(
  db: D1Database,
  dailyCap: number,
  spentSoFar: number,
  addNeuronsSpent: (db: D1Database, utcDay: string, neurons: number) => Promise<void>,
): NeuronBudget {
  let spent = spentSoFar;
  const utcDay = new Date().toISOString().slice(0, 10);
  return {
    remaining: () => Math.max(0, dailyCap - spent),
    record: async (neurons: number) => {
      spent += neurons;
      await addNeuronsSpent(db, utcDay, neurons);
    },
  };
}

// ---------------------------------------------------------------------------
// WorkflowEntrypoint wiring
// ---------------------------------------------------------------------------

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getNeuronsSpentToday, addNeuronsSpent as dbAddNeuronsSpent } from '../db';

export interface DecideCommitParams {
  mode: 'full' | 'lineup-only';
  eventId: number;
}

interface ResolvedAuth {
  auth: AuthContext;
  entry: number | null;
  client: FantasyApiClient;
}

async function resolveAuthAndEntry(env: Env): Promise<ResolvedAuth> {
  const client = new FantasyApiClient(env.FANTASY_BASE_URL);
  const sessionStore = createSessionStore(env);
  const auth = await getAuthContext(env, sessionStore);
  const me = await getMe(client, auth.cookie);
  return { auth, entry: me.player?.entry ?? null, client };
}

async function loadExistingSquad(
  env: Env,
  resolved: ResolvedAuth,
  entry: number,
): Promise<ExistingSquad | null> {
  try {
    const myTeam = await getMyTeam(resolved.client, entry, resolved.auth);
    if (!myTeam.picks || myTeam.picks.length === 0) return null;
    const latest = await getLatestSquadState(env.DB, entry);
    const bank = typeof myTeam.bank === 'number' ? myTeam.bank : (latest?.bank ?? 0);
    return {
      entry,
      picks: myTeam.picks,
      bank,
      cumulativeTransfers: latest?.cumulativeTransfers ?? 0,
    };
  } catch {
    return null;
  }
}

export class DecideCommitWorkflow extends WorkflowEntrypoint<Env, DecideCommitParams> {
  override async run(
    workflowEvent: Readonly<WorkflowEvent<DecideCommitParams>>,
    step: WorkflowStep,
  ): Promise<DecisionCoreResult> {
    const env = this.env;
    const { mode, eventId } = workflowEvent.payload;

    const enabled = await step.do('check-enabled', () => isEnabled(env.DB));
    if (!enabled) {
      return { ok: true, posted: false, reason: 'kill switch is off' };
    }

    // Cheap D1 reads plus (at most) one live `me/`/`my-team/` round trip --
    // deliberately its own step, separate from the CPU-heavier decision
    // step below (see the module doc's "step split" note: squad-creation's
    // `buildShortlist` call, which lives inside `runDecisionCore`, is the
    // one CPU-expensive part of this workflow, so nothing else is bundled
    // alongside it here).
    const loaded = await step.do('load-squad-and-config', async () => {
      const config = parseConfig(env);
      const dryRunOverride = await dbIsDryRun(env.DB);
      const resolved = await resolveAuthAndEntry(env);
      const existingSquad = resolved.entry
        ? await loadExistingSquad(env, resolved, resolved.entry)
        : null;
      return {
        config: { ...config, dryRun: config.dryRun || dryRunOverride },
        entry: resolved.entry,
        existingSquad,
      };
    });

    const spentSoFar = await step.do('read-neuron-spend', () =>
      getNeuronsSpentToday(env.DB, new Date().toISOString().slice(0, 10)),
    );

    // Its own step, ahead of `decide-and-commit`, for the same CPU-budget
    // reason the module doc gives for keeping `load-squad-and-config`
    // separate: `decide-and-commit` is already the heaviest step in this
    // workflow (buildShortlist's ~7-8ms worst case against a 10ms/step
    // budget), and model-v2 is not free CPU on top of that -- it reads a
    // multi-thousand-row trailing-stats window (I/O plus O(rows) grouping
    // below) and then runs ~656 elements through `projectModelV2`, each
    // doing several `poissonFloorDivExpectation` sums (kMax=20 terms of
    // float arithmetic apiece). Bundling that into `decide-and-commit`
    // would be exactly the kind of "one more thing" the module doc warns
    // against tipping the CPU-heavy step over budget. `ep-next` still runs
    // through this step (cheap: `getAllElements` plus one `config` read via
    // `getProjectionStrategy`, no fixtures/ratings/trailing-stats reads) so
    // the read-back below always has a fresh row per player, whichever
    // strategy is active.
    const projectResult = await step.do('project', async () => {
      const elements = await getAllElements(env.DB);
      const strategy = await getProjectionStrategy(env.DB);

      let ratings: RatingsModel | undefined;
      let fixturesByTeam: Map<number, UpcomingFixtureInfo> | undefined;
      let trailingStatsByElement: Map<number, GwStats[]> | undefined;
      // Issue #24: true only when `model-v2` is active AND D1 has ZERO
      // fixture rows for the WHOLE of `eventId` -- see
      // `DecisionCoreDeps.blankFixturesForEvent`'s doc comment for why this,
      // and only this, is the anomaly (a blank gameweek for SOME teams is
      // normal and must never set this). `ep-next` never reads `fixtures`,
      // so it never trips this either.
      let blankFixturesForEvent = false;

      if (strategy === STRATEGY_MODEL_V2) {
        ratings = await loadRatingsModel(env.DB);

        // One fixture per team for THIS event only -- a team plays both
        // home and away across a season, but within a single gameweek's
        // fixture list it appears at most once (see
        // `UpcomingFixtureInfo`'s own doc: double gameweeks are not
        // modelled). A team absent here (blank gameweek) is intentionally
        // left out of the map; `projectModelV2` already treats that as 0
        // xmins/xpts.
        const fixtures = await getFixturesForEvent(env.DB, eventId);
        blankFixturesForEvent = fixtures.length === 0;
        fixturesByTeam = new Map<number, UpcomingFixtureInfo>();
        for (const f of fixtures) {
          fixturesByTeam.set(f.team_h, { opponent: f.team_a, isHome: true });
          fixturesByTeam.set(f.team_a, { opponent: f.team_h, isHome: false });
        }

        // Trailing window: mirror projection.ts's own default lookback (6
        // gameweeks -- see ProjectionOptions.trailingWindow's doc) so the
        // D1 read covers exactly what the model can use, no more. Clamped
        // to event 1 so an early-season `eventId` (e.g. GW3) doesn't
        // request a negative/zero event. `getGwStatsSince` is `event >=
        // minEvent` with no upper bound, so it would also happily return
        // rows for `eventId` itself if ingest had ever written partial
        // in-progress stats for the gameweek being projected -- that
        // can't happen in this workflow (ingest only runs, and only
        // writes, for gameweeks that have already been played), but the
        // filter below makes that assumption explicit and enforced rather
        // than implicit and silently relied on.
        const TRAILING_WINDOW_GAMEWEEKS = 6;
        const minEvent = Math.max(1, eventId - TRAILING_WINDOW_GAMEWEEKS);
        const trailingRows = (await getGwStatsSince(env.DB, minEvent)).filter(
          (r) => r.event < eventId,
        );
        trailingStatsByElement = new Map<number, GwStats[]>();
        for (const row of trailingRows) {
          const list = trailingStatsByElement.get(row.element_id);
          if (list) {
            list.push(row);
          } else {
            trailingStatsByElement.set(row.element_id, [row]);
          }
        }
      }

      const projections = projectAll(elements, eventId, {
        strategy,
        ratings,
        fixturesByTeam,
        trailingStatsByElement,
      });
      await upsertProjections(env.DB, projections, nowIso());

      // Never return the projections themselves -- step.do's return value
      // is serialized into workflow instance storage, and 656 rows of
      // { element_id, event, xmins, xpts } per attempt is exactly the kind
      // of payload that belongs in D1 (already the source of truth here),
      // not duplicated into workflow state. `decide-and-commit` reads them
      // straight back out below. `blankFixturesForEvent` (a single boolean)
      // is the one thing from this step `decide-and-commit` cannot re-derive
      // from D1 alone without re-running the same strategy/fixtures reads --
      // small enough to carry across the step boundary directly.
      return {
        strategy,
        projected: projections.length,
        teamsRated: ratings?.ratings.size ?? 0,
        blankFixturesForEvent,
      };
    });

    const result = await step.do('decide-and-commit', async () => {
      const elements = await getAllElements(env.DB);
      const teams = await getTeams(env.DB);
      // Read back rather than threading `project`'s in-memory projections
      // through the step boundary: `step.do` results are serialized and
      // persisted (see the "never return the projections themselves"
      // comment in the `project` step above), and D1 is the single source
      // of truth here regardless -- a retry of THIS step alone must see
      // the same projections `project` already committed, not risk
      // depending on that step's now-gone in-memory value.
      // `ProjectionRow extends Projection`, so this satisfies
      // `DecisionCoreDeps.projections` without any adaptation.
      const projections = await getProjectionsForEvent(env.DB, eventId);

      const provider = selectProvider(env);
      const neuronBudget = createNeuronBudget(
        env.DB,
        loaded.config.neuronDailyCap,
        spentSoFar,
        dbAddNeuronsSpent,
      );

      // Resolved once and reused by every write callback below, rather than
      // re-resolving auth (and re-fetching `me/`) on every single write --
      // each `resolveAuthAndEntry` call costs a subrequest.
      let cachedAuth: ResolvedAuth | null = null;
      const auth = async (): Promise<ResolvedAuth> => {
        cachedAuth ??= await resolveAuthAndEntry(env);
        return cachedAuth;
      };

      const deps: DecisionCoreDeps = {
        elements,
        teams,
        projections,
        eventId,
        config: loaded.config,
        existingSquad: loaded.existingSquad,
        provider,
        neuronBudget,
        blankFixturesForEvent: projectResult.blankFixturesForEvent,
        sendOpsAlert: (summary, fields) => sendOpsAlert(env, summary, fields),
        reloadLivePrices: async () => {
          if (!loaded.existingSquad) return null;
          try {
            const resolved = await auth();
            const [freshElements, myTeam] = await Promise.all([
              getAllElements(env.DB),
              getMyTeam(resolved.client, loaded.existingSquad.entry, resolved.auth),
            ]);
            return { elements: freshElements, myTeam };
          } catch {
            return null;
          }
        },
        createEntry: async (payload) => {
          try {
            const resolved = await auth();
            const created = await apiCreateEntry(resolved.client, resolved.auth, payload);
            return { ok: true, entry: created.id };
          } catch (err) {
            if (err instanceof ApiValidationError) {
              return { ok: false, status: 400, error: err.fieldErrors };
            }
            return {
              ok: false,
              status: 0,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
        postTransfers: async (moves) => {
          const resolved = await auth();
          if (!loaded.existingSquad) throw new Error('postTransfers called with no existing squad');
          return apiPostTransfers(resolved.client, resolved.auth, {
            chip: null,
            entry: loaded.existingSquad.entry,
            event: eventId,
            transfers: moves,
          });
        },
        postMyTeam: async (picks) => {
          const resolved = await auth();
          const entry = loaded.existingSquad?.entry ?? loaded.entry;
          if (!entry) throw new Error('postMyTeam called with no resolved entry');
          return apiUpdateMyTeam(resolved.client, entry, resolved.auth, { chip: null, picks });
        },
        logAction: (input) => logAction(env.DB, input),
        logAiCall: (input) => logAiCall(env.DB, input),
        updateAiCallGate: (id, gate) => updateAiCallGate(env.DB, id, gate),
        modelName: env.LLM_MODEL,
        saveSquadState: async (picks, bank, cumulativeTransfers) => {
          const entry = loaded.existingSquad?.entry ?? loaded.entry;
          if (!entry) return;
          await upsertSquadState(env.DB, {
            entry,
            event: eventId,
            picks,
            chip: null,
            bank,
            value: 0,
            freeTransfers: 1,
            transfersMade: cumulativeTransfers,
            cumulativeTransfers,
          });
        },
      };

      return runDecisionCore(mode, deps);
    });

    return result;
  }
}
