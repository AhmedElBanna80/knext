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
    createUseCacheHandler,
    type UseCacheCore,
} from "../adapters/use-cache-handler.js";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

/**
 * #2384: an outage-replay backlog a process exits with is lost (the lists are
 * per process), and before this nothing said so. Now the process logs one line
 * per handler with what it loses (ADR-0066 Amendment 9).
 *
 * The report runs from the process `exit` listener the registry installs. Each
 * positive case asserts exactly one such listener is installed and calls it.
 */

const CACHE_HANDLER = "../adapters/cache-handler.js";
const REGISTRY: string = "../adapters/cache-write-registry.js";
interface ExitRegistry {
    clearExitReportsForTests(): void;
    exitReportCountForTests(): number;
    runExitReports(): void;
}
const { clearExitReportsForTests, exitReportCountForTests, runExitReports } =
    (await import(REGISTRY)) as ExitRegistry;
const COOLDOWN_MS = 60_000;
const BOUND = 1000;

// biome-ignore lint/suspicious/noExplicitAny: the handler modules are untyped plain JS
type Any = any;
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
    const installed = process
        .listeners("exit")
        .filter((l) => l === runExitReports);
    expect(installed).toHaveLength(1);
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

    async function handler(cooldownMs = COOLDOWN_MS): Promise<Any> {
        gen += 1;
        process.env.REDIS_KEY_PREFIX = "exitrep";
        process.env.REDIS_RETRY_COOLDOWN_MS = String(cooldownMs);
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

    it("breaker open, two tags recorded, then exit: exactly one line with the count and the held-back purge", async () => {
        const h = await handler();
        await openBreaker(h);
        await h.revalidateTag(["x", "y"]);
        exitNow();
        const lines = exitLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("2 tag invalidation(s) and 0 delete(s)");
        expect(lines[0]).toContain("not yet replayed to Redis");
        expect(lines[0]).toContain("edge purge they held back");
    });

    it("breaker open, one delete recorded, then exit: one line, and no edge purge is claimed (deletes hold none back)", async () => {
        const h = await handler();
        await openBreaker(h);
        await h.set("/gone", null, {});
        exitNow();
        const lines = exitLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("0 tag invalidation(s) and 1 delete(s)");
        expect(lines[0]).not.toContain("edge purge");
    });

    it(`breaker open, a collapsed backlog (${BOUND + 1} tags), then exit: one line naming the collapse`, async () => {
        const h = await handler();
        await openBreaker(h);
        await h.revalidateTag(
            Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
        );
        exitNow();
        const lines = exitLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`a collapsed backlog (over ${BOUND} tags)`);
    });

    it("a backlog replayed before the exit is not reported", async () => {
        const h = await handler(100);
        await openBreaker(h);
        await h.revalidateTag("x");
        // The probe fires when the breaker closes and replays the tag.
        await sleep(400);
        const replayed = (
            console.log as unknown as { mock: { calls: unknown[][] } }
        ).mock.calls.some((c) =>
            String(c[0]).includes("INVALIDATE tag:x (redis)"),
        );
        expect(replayed).toBe(true);
        exitNow();
        expect(exitLines()).toEqual([]);
    });

    it("nothing recorded: no reporter is armed and the exit logs nothing", async () => {
        const h = await handler();
        await h.get("/p", { kind: "APP_PAGE" });
        expect(exitReportCountForTests()).toBe(0);
        runExitReports();
        expect(exitLines()).toEqual([]);
    });

    it("no Redis configured: nothing is recorded and no reporter is armed", async () => {
        delete process.env.REDIS_URL;
        gen += 1;
        const mod = await import(`${CACHE_HANDLER}?exitrep-mem=${gen}`);
        const h = new mod.default({});
        await h.revalidateTag("x");
        expect(exitReportCountForTests()).toBe(0);
        runExitReports();
        expect(exitLines()).toEqual([]);
    });
});

describe("'use cache' handler: exiting with a tag backlog", () => {
    function core(opts: { open: boolean; configured?: boolean }) {
        const commands: string[] = [];
        const c = {
            ensureConnected: async () => (opts.open ? null : {}),
            redisCall: async <T>(fn: () => Promise<T>) => fn(),
            command: async (_c: unknown, name: string) => {
                commands.push(name);
                return null;
            },
            keyPrefix: () => "p",
            buildId: () => undefined,
            redisConfigured: () => opts.configured ?? true,
            retryInMs: () => COOLDOWN_MS,
        } as unknown as UseCacheCore;
        return { core: c, commands };
    }

    it("breaker open, two tags dropped, then exit: exactly one line with the count", async () => {
        const { core: c } = core({ open: true });
        const h = createUseCacheHandler({ kind: "default", core: c });
        await h.updateTags(["a", "b"]);
        exitNow();
        const lines = exitLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(
            "2 tag(s) of 'use cache' tag invalidations not yet replayed",
        );
    });

    it(`breaker open, a collapsed backlog (${BOUND + 1} tags), then exit: one line naming the collapse`, async () => {
        const { core: c } = core({ open: true });
        const h = createUseCacheHandler({ kind: "default", core: c });
        await h.updateTags(
            Array.from({ length: BOUND + 1 }, (_, i) => `t${i}`),
        );
        exitNow();
        const lines = exitLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`a collapsed backlog (over ${BOUND} tags)`);
    });

    it("no Redis configured: no reporter is armed and no line", async () => {
        const { core: c } = core({ open: true, configured: false });
        const h = createUseCacheHandler({ kind: "default", core: c });
        await h.updateTags(["a"]);
        expect(exitReportCountForTests()).toBe(0);
        runExitReports();
        expect(exitLines()).toEqual([]);
    });

    it("a backlog replayed before the exit is not reported", async () => {
        const state = { open: true };
        const { core: c, commands } = core(state);
        const h = createUseCacheHandler({ kind: "default", core: c });
        await h.updateTags(["a"]);
        state.open = false;
        // The first call that finds the breaker closed starts the replay.
        await h.getExpiration(["z"]);
        await sleep(50);
        // The replay ran: it wrote the stamps (a script, or a read then write).
        expect(commands.some((n) => n === "EVAL" || n === "HSET")).toBe(true);
        exitNow();
        expect(exitLines()).toEqual([]);
    });
});
