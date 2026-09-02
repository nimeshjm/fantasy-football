/**
 * Compact, token-efficient prompt builders for the three LLM decisions.
 *
 * One line per player, ~35 tokens: id, name, position, club, cost, baseline
 * xPts, form, minutes, and - the one signal a numeric model cannot read -
 * the raw Portuguese `news` text whenever it is non-empty. That injury/
 * suspension free text is the main reason this project asks an LLM anything
 * at all, so it is never truncated or summarised away.
 */

import { Position, RULES, type Element } from '../types';

/** Position codes used in every player line, deliberately matching the
 * English abbreviations the rule text uses (GK/DEF/MID/FWD) rather than
 * `POSITION_SHORT` from types.ts (GR/DEF/MED/AVA - the site's Portuguese
 * display codes). A small model asked to obey "2 GK, 5 DEF, 5 MID, 3 FWD"
 * should never have to also infer that "AVA" means FWD - that mismatch is
 * exactly the kind of avoidable confusion that burns a retry. */
const PROMPT_POSITION_CODE: Record<Position, string> = {
  [Position.GK]: 'GK',
  [Position.DEF]: 'DEF',
  [Position.MID]: 'MID',
  [Position.FWD]: 'FWD',
};

/** Approximate token estimate: ~4 characters per token. No tokenizer is
 * loaded into the Worker, so this is intentionally rough - it exists to
 * catch gross overruns before they cost a wasted Workers AI call, not to
 * predict exact usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Throws if `prompt` would not fit inside `maxTokens`, per the (approximate)
 * chars/4 estimator above. Callers pick `maxTokens` as the context window
 * minus whatever they intend to reserve for the answer (see
 * `CONTEXT_WINDOW_TOKENS` in provider.ts). */
