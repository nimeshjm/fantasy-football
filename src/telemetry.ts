import { tracing } from 'cloudflare:workers';

export type ErrorAttrs = Record<string, string | number | boolean>;

export interface ErrorReport {
  /** Static site id, the aggregation key in Honeycomb. */
  slug: string;
  err: unknown;
  /** Low-cardinality context only. Never a cookie, never a prompt. */
  attrs?: ErrorAttrs;
}

export type ReportError = (report: ErrorReport) => void;

/** Records an exception on the active span and emits one structured log
 * line. Never throws: observability must never take down the caller. */
export function reportError({ slug, err, attrs = {} }: ErrorReport): void {
  try {
    const isError = err instanceof Error;
    const type = isError ? err.name : 'Error';
    const message = isError ? err.message : String(err);
    const span = tracing.getActiveSpan();
    if (span) {
      span.recordException(isError ? err : message);
      span.setAttributes({ error: true, 'exception.slug': slug, ...attrs });
    }
    console.error({
      event: 'exception',
      'exception.slug': slug,
      'exception.type': type,
      'exception.message': message,
      'exception.stacktrace': isError ? err.stack : undefined,
      ...attrs,
    });
  } catch {
    // Intentionally swallowed.
  }
}
