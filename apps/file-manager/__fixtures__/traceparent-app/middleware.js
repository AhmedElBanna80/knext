import { NextResponse } from 'next/server';

// Fixture for apps/file-manager/traceparent-middleware.test.ts. Middleware and
// the route handler share ONE standalone-server process (unlike Vercel's
// separate functions), exercising the behaviours the quarantined
// upstream otel-middleware-trace case is about.
const MW_TRACEPARENT = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';

export function middleware(request) {
  const headers = new Headers(request.headers);
  headers.set('x-mw-override', 'applied');
  if (request.nextUrl.pathname.endsWith('/mw-sets')) {
    headers.set('traceparent', MW_TRACEPARENT);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: '/api/echo/:path*' };
