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

/**
 * Approximate token estimate. No tokenizer is loaded into the Worker, so
 * this is intentionally rough - it exists to catch gross overruns before
 * they cost a wasted Workers AI call, not to predict exact usage.
 *
 * The invariant this function exists to satisfy is ONE-SIDED:
 * `estimateTokens(text) >= the real prompt_tokens Workers AI will meter for
 * that text`. Never a tolerance band. Underestimating breaks the context
 * guard in `assertPromptFits` - the failure mode is a request that silently
 * exceeds the model's real window. Overestimating only costs a rounding
 * error in a cheap pre-call reservation (input Neurons price at
 * 26,668/1M ~= 0.027 each - see `NEURONS_PER_1M_INPUT_TOKENS` in
 * provider.ts) and is the direction to err in.
 *
 * The original `Math.ceil(text.length / 4)` was calibrated for English
 * prose, and undershot on every one of the five real Workers AI responses
 * captured for issue #15 (test/fixtures/workers-ai/, commit 797bc37) except
 * the one prose sample - because this agent's actual prompts are id-,
 * number- and punctuation-dense tabular data
 * (`101 GK ARO 4.5 3.1`-style rows), not prose, and dense text costs more
 * tokens per character. Measured chars/token (chars = sum of
 * `request.messages[].content.length`, tokens = `envelope.usage.prompt_tokens`):
 *
 *   fixture                   | chars | real prompt_tokens | chars/token | old estimate (chars/4)
 *   ---------------------------|------:|--------------------:|------------:|------------------------:
 *   json-schema-squad          |   610 |                  340 |        1.79 | 153 (45% of real - UNDER)
 *   json-schema-lineup         |   404 |                  213 |        1.90 | 101 (47% of real - UNDER)
 *   json-schema-transfer       |   309 |                  146 |        2.12 |  78 (53% of real - UNDER)
 *   plain-text-json-content    |   153 |                   80 |        1.91 |  39 (49% of real - UNDER)
 *   plain-text-prose           |    85 |                   53 |        1.60 |  22 (42% of real - UNDER)
 *
 * (`plain-text-prose` measures 3.86 chars/token by the OLD chars/4 framing,
 * i.e. chars/4 was already roughly correct there - see below for why it is
 * kept in the calibration set anyway.)
 *
 * Two effects are conflated in that gap, and only one of them scales with
 * prompt length:
 *
 *  - A FIXED chat-template overhead, independent of content length - BOS,
 *    role headers, eot markers the model's chat template adds around every
 *    call. Isolated from `plain-text-prose` (85 chars, 53 real tokens): even
 *    at the correct ~4 chars/token for prose, content alone accounts for
 *    ~22 tokens, leaving ~31 unaccounted for. Modelled here as a flat +32
 *    tokens per `estimateTokens` CALL (not per prompt) - decide.ts's
 *    `callLlm` calls it twice (`estimateTokens(prompt.system) +
 *    estimateTokens(prompt.user)`), so the constant is applied twice there
 *    for one actual per-CALL overhead. That is deliberate headroom, not a
 *    bug to "optimise away" - the one-sided invariant only requires
 *    OVER-estimating never being wrong, and `assertPromptFits` calls this on
 *    the single joined `${system}\n${user}` string, where the tighter
 *    single-application bound already holds.
 *  - A RATIO that undershoots this agent's actual traffic. Prose measures
 *    ~3.86 chars/token (chars/4 was fine there); this agent's real prompts -
 *    tabular, digit- and delimiter-dense - measure 1.60-2.12. Modelled here
 *    as chars/1.75, close to the tightest (worst-case) sample
 *    (json-schema-squad, 1.79) with a small margin either side of it.
 *
 * `ceil(chars / 1.75) + 32` against the same five captures (see
 * test/prompts.test.ts for the executable version of this table):
 *
 *   fixture                   | chars | real | estimate | margin
 *   ---------------------------|------:|-----:|---------:|-------:
 *   json-schema-squad          |   610 |  340 |      381 |   +12%
 *   json-schema-lineup         |   404 |  213 |      263 |   +23%
 *   json-schema-transfer       |   309 |  146 |      209 |   +43%
 *   plain-text-json-content    |   153 |   80 |      120 |   +50%
 *   plain-text-prose           |    85 |   53 |       81 |   +53%
 *
 * `estimate >= real` on all five, worst-case (tightest) margin 12% on the
 * densest capture (json-schema-squad). No schema-size accounting is added
 * here: the `json_schema` sent to Workers AI does NOT consume prompt tokens
 * (ruled out during this issue's investigation - SQUAD_SCHEMA is the
 * smallest of the three json_schema captures' schemas and has the largest
 * gap; LINEUP_SCHEMA is the largest and over-estimates already, the
 * opposite of what schema-cost accounting would predict).
 *
 * `plain-text-prose` MUST stay in the calibration set even though it is the
 * smallest gap: it is the only sample where the old chars/4 ratio was
 * already about right, so it is what would catch a future recalibration
 * that over-corrects into inflating ordinary prose along with the tabular
 * data this ratio is actually tuned for.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.75) + 32;
}

/** Throws if `prompt` would not fit inside `maxTokens`, per the (approximate,
 * deliberately one-sided-conservative) `estimateTokens` above. Callers pick
 * `maxTokens` as the context window minus whatever they intend to reserve
 * for the answer (see `CONTEXT_WINDOW_TOKENS` in provider.ts). */
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

