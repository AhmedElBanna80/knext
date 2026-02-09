import { NextResponse } from 'next/server';

/**
 * Cache Events API
 * Reads from global.cacheEvents populated by the cache-handler.js
 *
 * GET /api/cache/events — Returns cache events and stats
 * DELETE /api/cache/events — Clears all events
 */

interface CacheEvent {
  id: string;
  timestamp: string;
  type: string;
  source: string;
  key: string;
  tag?: string;
  durationMs?: number;
  details?: string;
}

// Access the global cache events array (populated by cache-handler.js at runtime)
// Using globalThis to avoid re-declaring the global type
function getEvents(): CacheEvent[] {
  return (globalThis as Record<string, unknown>).cacheEvents as CacheEvent[] || [];
}

function getCounter(): number {
  return (globalThis as Record<string, unknown>).cacheEventCounter as number || 0;
}

function getCacheStats() {
  const events = getEvents();

  const hits = events.filter((e) => e.type === 'HIT').length;
  const misses = events.filter((e) => e.type === 'MISS').length;
  const sets = events.filter((e) => e.type === 'SET').length;
  const deletes = events.filter((e) => e.type === 'DELETE').length;
  const invalidations = events.filter((e) => e.type === 'INVALIDATE').length;
  const revalidations = events.filter((e) => e.type === 'REVALIDATE').length;

  const total = hits + misses;
  const hitRate = total > 0 ? `${((hits / total) * 100).toFixed(2)}%` : 'N/A';

  return {
    hits,
    misses,
    sets,
    deletes,
    invalidations,
    revalidations,
    hitRate,
    totalEvents: events.length,
  };
}

export async function GET() {
  const events = getEvents();
  const stats = getCacheStats();

  return NextResponse.json({
    stats,
    events: events.slice(0, 50), // Return last 50 events
    timestamp: new Date().toISOString(),
  });
}

export async function DELETE() {
  (globalThis as Record<string, unknown>).cacheEvents = [];
  (globalThis as Record<string, unknown>).cacheEventCounter = 0;

  return NextResponse.json({
    success: true,
    message: 'Cache events cleared',
    timestamp: new Date().toISOString(),
  });
}
