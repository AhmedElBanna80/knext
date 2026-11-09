// The cache handler's mutating test seams fail closed on a published
// subpath (design-gate block, sprint close): the harness opts in.
process.env.KNEXT_TEST_SEAMS = "1";

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";

/**
 * #2886: two Redis fault paths that did not trip the breaker.
 *
 * - A native `connect()` that resolves while the client is still disconnected
 *   returned no client WITHOUT `markUnhealthy`, so every following cache call
 *   dialled Redis again: the per-request cost the breaker exists to stop.
 * - `set(key, null)` deleted through a bare `client.del`, outside `redisCall`, so
 *   a fault there left the breaker closed and the next call used the same
 *   faulting client.
 *
 * Each case asserts the breaker is open afterwards: the next call does not
 * touch the client.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";

// biome-ignore lint/suspicious/noExplicitAny: the handler module is untyped plain JS
type Any = any;

describe("Redis fault paths trip the breaker (#2886)", () => {
    const original = { ...process.env };

    beforeEach(() => {
        process.env.REDIS_KEY_PREFIX = "trip-paths";
        process.env.REDIS_RETRY_COOLDOWN_MS = "60000";
        spyOn(console, "error").mockImplementation(() => {});
        spyOn(console, "warn").mockImplementation(() => {});
        spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
        const mod = await import(CACHE_HANDLER);
        mod.__setRedisClientForTests(undefined);
        process.env = { ...original };
        jest.restoreAllMocks();
    });

    async function handlerWith(client: Any): Promise<Any> {
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        mod.__setRedisClientForTests(client);
        return new mod.default({});
    }

    it("a native connect that resolves disconnected trips the breaker: no re-dial on the next call", async () => {
        let connects = 0;
        // Native shape (no `.on`): connect() resolves but the client stays down.
        const client: Any = {
            connected: false,
            connect: async () => {
                connects += 1;
            },
            get: async () => null,
            close: () => {},
        };
        const handler = await handlerWith(client);
        expect(await handler.get("/a")).toBeNull();
        // The first call may dial more than once (the handler's startup connect
        // runs alongside it); what the breaker owes is no dial AFTER it opens.
        const afterFirst = connects;
        expect(afterFirst).toBeGreaterThan(0);
        expect(await handler.get("/b")).toBeNull();
        expect(await handler.get("/c")).toBeNull();
        expect(connects).toBe(afterFirst);
    });

    it("a faulting del in set(key, null) trips the breaker: the next call does not use the client", async () => {
        let gets = 0;
        const client: Any = {
            connected: true,
            connect: async () => {},
            del: async () => {
                throw new Error("ECONNRESET");
            },
            get: async () => {
                gets += 1;
                return null;
            },
            close: () => {},
        };
        const handler = await handlerWith(client);
        await handler.set("/a", null, {});
        await handler.get("/b");
        expect(gets).toBe(0);
    });
});
