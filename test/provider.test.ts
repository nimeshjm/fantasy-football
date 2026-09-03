import { describe, expect, it } from 'vitest';
import { extractResponseTextForTest } from '../src/ai/provider';

describe('extractResponseText', () => {
  it('accepts a string response (plain text mode)', () => {
    expect(extractResponseTextForTest({ response: '{"picks":[1,2]}' })).toBe('{"picks":[1,2]}');
  });

  it('accepts an OBJECT response, which is what JSON mode actually returns', () => {
    // The regression that mattered: with response_format json_schema the
    // runtime parses the answer and `response` is an object, not a string.
    // Accepting only strings discarded every live call *after* spending the
    // Neurons, and silently produced deterministic-fallback decisions.
    const parsed = extractResponseTextForTest({ response: { picks: [1, 2, 3] } });
    expect(parsed).toBe('{"picks":[1,2,3]}');
    expect(JSON.parse(parsed!)).toEqual({ picks: [1, 2, 3] });
  });

  it('returns null for an empty string, a missing field, and a non-object', () => {
    expect(extractResponseTextForTest({ response: '' })).toBeNull();
    expect(extractResponseTextForTest({})).toBeNull();
    expect(extractResponseTextForTest(null)).toBeNull();
  });
});
