import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";
import {
    clearExitReportsForTests,
    runExitReports,
} from "../adapters/cache-write-registry.js";
import {
    createUseCacheHandler,
    type UseCacheCore,
} from "../adapters/use-cache-handler.js";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * #2384: an outage-replay backlog a process exits with is lost (the lists are
 * per process), and before this nothing said so. Now the process logs one line
 * per handler with what it loses, and the 'use cache' handler counts it.
 *
 * The report runs from the process `exit` listener the registry installs. Each
 * case asserts that listener is installed and calls exactly it.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";
const COUNTERS = Symbol.for("knext.cache.useCache.counters");
const COOLDOWN_MS = 60_000;

// biome-ignore lint/suspicious/noExplicitAny: the handler modules are untyped plain JS
type Any = any;
const g = globalThis as Record<symbol, Any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function exitLines(): string[] {
    return (
        console.error as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("exiting with"));
}

/** Run the exit listener the registry installed, as a real exit would. */
function exitNow() {
    expect(process.listeners("exit")).toContain(runExitReports);
    runExitReports();
}

beforeEach(() => {
    clearExitReportsForTests();
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    clearExitReportsForTests();
    jest.restoreAllMocks();
});

describe("ISR handler: exiting with an invalidation backlog", () => {
    const original = { ...process.env };
    let fake: FakeRedis | undefined;
    let gen = 0;
    let failGets = false;

    afterEach(async () => {
        await fake?.close();
        fake = undefined;
        process.env = { ...original };
    });

    async function handler(): Promise<Any> {
        gen += 1;
        process.env.REDIS_KEY_PREFIX = "exitrep";
        process.env.REDIS_RETRY_COOLDOWN_MS = String(COOLDOWN_MS);
        fake = await startFakeRedis({
            errorFor: (cmd) => (failGets && cmd === "get" ? "boom" : undefined),
        });
        process.env.REDIS_URL = fake.url;
        const mod = await import(`${CACHE_HANDLER}?exitrep=${gen}`);
        return new mod.default({});
    }

    async function openBreaker(h: Any) {
        failGets = true;
        expect(await h.get("/never", { kind: "APP_PAGE" })).toBeNull();
        failGets = false;
    }

    it("breaker open, two tags recorded, then exit: exactly one line with the count", async () => {
        const h = await handler();
        await openBreaker(h);
        await h.revalidateTag(["x", "y"]);
        exitNow();
        const lines = exitLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("2 tag invalidation(s) and 0 delete(s)");
        expect(lines[0]).toContain("not replayed to Redis");
    });

    it("breaker open, one delete recorded, then exit: exactly one line with the count", async () => {
        const h = await handler();
        await openBreaker(h);
        await h.set("/gone", null, {});
        exitNow();
        const lines = exitLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("0 tag invalidation(s) and 1 delete(s)");
    });

    it("nothing recorded: the exit logs nothing", async () => {
        const h = await handler();
        await h.get("/p", { kind: "APP_PAGE" });
        exitNow();
        expect(exitLines()).toEqual([]);
    });

    it("no Redis configured: nothing is recorded, so the exit logs nothing", async () => {
        delete process.env.REDIS_URL;
        gen += 1;
        const mod = await import(`${CACHE_HANDLER}?exitrep-mem=${gen}`);
        const h = new mod.default({});
        await h.revalidateTag("x");
        runExitReports();
        expect(exitLines()).toEqual([]);
    });
});

describe("'use cache' handler: exiting with a tag-stamp backlog", () => {
    function core(opts: { open: boolean; configured?: boolean }): UseCacheCore {
        return {
            ensureConnected: async () => (opts.open ? null : {}),
            redisCall: async <T>(fn: () => Promise<T>) => fn(),
            command: async () => null,
            keyPrefix: () => "p",
            buildId: () => undefined,
            redisConfigured: () => opts.configured ?? true,
            retryInMs: () => COOLDOWN_MS,
        } as UseCacheCore;
    }

    const lost = () => Number(g[COUNTERS]?.tagsLostAtExit ?? 0);

    it("breaker open, two tags dropped, then exit: one line and the count goes up by two", async () => {
        const h = createUseCacheHandler({
            kind: "default",
            core: core({ open: true }),
        });
        const before = lost();
        await h.updateTags(["a", "b"]);
        exitNow();
        const lines = exitLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("2 tag stamp(s) of 'use cache'");
        expect(lost() - before).toBe(2);
    });

    it("no Redis configured: no line and no count", async () => {
        const h = createUseCacheHandler({
            kind: "default",
            core: core({ open: true, configured: false }),
        });
        const before = lost();
        await h.updateTags(["a"]);
        runExitReports();
        expect(exitLines()).toEqual([]);
        expect(lost()).toBe(before);
    });

    it("a backlog replayed before the exit is not reported", async () => {
        const c = { open: true };
        const h = createUseCacheHandler({ kind: "default", core: core(c) });
        await h.updateTags(["a"]);
        c.open = false;
        // The first call that finds the breaker closed starts the replay.
        await h.getExpiration(["z"]);
        await sleep(50);
        runExitReports();
        expect(exitLines()).toEqual([]);
    });
});
