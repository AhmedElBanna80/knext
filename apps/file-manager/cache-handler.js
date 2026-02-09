/**
 * Next.js Custom CacheHandler — Redis-backed with in-memory fallback
 *
 * Implements the Next.js CacheHandler interface for Knative deployments.
 * When REDIS_URL is set: stores ISR/data cache in Redis for multi-pod consistency.
 * When REDIS_URL is not set: falls back to in-memory Map (dev mode).
 *
 * All operations are logged to global.cacheEvents for the Cache Monitor UI.
 *
 * Reference: https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath
 */

// ─── Cache Event Logger ───

if (!global.cacheEvents) global.cacheEvents = [];
if (!global.cacheEventCounter) global.cacheEventCounter = 0;

const MAX_EVENTS = 200;

function logCacheEvent(type, source, key, options) {
  const event = {
    id: `evt-${++global.cacheEventCounter}`,
    timestamp: new Date().toISOString(),
    type,
    source,
    key,
    ...(options || {}),
  };

  global.cacheEvents.unshift(event);
  if (global.cacheEvents.length > MAX_EVENTS) {
    global.cacheEvents = global.cacheEvents.slice(0, MAX_EVENTS);
  }

  const emoji =
    {
      HIT: "✅",
      MISS: "❌",
      SET: "💾",
      DELETE: "🗑️",
      INVALIDATE: "🔄",
      REVALIDATE: "♻️",
    }[type] || "📝";
  console.log(
    `[Cache ${emoji}] ${type} | ${source} | ${key}${options?.tag ? ` | tag:${options.tag}` : ""}${options?.durationMs ? ` | ${options.durationMs}ms` : ""}`,
  );
}

// ─── Redis Client (lazy, only when REDIS_URL is set) ───

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || "kn-next";

let Redis;
let redis;
let connectPromise;
let useRedis = false;

// Try loading ioredis — gracefully degrade to in-memory if not available
try {
  Redis = require("ioredis");
  useRedis = !!REDIS_URL;
} catch {
  console.log("[CacheHandler] ioredis not available, using in-memory cache");
  useRedis = false;
}

if (useRedis) {
  console.log("[CacheHandler] Using Redis at", REDIS_URL);
} else {
  console.log(
    "[CacheHandler] Using in-memory fallback (no REDIS_URL or ioredis)",
  );
}

// In-memory fallback
const memoryCache = new Map();

function getRedis() {
  if (!redis && Redis && REDIS_URL) {
    redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 5000),
      connectTimeout: 5000,
    });
    redis.on("error", (err) => {
      console.error("[CacheHandler] Redis error:", err.message);
    });
    redis.on("connect", () => {
      console.log("[CacheHandler] Connected to Redis");
    });
  }
  return redis;
}

async function ensureConnected() {
  if (!useRedis) return null;
  const client = getRedis();
  if (!client) return null;
  if (client.status === "ready") return client;
  if (!connectPromise) {
    connectPromise = client.connect().catch((err) => {
      connectPromise = null;
      console.error("[CacheHandler] Redis connect failed:", err.message);
      return null;
    });
  }
  await connectPromise;
  return client.status === "ready" ? client : null;
}

// ─── Key Builders ───

function cacheKey(key) {
  return `${KEY_PREFIX}:cache:${key}`;
}

function tagKey(tag) {
  return `${KEY_PREFIX}:tag:${tag}`;
}

// ─── CacheHandler Class ───

class CacheHandler {
  constructor(options) {
    this.options = options;
    if (useRedis) ensureConnected().catch(() => {});
  }

  async get(key) {
    const startTime = Date.now();
    const source = useRedis ? "redis" : "memory";

    try {
      if (useRedis) {
        const client = await ensureConnected();
        if (client) {
          const data = await client.get(cacheKey(key));
          if (!data) {
            logCacheEvent("MISS", source, key, {
              durationMs: Date.now() - startTime,
            });
            return null;
          }
          const parsed = JSON.parse(data);
          logCacheEvent("HIT", source, key, {
            durationMs: Date.now() - startTime,
          });
          return parsed;
        }
      }

      // In-memory fallback
      const entry = memoryCache.get(key);
      if (!entry) {
        logCacheEvent("MISS", source, key, {
          durationMs: Date.now() - startTime,
        });
        return null;
      }
      logCacheEvent("HIT", source, key, { durationMs: Date.now() - startTime });
      return entry;
    } catch (error) {
      logCacheEvent("MISS", source, key, {
        durationMs: Date.now() - startTime,
        details: `Error: ${error.message}`,
      });
      return null;
    }
  }

  async set(key, data, ctx) {
    const startTime = Date.now();
    const source = useRedis ? "redis" : "memory";

    try {
      if (data === null) {
        if (useRedis) {
          const client = await ensureConnected();
          if (client) await client.del(cacheKey(key));
        }
        memoryCache.delete(key);
        logCacheEvent("DELETE", source, key, {
          durationMs: Date.now() - startTime,
        });
        return;
      }

      const entry = {
        value: data,
        lastModified: Date.now(),
        tags: ctx?.tags || [],
      };

      const ttl = ctx?.revalidate || 3600;

      if (useRedis) {
        const client = await ensureConnected();
        if (client) {
          const pipeline = client.pipeline();
          pipeline.set(cacheKey(key), JSON.stringify(entry), "EX", ttl);
          if (ctx?.tags?.length) {
            for (const tag of ctx.tags) {
              pipeline.sadd(tagKey(tag), key);
            }
          }
          await pipeline.exec();
        }
      } else {
        memoryCache.set(key, entry);
      }

      logCacheEvent("SET", source, key, {
        durationMs: Date.now() - startTime,
        details: `TTL: ${ttl}s, Tags: [${(ctx?.tags || []).join(", ")}]`,
      });
    } catch (error) {
      console.error("[CacheHandler] Error setting cache:", key, error.message);
    }
  }

  async revalidateTag(tags) {
    const startTime = Date.now();
    const tagList = Array.isArray(tags) ? tags : [tags];
    const source = useRedis ? "redis" : "memory";

    try {
      if (useRedis) {
        const client = await ensureConnected();
        if (client) {
          for (const tag of tagList) {
            const tKey = tagKey(tag);
            const keys = await client.smembers(tKey);
            if (keys.length > 0) {
              const pipeline = client.pipeline();
              for (const k of keys) pipeline.del(cacheKey(k));
              pipeline.del(tKey);
              await pipeline.exec();
            }
            logCacheEvent("INVALIDATE", source, `tag:${tag}`, {
              durationMs: Date.now() - startTime,
              details: `Invalidated ${keys.length} keys`,
              tag,
            });
          }
          return;
        }
      }

      // In-memory fallback: iterate and delete matching entries
      for (const tag of tagList) {
        let count = 0;
        for (const [key, value] of memoryCache) {
          if (value.tags?.includes(tag)) {
            memoryCache.delete(key);
            count++;
          }
        }
        logCacheEvent("INVALIDATE", source, `tag:${tag}`, {
          durationMs: Date.now() - startTime,
          details: `Invalidated ${count} keys`,
          tag,
        });
      }
    } catch (error) {
      console.error(
        "[CacheHandler] Error revalidating tags:",
        tagList,
        error.message,
      );
    }
  }

  resetRequestCache() {}
}

module.exports = CacheHandler;
