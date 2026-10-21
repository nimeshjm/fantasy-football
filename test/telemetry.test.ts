import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tracing } from 'cloudflare:workers';
import { reportError } from '../src/telemetry';

vi.mock('cloudflare:workers', () => ({ tracing: { getActiveSpan: vi.fn() } }));

const getActiveSpan = vi.mocked(tracing.getActiveSpan);

describe('reportError', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getActiveSpan.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs one structured line for an Error with no active span', () => {
    reportError({ slug: 'site', err: new Error('boom'), attrs: { 'app.mode': 'full' } });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      event: 'exception',
      'exception.slug': 'site',
      'exception.type': 'Error',
      'exception.message': 'boom',
      'app.mode': 'full',
    });
  });

  it('stringifies a non-Error input', () => {
    reportError({ slug: 'site', err: 'plain string' });

    expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
      'exception.type': 'Error',
      'exception.message': 'plain string',
    });
  });

  it('records the exception and attributes on the active span', () => {
    const span = { recordException: vi.fn(), setAttributes: vi.fn() };
    getActiveSpan.mockReturnValue(span as never);
    const err = new Error('boom');

    reportError({ slug: 'site', err, attrs: { 'app.mode': 'full' } });

    expect(span.recordException).toHaveBeenCalledWith(err);
    expect(span.setAttributes).toHaveBeenCalledWith({
      error: true,
      'exception.slug': 'site',
      'app.mode': 'full',
    });
  });

  it('never throws when the span throws', () => {
    const span = {
      recordException: vi.fn(() => {
        throw new Error('span broke');
      }),
      setAttributes: vi.fn(),
    };
    getActiveSpan.mockReturnValue(span as never);

    expect(() => reportError({ slug: 'site', err: new Error('boom') })).not.toThrow();
  });
});