const SQUAD_POSITION_ORDER = [Position.GK, Position.DEF, Position.MID, Position.FWD] as const;

/**
 * The squad candidate list, split into one block per position, each labelled
 * with the exact number to take from it.
 *
 * The flat list this replaced asked the model to hold four running position
 * counters and a per-club counter while reading ~160 interleaved lines, with
 * the composition rule ~5.5k tokens behind it in the system message. It never
 * once managed it: across the 9 recorded squad attempts in the first live eval
 * run, 0 produced a legal composition, over-picking GK (+7) and DEF (+8) and
 * under-picking MID (-10) and FWD (-5). Blocking by position turns that into
 * four independent "take the best N from this block" choices and puts each
 * quota adjacent to the players it governs.
 */
function squadCandidateBlocks(shortlist: ShortlistEntry[]): string {
  const byPosition = new Map<Position, ShortlistEntry[]>();
  for (const position of SQUAD_POSITION_ORDER) byPosition.set(position, []);
  for (const entry of shortlist) byPosition.get(entry.element.element_type)?.push(entry);

  const blocks: string[] = [];
  for (const position of SQUAD_POSITION_ORDER) {
    const entries = byPosition.get(position) ?? [];
    const code = PROMPT_POSITION_CODE[position];
    blocks.push(
      `## ${code} - choose exactly ${RULES.squadSelect[position]} of these ${entries.length}, ` +
        `into "${code.toLowerCase()}"\n` +
        `${PLAYER_LINE_HEADER}\n${entries.map(formatPlayerLine).join('\n')}`,
    );
  }
  return blocks.join('\n\n');
}

/** Pick 15 from a shortlist. */
export function buildSquadPrompt(shortlist: ShortlistEntry[]): BuiltPrompt {
  const system =
    `You pick a 15-player squad for a Fantasy Liga Portugal (Betclic) team. ${SQUAD_RULES_TEXT} ` +
    `Maximise total expected points (xpts) for the squad subject to those constraints. A ` +
    `player's "news" field is a Portuguese injury/suspension note not reflected in xpts - treat ` +
    `an active injury or suspension as a strong reason to avoid that player. Respond using the ` +
    `JSON schema only: one list of ids per position, and one short reason.`;
  // The rules are restated after the candidates as well as before them: the
  // list is long enough that the system message is thousands of tokens behind
  // the point where the answer is generated.
  const user =
    `Candidates are grouped by position. Each group below fills the answer list of the ` +
    `same name, and the schema fixes how many ids that list holds.\n\n` +
    `${squadCandidateBlocks(shortlist)}\n\n` +
    `Put each id in the list for its own group. The two constraints the schema cannot ` +
    `express, and the only ones left to check: at most ${RULES.teamLimit} ids sharing a club ` +
    `across all four lists, and total cost of the ${RULES.squadSize} at most ` +
    `EUR${(RULES.budget / 10).toFixed(1)}m.`;
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
