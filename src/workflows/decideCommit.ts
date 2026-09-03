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
 */

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
  sortPicksByTypeOrder,
} from '../api/endpoints';
import { ApiValidationError } from '../api/client';
import {
  getAllElements,
  getLatestSquadState,
  getTeams,
  isDryRun as dbIsDryRun,
  isEnabled,
  logAction,
  logAiCall,
  updateAiCallGate,
  upsertProjections,
  upsertSquadState,
  type ActionLogInput,
  type AiCallGateUpdate,
  type AiCallInput,
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
import { projectAll } from '../model/projection';
import { buildShortlist, ShortlistInvariantError } from '../shortlist';
import { makeLineupBaseline, makeSquadBaseline, makeTransferBaseline } from '../baseline';
import { createSessionStore } from '../sessionStore';
import { parseConfig, type Env, type ParsedConfig } from '../env';
import {
  RULES,
  type Decision,
  type Element,
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

/**
 * Adapts the `LlmAuditSink` shape onto the `ai_calls` row shape.
 *
 * `logAiCall` was previously wired as a port here but never invoked from
 * anywhere, so `ai_calls` stayed empty. That made a `deterministic-fallback`
 * decision undiagnosable from the data: there was no way to distinguish the
 * model refusing the JSON schema from the model never having been called.
 * Every attempt now lands a row, whatever the outcome.
 */
function makeAuditSink(deps: {
  logAiCall: (input: AiCallInput) => Promise<number>;
  updateAiCallGate: (id: number, gate: AiCallGateUpdate) => Promise<void>;
  modelName: string;
}): LlmAuditSink {
  return {
    record: async (e: AuditEntry) => {
      await deps.logAiCall({
        ts: new Date().toISOString(),
        decisionKind: e.decisionKind,
        model: deps.modelName,
        prompt: `attempt ${e.attempt}`,
        rawResponse: e.rawResponse ?? e.reason ?? undefined,
        schemaValid: e.outcome === 'ok',
        validationOutcome: e.outcome,
        repaired: false,
        gateVerdict: undefined,
        estNeuronsIn: e.estNeuronsIn,
        estNeuronsOut: e.estNeuronsOut,
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

  const finalPicks = lineupDecision.picks ?? newOwnedPicks;

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

  const finalPicks = lineupDecision.picks ?? squad.picks;

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
      response: { error: err instanceof Error ? err.message : String(err) },
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

    const result = await step.do('decide-and-commit', async () => {
      const elements = await getAllElements(env.DB);
      const teams = await getTeams(env.DB);
      const projections = projectAll(elements, eventId);
      await upsertProjections(env.DB, projections, nowIso());

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
