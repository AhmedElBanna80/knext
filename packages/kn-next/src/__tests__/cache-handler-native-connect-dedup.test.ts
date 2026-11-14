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
 * #2887: on the native (Bun) client, concurrent cache calls that start before
 * the first connect settles each called `client.connect()`. The ioredis path
 * already shares one in-flight connect; the native path now does too.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";

// biome-ignore lint/suspicious/noExplicitAny: the handler module is untyped plain JS
type Any = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("native Redis connect is shared by concurrent callers (#2887)", () => {
    const original = { ...process.env };

    beforeEach(() => {
        process.env.REDIS_KEY_PREFIX = "native-dedup";
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

    function slowNativeClient(connectMs: number) {
        const calls = { connect: 0, get: 0 };
        // Native shape (no `.on`): connect() settles after a delay.
        const client: Any = {
            connected: false,
            connect: async () => {
                calls.connect += 1;
                await sleep(connectMs);
                client.connected = true;
            },
            get: async () => {
                calls.get += 1;
                return null;
            },
            send: async () => null,
            close: () => {},
        };
        return { client, calls };
    }

    it("five concurrent first reads dial once", async () => {
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        const { client, calls } = slowNativeClient(50);
        mod.__setRedisClientForTests(client);
        const handler = new mod.default({});
        const reads = await Promise.all(
            ["/a", "/b", "/c", "/d", "/e"].map((k) => handler.get(k)),
        );
        expect(reads).toEqual([null, null, null, null, null]);
        expect(calls.connect).toBe(1);
        // Every caller still reached Redis once the shared connect settled.
        expect(calls.get).toBe(5);
    });

    it("a failed shared connect is not retried by the callers that waited on it", async () => {
        process.env.REDIS_RETRY_COOLDOWN_MS = "60000";
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        let connects = 0;
        const client: Any = {
            connected: false,
            connect: async () => {
                connects += 1;
                await sleep(30);
                throw new Error("ECONNREFUSED");
            },
            get: async () => null,
            send: async () => null,
            close: () => {},
        };
        mod.__setRedisClientForTests(client);
        const handler = new mod.default({});
        const reads = await Promise.all(
            ["/a", "/b", "/c"].map((k) => handler.get(k)),
        );
        expect(reads).toEqual([null, null, null]);
        expect(connects).toBe(1);
    });

    it("a client swapped out during its connect is not handed out, and the new client's connect is shared", async () => {
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        const oldC = slowNativeClient(80);
        mod.__setRedisClientForTests(oldC.client);
        const handler = new mod.default({});
        // A starts on the old client, which is still connecting.
        const a = handler.get("/a");
        await sleep(10);
        // The client is replaced while that connect is pending.
        const newC = slowNativeClient(40);
        mod.__setRedisClientForTests(newC.client);
        const b = handler.get("/b");
        const c = handler.get("/c");
        expect(await Promise.all([a, b, c])).toEqual([null, null, null]);
        // The old client finished connecting but was never used for a read.
        expect(oldC.calls.get).toBe(0);
        // The new client dialled once for both callers, and served both.
        expect(newC.calls.connect).toBe(1);
        expect(newC.calls.get).toBe(2);
    });

    it("an old connect that settles late does not clear the new client's pending connect", async () => {
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        const oldC = slowNativeClient(30);
        mod.__setRedisClientForTests(oldC.client);
        const handler = new mod.default({});
        const a = handler.get("/a");
        await sleep(10);
        const newC = slowNativeClient(120);
        mod.__setRedisClientForTests(newC.client);
        const b = handler.get("/b");
        // The old connect settles at ~30 ms; the new one is still pending.
        await sleep(40);
        const c = handler.get("/c");
        expect(await Promise.all([a, b, c])).toEqual([null, null, null]);
        expect(newC.calls.connect).toBe(1);
    });
});
