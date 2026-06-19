import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { isAuthorized } from './auth';

/**
 * Cache Invalidation API
 * POST /api/cache/invalidate
 *
 * Mutating endpoint — requires a Bearer token (B1, security.md). Token from the
 * CACHE_INVALIDATE_TOKEN env var (K8s Secret); fail-closed when unconfigured.
 */
export async function POST(request: Request) {
  if (!isAuthorized(request.headers.get('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await request.json();
    const { tag } = body;

    if (!tag || typeof tag !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid "tag" parameter' }, { status: 400 });
    }

    // Trigger Next.js cache invalidation with stale-while-revalidate
    revalidateTag(tag, 'max');

    return NextResponse.json({
      success: true,
      message: `Cache invalidated for tag: ${tag}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cache Invalidation] Error:', error);
    return NextResponse.json({ error: 'Failed to invalidate cache' }, { status: 500 });
  }
}

/**
 * GET /api/cache/invalidate?tag=files
 * Alternative GET-based invalidation for testing
 */
export async function GET(request: any) {
  // GET also mutates (invalidates) — same auth as POST. (A mutating GET is a smell;
  // retire this handler once callers move to POST.)
  if (!isAuthorized(request?.headers?.get?.('authorization'), process.env.CACHE_INVALIDATE_TOKEN)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let tag: string | null = null;
  try {
    const urlString = request?.url || request?.nextUrl?.href || 'http://localhost';
    const parsedUrl = new URL(urlString);
    tag = parsedUrl.searchParams?.get('tag');
  } catch (e) {
    console.warn('Failed to parse URL in cache invalidate route:', e);
  }

  if (!tag) {
    return NextResponse.json(
      { error: 'Missing "tag" query parameter', example: '/api/cache/invalidate?tag=files' },
      { status: 400 },
    );
  }

  // Trigger Next.js cache invalidation with stale-while-revalidate
  revalidateTag(tag, 'max');

  return NextResponse.json({
    success: true,
    message: `Cache invalidated for tag: ${tag}`,
    timestamp: new Date().toISOString(),
  });
}
