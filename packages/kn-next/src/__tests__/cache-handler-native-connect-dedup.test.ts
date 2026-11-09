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
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        process.env.REDIS_RETRY_COOLDOWN_MS = "60000";
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
});
