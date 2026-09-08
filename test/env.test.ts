/**
 * Tests for `parseConfig` (src/env.ts) -- the ONE place every numeric/
 * boolean/string var is parsed out of `Env`. Nothing here touches D1/AI/
 * Workflow bindings, so they're stubbed as `unknown` casts, same as
 * `test/loginProbe.test.ts`'s `makeEnv` does for the narrower
 * `LoginProbeEnv`.
 */
import { describe, expect, it } from 'vitest';

import {
  parseConfig,
  parseDryRun,
  DEFAULT_ENTRY_NAME,
  DEFAULT_ENTRY_FAVOURITE_TEAM,
  DEFAULT_ENTRY_REGION,
  type Env,
} from '../src/env';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    AI: undefined as unknown as Ai,
    INGEST: undefined as unknown as Workflow,
    DECIDE: undefined as unknown as Workflow,
    DRY_RUN: 'true',
    SESSION_PROVIDER: 'manual',
    LLM_PROVIDER: 'workers-ai',
    LLM_MODEL: 'test-model',
    FANTASY_BASE_URL: 'https://fantasy.ligaportugal.pt/api',
    MAX_TRANSFERS_PER_GW: '1',
    SQUAD_MARGIN: '0.10',
    LINEUP_ABS_FLOOR: '8',
    NEURON_DAILY_CAP: '8000',
    ENTRY_NAME: 'Fantasy Agent',
    ENTRY_FAVOURITE_TEAM: '2',
    ENTRY_REGION: '171',
    ...overrides,
  };
}

describe('parseDryRun', () => {
  it('defaults to true when unset', () => {
    expect(parseDryRun(undefined)).toBe(true);
  });

  it('is false only for the literal strings "false"/"0"', () => {
    expect(parseDryRun('false')).toBe(false);
    expect(parseDryRun('0')).toBe(false);
    expect(parseDryRun('FALSE')).toBe(false);
    expect(parseDryRun('true')).toBe(true);
    expect(parseDryRun('')).toBe(true);
  });
});

describe('parseConfig: entry-create identity (issue #16)', () => {
  it('parses configured ENTRY_NAME/ENTRY_FAVOURITE_TEAM/ENTRY_REGION', () => {
    const config = parseConfig(
      makeEnv({ ENTRY_NAME: 'My Squad', ENTRY_FAVOURITE_TEAM: '13', ENTRY_REGION: '225' }),
    );

    expect(config.entryName).toBe('My Squad');
    expect(config.entryFavouriteTeam).toBe(13);
    expect(config.entryRegion).toBe(225);
  });

  it('falls back to the documented defaults when the vars are unset', () => {
    const config = parseConfig(
      makeEnv({
        ENTRY_NAME: undefined as unknown as string,
        ENTRY_FAVOURITE_TEAM: undefined as unknown as string,
        ENTRY_REGION: undefined as unknown as string,
      }),
    );

    expect(config.entryName).toBe(DEFAULT_ENTRY_NAME);
    expect(config.entryFavouriteTeam).toBe(DEFAULT_ENTRY_FAVOURITE_TEAM);
    expect(config.entryRegion).toBe(DEFAULT_ENTRY_REGION);
  });

  it('falls back to the default name on a blank (whitespace-only) ENTRY_NAME', () => {
    const config = parseConfig(makeEnv({ ENTRY_NAME: '   ' }));
    expect(config.entryName).toBe(DEFAULT_ENTRY_NAME);
  });

  it('guards the Number("")===0 footgun: an empty ENTRY_FAVOURITE_TEAM/ENTRY_REGION never becomes id 0', () => {
    const config = parseConfig(makeEnv({ ENTRY_FAVOURITE_TEAM: '', ENTRY_REGION: '' }));

    expect(config.entryFavouriteTeam).toBe(DEFAULT_ENTRY_FAVOURITE_TEAM);
    expect(config.entryRegion).toBe(DEFAULT_ENTRY_REGION);
  });

  it('falls back to the defaults on non-numeric or non-positive values', () => {
    const config = parseConfig(
      makeEnv({ ENTRY_FAVOURITE_TEAM: 'not-a-number', ENTRY_REGION: '-1' }),
    );

    expect(config.entryFavouriteTeam).toBe(DEFAULT_ENTRY_FAVOURITE_TEAM);
    expect(config.entryRegion).toBe(DEFAULT_ENTRY_REGION);
  });

  it('floors a fractional id rather than submitting a non-integer', () => {
    const config = parseConfig(makeEnv({ ENTRY_FAVOURITE_TEAM: '13.7' }));
    expect(config.entryFavouriteTeam).toBe(13);
  });
});
