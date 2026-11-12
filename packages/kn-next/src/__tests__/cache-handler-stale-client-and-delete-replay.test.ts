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
 * #2889:
 * 1. A fault on a client that is no longer current (a slow connect that settles
 *    after a newer client was loaded) must close THAT client, not the current
 *    one, and must not trip the breaker for the current one.
 * 2. A delete (`set(key, null)`) that could not reach Redis, because the breaker
 *    was open or the delete itself faulted, is replayed once Redis is back.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";

// biome-ignore lint/suspicious/noExplicitAny: the handler module is untyped plain JS
type Any = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error("waitFor: timed out");
        await sleep(10);
    }
}

describe("#2889 stale-client fault and delete replay", () => {
    const original = { ...process.env };

    beforeEach(() => {
        process.env.REDIS_KEY_PREFIX = "stale-del";
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

    it("a stale client's failed connect closes that client, not the newer current one, and leaves the breaker closed", async () => {
        process.env.REDIS_RETRY_COOLDOWN_MS = "60000";
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        let oldClosed = 0;
        const oldClient: Any = {
            connected: false,
            connect: async () => {
                await sleep(60);
                throw new Error("ECONNREFUSED");
            },
            get: async () => null,
            close: () => {
                oldClosed += 1;
            },
        };
        let newClosed = 0;
        let newGets = 0;
        const newClient: Any = {
            connected: true,
            connect: async () => {},
            get: async () => {
                newGets += 1;
                return null;
            },
            close: () => {
                newClosed += 1;
            },
        };
        mod.__setRedisClientForTests(oldClient);
        const handler = new mod.default({});
        const a = handler.get("/a");
        await sleep(10);
        mod.__setRedisClientForTests(newClient);
        expect(await a).toBeNull();
        // The stale connect failed after the swap: only the stale client closes.
        expect(oldClosed).toBe(1);
        expect(newClosed).toBe(0);
        // The breaker stayed closed, so the current client still serves.
        await handler.get("/b");
        expect(newGets).toBe(1);
    });

    function recoveringClient() {
        const store = new Map<string, string>();
        const calls = { del: 0 };
        let down = true;
        const client: Any = {
            connected: true,
            connect: async () => {},
            get: async (k: string) => store.get(k) ?? null,
            del: async (k: string) => {
                calls.del += 1;
                if (down) throw new Error("ECONNRESET");
                store.delete(k);
                return 1;
            },
            send: async (cmd: string, args: string[]) => {
                if (down) throw new Error("ECONNRESET");
                if (cmd === "DEL") {
                    for (const k of args) store.delete(k);
                    return args.length;
                }
                if (cmd === "SMEMBERS") return [];
                return null;
            },
            close: () => {},
        };
        return {
            client,
            store,
            calls,
            recover: () => {
                down = false;
            },
        };
    }

    it("a faulting delete is replayed once Redis recovers: the entry does not survive", async () => {
        process.env.REDIS_RETRY_COOLDOWN_MS = "50";
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        const r = recoveringClient();
        r.store.set("stale-del:cache:/page", "{}");
        mod.__setRedisClientForTests(r.client);
        const handler = new mod.default({});
        await handler.set("/page", null, {});
        expect(r.store.has("stale-del:cache:/page")).toBe(true);
        r.recover();
        // A recovered client is installed (the seam also closes the breaker), and
        // the next connection starts the replay, which deletes the entry.
        mod.__setRedisClientForTests(r.client);
        await handler.get("/other");
        await waitFor(() => !r.store.has("stale-del:cache:/page"));
        expect(r.store.has("stale-del:cache:/page")).toBe(false);
    });

    it("a delete while the breaker is open is replayed once Redis is back", async () => {
        process.env.REDIS_RETRY_COOLDOWN_MS = "60000";
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        const r = recoveringClient();
        r.store.set("stale-del:cache:/held", "{}");
        mod.__setRedisClientForTests(r.client);
        const handler = new mod.default({});
        // Trip the breaker with a faulting command.
        await handler.set("/trip", null, {});
        // Breaker open: this delete finds no client at all.
        await handler.set("/held", null, {});
        r.recover();
        // A recovered client is installed (the seam closes the breaker, standing in
        // for the cooldown); the next connection starts the replay.
        mod.__setRedisClientForTests(r.client);
        await handler.get("/x");
        await waitFor(() => !r.store.has("stale-del:cache:/held"));
        expect(r.store.has("stale-del:cache:/held")).toBe(false);
    });

    it("a command fault on a stale client closes only that client and leaves the breaker closed", async () => {
        process.env.REDIS_RETRY_COOLDOWN_MS = "60000";
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        let oldClosed = 0;
        const oldClient: Any = {
            connected: true,
            connect: async () => {},
            get: async () => {
                await sleep(60);
                throw new Error("ECONNRESET");
            },
            close: () => {
                oldClosed += 1;
            },
        };
        let newClosed = 0;
        let newGets = 0;
        const newClient: Any = {
            connected: true,
            connect: async () => {},
            get: async () => {
                newGets += 1;
                return null;
            },
            close: () => {
                newClosed += 1;
            },
        };
        mod.__setRedisClientForTests(oldClient);
        const handler = new mod.default({});
        const a = handler.get("/a");
        await sleep(10);
        mod.__setRedisClientForTests(newClient);
        expect(await a).toBeNull();
        expect(oldClosed).toBe(1);
        expect(newClosed).toBe(0);
        await handler.get("/b");
        expect(newGets).toBe(1);
    });

    it("with no Redis configured, a delete records nothing to replay", async () => {
        delete process.env.REDIS_URL;
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        const handler = new mod.default({});
        await handler.set("/mem", null, {});
        // A client installed afterwards finds nothing to replay.
        const sent: string[] = [];
        mod.__setRedisClientForTests({
            connected: true,
            connect: async () => {},
            get: async () => null,
            send: async (cmd: string) => {
                sent.push(cmd);
                return null;
            },
            close: () => {},
        });
        await handler.get("/x");
        await sleep(50);
        expect(sent).not.toContain("DEL");
    });
});
