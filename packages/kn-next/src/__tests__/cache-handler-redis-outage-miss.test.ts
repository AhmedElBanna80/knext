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
 * #2122: during a Redis outage, ISR misses instead of serving pod memory.
 *
 * A pod's in-memory store never sees an invalidation another pod processed
 * through Redis, so serving it during an outage can keep a revalidated page on
 * that pod. The 'use cache' handler already misses on an outage; ISR now does
 * the same. With Redis configured but unreachable, `set` writes nothing locally
 * and `get` returns null, so Next re-renders from origin.
 *
 * With NO Redis configured (local dev), the in-memory store is the cache, and it
 * keeps working: that is not an outage.
 */
describe("ISR on a Redis outage: miss, never a pod-local entry (#2122)", () => {
    const original = { ...process.env };
    // A closed port: every connection is refused, so the breaker trips.
    const DEAD_REDIS_URL = "redis://127.0.0.1:6391";
    const CACHE_HANDLER: string = "../adapters/cache-handler.js";
    const PAGE = { kind: "PAGE", html: "<p>old</p>" };

    async function freshHandler(env: Record<string, string | undefined>) {
        process.env.KNEXT_CACHE_REDIS_CLIENT = "ioredis";
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        const mod = await import(CACHE_HANDLER);
        mod.__resetEnvForTests();
        return new mod.default({});
    }

    beforeEach(() => {
        spyOn(console, "error").mockImplementation(() => {});
        spyOn(console, "warn").mockImplementation(() => {});
        spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        process.env = { ...original };
        jest.restoreAllMocks();
    });

    it("Redis configured but down: a set then get is a miss, not the pod-local entry", async () => {
        const handler = await freshHandler({
            REDIS_URL: DEAD_REDIS_URL,
            REDIS_KEY_PREFIX: "outage-app",
        });
        await handler.set("/isr/page", PAGE, { revalidate: 30 });
        expect(await handler.get("/isr/page")).toBeNull();
    });

    it("Redis configured but down: an image entry is a miss too", async () => {
        const handler = await freshHandler({
            REDIS_URL: DEAD_REDIS_URL,
            REDIS_KEY_PREFIX: "outage-app",
        });
        const image = {
            kind: "IMAGE",
            etag: "e1",
            buffer: Buffer.from("png-bytes"),
            extension: "png",
        };
        await handler.set("/_next/image?url=/a.png&w=64&q=75", image, {
            revalidate: 30,
        });
        expect(
            await handler.get("/_next/image?url=/a.png&w=64&q=75"),
        ).toBeNull();
    });

    it("Redis configured but down: an entry already in pod memory is not served", async () => {
        // Written while no Redis was configured, so it sits in this process's
        // memory store; then the process is pointed at a Redis that is down.
        const dev = await freshHandler({
            REDIS_URL: undefined,
            REDIS_KEY_PREFIX: undefined,
        });
        await dev.set("/isr/held", PAGE, { revalidate: 30 });
        expect(await dev.get("/isr/held")).not.toBeNull();
        const down = await freshHandler({
            REDIS_URL: DEAD_REDIS_URL,
            REDIS_KEY_PREFIX: "outage-app",
        });
        expect(await down.get("/isr/held")).toBeNull();
    });

    it("no Redis configured (local dev): the in-memory store still serves", async () => {
        const handler = await freshHandler({
            REDIS_URL: undefined,
            REDIS_KEY_PREFIX: undefined,
        });
        await handler.set("/isr/page", PAGE, { revalidate: 30 });
        const got = await handler.get("/isr/page");
        expect(got).not.toBeNull();
        expect(got?.value?.kind).toBe("PAGE");
    });
});
