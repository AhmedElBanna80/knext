import { trace } from '@opentelemetry/api';

export const dynamic = 'force-dynamic';

// Echo what the handler observes AFTER middleware ran.
export async function GET(request) {
  const span = trace.getActiveSpan();
  return Response.json({
    traceparentHeader: request.headers.get('traceparent'),
    mwOverride: request.headers.get('x-mw-override'),
    activeTraceId: span ? span.spanContext().traceId : null,
  });
}
