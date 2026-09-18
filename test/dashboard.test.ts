/**
 * Tests for `actionDetailCell` in src/dashboard.ts -- the pure renderer for
 * the "Recent actions" table's Detail cell. Everything else in dashboard.ts
 * touches D1/fetch and is covered elsewhere (test/workers/); this function is
 * pure, so it gets a plain unit test.
 */
import { describe, expect, it } from 'vitest';

import { actionDetailCell } from '../src/dashboard';
import type { ActionLogRow } from '../src/db/logging';
import type { ElementRow } from '../src/db/types';
import { Position, type Decision, type Element, type Pick } from '../src/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let nextElementId = 1;
function makeElement(overrides: Partial<ElementRow> = {}): ElementRow {
  const id = overrides.id ?? nextElementId++;
  const base: Element = {
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
  };
  return { ...base, updated_at: '2026-01-01T00:00:00Z', ...overrides };
}

let nextActionId = 1;
function makeAction(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: nextActionId++,
    ts: '2026-01-01T10:00:00Z',
    kind: 'session-health',
    intent: null,
    response: null,
    dryRun: false,
    source: 'llm',
    ok: true,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    kind: 'lineup',
    source: 'llm',
    reasoning: 'because the numbers say so',
    ...overrides,
  };
}

function makePick(overrides: Partial<Pick> = {}): Pick {
  return {
    element: 1,
    position: 1,
    is_captain: false,
    is_vice_captain: false,
    ...overrides,
  };
}

/** A full 15-pick squad: positions 1-11 starting XI, 12-15 bench, each pick's
 * `element` pointing at a distinct entry in `elementById`. */
function makeFullSquad(elementById: Map<number, ElementRow>): Pick[] {
  const picks: Pick[] = [];
  for (let position = 1; position <= 15; position++) {
    const el = makeElement();
    elementById.set(el.id, el);
    picks.push(makePick({ element: el.id, position }));
  }
  picks[0]!.is_captain = true;
  picks[1]!.is_vice_captain = true;
  return picks;
}

function safeJson(v: unknown): string {
  return JSON.stringify(v, null, 2) ?? '';
}

function escapeHtml(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------

describe('actionDetailCell', () => {
  it('renders reasoning and a picks sub-table for a valid lineup-recheck decision', () => {
    const elementById = new Map<number, ElementRow>();
    const picks = makeFullSquad(elementById);
    const captainName = elementById.get(picks[0]!.element)!.web_name;
    const decision = makeDecision({
      kind: 'lineup',
      reasoning: 'benched the rotation risk',
      picks,
    });
    const action = makeAction({ kind: 'lineup-recheck', intent: decision });

    const html = actionDetailCell(action, elementById);

    expect(html).toContain('benched the rotation risk');
    expect(html).toContain(captainName);
    expect(html).toContain('Starting XI');
    expect(html).toContain('Bench');
  });

  it('renders the override reason with a gate tag when set', () => {
    const elementById = new Map<number, ElementRow>();
    const picks = makeFullSquad(elementById);
    const decision = makeDecision({
      reasoning: 'model picked X',
      overrideReason: 'sanity gate rejected the captain choice',
      picks,
    });
    const action = makeAction({ kind: 'lineup-recheck', intent: decision });

    const html = actionDetailCell(action, elementById);

    expect(html).toContain('sanity gate rejected the captain choice');
    expect(html).toContain('tag gate');
  });

  it('falls back to a <pre> block for lineup-recheck with a malformed (string) intent', () => {
    const elementById = new Map<number, ElementRow>();
    const action = makeAction({ kind: 'lineup-recheck', intent: 'not even an object' });

    const html = actionDetailCell(action, elementById);

    expect(() => actionDetailCell(action, elementById)).not.toThrow();
    expect(html).toContain('<pre>');
    expect(html).toContain(escapeHtml(safeJson('not even an object')));
  });

  it.each([['nope' as unknown], [42 as unknown]])(
    'renders reasoning but no picks table when lineup-recheck decision.picks is %j (not an array)',
    (badPicks) => {
      const elementById = new Map<number, ElementRow>();
      const decision = makeDecision({ reasoning: 'still has reasoning', picks: badPicks as never });
      const action = makeAction({ kind: 'lineup-recheck', intent: decision });

      expect(() => actionDetailCell(action, elementById)).not.toThrow();
      const html = actionDetailCell(action, elementById);

      expect(html).toContain('still has reasoning');
      expect(html).not.toContain('class="lineup"');
    },
  );

  it('lineup-post: shows captain in the summary and a C flag, and no API response block when response is {}', () => {
    const elementById = new Map<number, ElementRow>();
    const picks = makeFullSquad(elementById);
    const captainName = elementById.get(picks[0]!.element)!.web_name;
    const action = makeAction({ kind: 'lineup-post', intent: picks, response: {} });

    const html = actionDetailCell(action, elementById);

    expect(html).toContain(`C: ${captainName}`);
    expect(html).toMatch(/>C<\/td>/);
    expect(html).not.toContain('API response');
  });

  it('lineup-post: shows the API response block when response is non-empty', () => {
    const elementById = new Map<number, ElementRow>();
    const picks = makeFullSquad(elementById);
    const action = makeAction({
      kind: 'lineup-post',
      intent: picks,
      response: { status: 'ok', entry: 12345 },
    });

    const html = actionDetailCell(action, elementById);

    expect(html).toContain('API response');
  });

  it('falls back to a <pre> block for lineup-post whose intent is not a pick array', () => {
    const elementById = new Map<number, ElementRow>();
    const action = makeAction({ kind: 'lineup-post', intent: { not: 'picks' }, response: null });

    const html = actionDetailCell(action, elementById);

    expect(html).toContain('<pre>');
    expect(html).toContain(escapeHtml(safeJson({ not: 'picks' })));
  });

  it('renders any other kind byte-identical to the old fallback expression', () => {
    const elementById = new Map<number, ElementRow>();
    const action = makeAction({
      kind: 'session-health',
      intent: { some: 'payload' },
      response: null,
    });

    const html = actionDetailCell(action, elementById);
    const expected = `<pre>${escapeHtml(safeJson(action.response ?? action.intent))}</pre>`;

    expect(html).toBe(expected);
  });

  it('escapes a <script> tag in reasoning and " / < in a picked player\'s news', () => {
    const elementById = new Map<number, ElementRow>();
    const picks = makeFullSquad(elementById);
    const el = elementById.get(picks[0]!.element)!;
    elementById.set(el.id, { ...el, news: 'knee issue "<serious>"' });
    const decision = makeDecision({
      reasoning: '<script>alert(1)</script>',
      picks,
    });
    const action = makeAction({ kind: 'lineup-recheck', intent: decision });

    const html = actionDetailCell(action, elementById);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