export function assertPromptFits(prompt: string, maxTokens: number): void {
  const estimated = estimateTokens(prompt);
  if (estimated > maxTokens) {
    throw new Error(
      `Prompt is too large: ~${estimated} estimated tokens exceeds the ${maxTokens}-token budget.`,
    );
  }
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/** One row of shortlist/owned-squad context handed to the model.
 * Deliberately plain data, not a class: the concurrent projection/optimizer
 * workstream supplies these values, and this module has no dependency on
 * how `xpts` was computed. */
export interface ShortlistEntry {
  element: Element;
  clubShortName: string;
  /** Deterministic baseline expected points for the next event. */
  xpts: number;
}

/** One candidate transfer offered to the model. Already legality- and
 * budget-checked by deterministic code - the model only ranks these, it
 * does not invent them. */
export interface TransferCandidateEntry {
  elementIn: ShortlistEntry;
  elementOut: ShortlistEntry;
  /** Projected point gain over the planning horizon if this transfer is made. */
  gain: number;
}

const SQUAD_RULES_TEXT =
  `Budget <= EUR${(RULES.budget / 10).toFixed(1)}m total. Squad is exactly 15: ` +
  `${RULES.squadSelect[Position.GK]} GK, ${RULES.squadSelect[Position.DEF]} DEF, ` +
  `${RULES.squadSelect[Position.MID]} MID, ${RULES.squadSelect[Position.FWD]} FWD. ` +
  `Max ${RULES.teamLimit} players from the same club.`;

const LINEUP_RULES_TEXT =
  `Starting XI is exactly 11, chosen only from the 15 owned players: ` +
  `GK ${RULES.play[Position.GK].min}-${RULES.play[Position.GK].max}, ` +
  `DEF ${RULES.play[Position.DEF].min}-${RULES.play[Position.DEF].max}, ` +
  `MID ${RULES.play[Position.MID].min}-${RULES.play[Position.MID].max}, ` +
  `FWD ${RULES.play[Position.FWD].min}-${RULES.play[Position.FWD].max}. ` +
  `Bench is the remaining 4, ordered best-to-worst. Captain and vice-captain must both ` +
  `be among the 11 starters and must be different players.`;

function formatCost(nowCostTenths: number): string {
  return (nowCostTenths / 10).toFixed(1);
}

const PLAYER_LINE_HEADER = 'id|name|pos|club|cost|xpts|form|mins|news?';

/** ~35 tokens per line. See module docstring for why `news` is never
 * truncated. */
export function formatPlayerLine(entry: ShortlistEntry): string {
  const { element, clubShortName, xpts } = entry;
  const base = [
    element.id,
    element.web_name,
    PROMPT_POSITION_CODE[element.element_type],
    clubShortName,
    formatCost(element.now_cost),
    xpts.toFixed(1),
    element.form,
    element.minutes,
  ].join('|');
  return element.news ? `${base}|news:${element.news}` : base;
}

function playerListBlock(label: string, entries: ShortlistEntry[]): string {
  return `${label} (${entries.length} players):\n${PLAYER_LINE_HEADER}\n${entries
    .map(formatPlayerLine)
    .join('\n')}`;
}

/** Pick 15 from a shortlist. */
export function buildSquadPrompt(shortlist: ShortlistEntry[]): BuiltPrompt {
  const system =
    `You pick a 15-player squad for a Fantasy Liga Portugal (Betclic) team. ${SQUAD_RULES_TEXT} ` +
    `Maximise total expected points (xpts) for the squad subject to those constraints. A ` +
    `player's "news" field is a Portuguese injury/suspension note not reflected in xpts - treat ` +
    `an active injury or suspension as a strong reason to avoid that player. Respond using the ` +
    `JSON schema only: the 15 chosen ids and one short reason.`;
  const user = playerListBlock('Shortlist', shortlist);
  return { system, user };
}

/** Pick XI, bench order, captain and vice from the owned 15. */
export function buildLineupPrompt(owned: ShortlistEntry[]): BuiltPrompt {
  const system =
    `You pick a starting XI, bench order, captain and vice-captain from a 15-player Fantasy ` +
    `Liga Portugal (Betclic) squad. ${LINEUP_RULES_TEXT} Maximise total expected points (xpts), ` +
    `with the captain's points doubled. A player's "news" field is a Portuguese injury/` +
    `suspension note not reflected in xpts - a starter who is actually injured or suspended ` +
    `scores nothing, so treat "news" as the most important signal for who starts and who is ` +
    `captain. Respond using the JSON schema only: the starter ids, the bench ids in order, the ` +
    `captain id, the vice-captain id, and one short reason.`;
  const user = playerListBlock('Owned squad', owned);
  return { system, user };
}

/** Pick ONE of the supplied pre-validated candidate transfers, or none. */
export function buildTransferPrompt(
  squad: ShortlistEntry[],
  candidates: TransferCandidateEntry[],
  bankTenths: number,
): BuiltPrompt {
  const system =
    `You may make AT MOST ONE transfer this gameweek for a Fantasy Liga Portugal (Betclic) ` +
    `team, chosen only from the numbered candidate list below - every candidate is already ` +
    `legal and budget-checked, so you do not need to check budget or squad rules yourself. Each ` +
    `candidate's "gain" is the deterministic model's projected point gain over the planning ` +
    `horizon if made. A player's "news" field is a Portuguese injury/suspension note the ` +
    `deterministic gain does not fully capture - weigh it when a candidate's outgoing or ` +
    `incoming player is flagged. Pick the single best candidate, or elect not to transfer if ` +
    `none clearly helps. Respond using the JSON schema only: to make a transfer, echo that ` +
    `candidate's element_in and element_out ids exactly as given; to make no transfer, respond ` +
    `element_in=0 and element_out=0. Always include one short reason.`;
  const squadBlock = playerListBlock('Current squad', squad);
  const candidateLines = candidates
    .map(
      (c, i) =>
        `${i + 1}. element_in=${c.elementIn.element.id} element_out=${c.elementOut.element.id} ` +
        `gain:+${c.gain.toFixed(1)} | IN ${formatPlayerLine(c.elementIn)} | ` +
        `OUT ${formatPlayerLine(c.elementOut)}`,
    )
    .join('\n');
  const user = `Bank: EUR${formatCost(bankTenths)}m.\n${squadBlock}\n\nCandidate transfers:\n${candidateLines}`;
  return { system, user };
}
