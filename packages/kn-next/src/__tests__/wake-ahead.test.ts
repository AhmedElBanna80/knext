/**
 * Wake-ahead primer (ADR-0066 D3, #2054).
 *
 * 1. The binding contract, against the operator's own fixture
 *    (packages/kn-next-operator/internal/controller/testdata/zone-binding-env.json):
 *    the env the operator renders resolves to exactly the bound functions that
 *    did not opt out, each at its `<NAME>_SERVICE_URL`. The Go test asserts
 *    the operator renders that env; changing either side alone reds one of them.
 * 2. The primer contract: never throws, never blocks, bounded by a timeout,
 *    cancelled by the shared primer signal, switched off by KNEXT_WAKE_AHEAD=0.
 * 3. A real process: a wake-ahead aimed at a function that never answers
 *    delays neither the first `/healthz` nor the SIGTERM drain.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";

const ADAPTERS = resolve(__dirname, "..", "adapters");
const WAKE_AHEAD = resolve(ADAPTERS, "wake-ahead.cjs");
const PRIMERS = resolve(ADAPTERS, "process-start-primers.cjs");

type WakeDeps = {
    env?: Record<string, string | undefined>;
    fetch?: (
        url: string,
        init: { method: string; signal: AbortSignal },
    ) => Promise<unknown>;
    warn?: (message: string) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wake = require(WAKE_AHEAD) as {
    WAKE_FUNCTIONS_ENV: string;
    PRIMER_ABORT_KEY: symbol;
    urlEnvFor: (name: string) => string;
    wakeTargets: (env: Record<string, string | undefined>) => {
        targets: Array<{ name: string; url: string }>;
        missing: string[];
    };
    wakeUrl: (base: string) => string;
    wakeAheadNow: (deps?: WakeDeps) => Promise<void>[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const primers = require(PRIMERS) as {
    PROCESS_START_PRIMERS: readonly string[];
    PRIMER_ABORT_KEY_NAME: string;
};
const PRIMER_ABORT_KEY = Symbol.for(primers.PRIMER_ABORT_KEY_NAME);

interface FixtureBinding {
    name: string;
    service: string;
    state: string;
    wakeAhead: boolean;
}
const FIXTURE = JSON.parse(
    readFileSync(
        resolve(
            __dirname,
            "..",
            "..",
            "..",
            "kn-next-operator",
            "internal",
            "controller",
            "testdata",
            "zone-binding-env.json",
        ),
        "utf8",
    ),
) as {
    namespace: string;
    cases: {
        name: string;
        bindings: FixtureBinding[];
        env: Record<string, string>;
    }[];
};

describe("wake-ahead reads the binding env the operator renders", () => {
    it("covers several cases", () => {
        expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(4);
    });

    for (const c of FIXTURE.cases) {
        it(c.name, () => {
            const { targets, missing } = wake.wakeTargets(c.env);
            const want = c.bindings
                .filter((b) => b.state === "Bound" && b.wakeAhead)
                .map((b) => ({
                    name: b.name,
                    url: `http://${b.service}.${FIXTURE.namespace}.svc.cluster.local`,
                }));
            expect(
                [...targets].sort((a, b) => a.name.localeCompare(b.name)),
            ).toEqual(want.sort((a, b) => a.name.localeCompare(b.name)));
            expect(missing).toEqual([]);
        });
    }

    it("derives <NAME>_SERVICE_URL as upper case with - turned to _ (the operator's env keys above pin it)", () => {
        expect(wake.urlEnvFor("a2-b3-c4")).toBe("A2_B3_C4_SERVICE_URL");
        expect(wake.urlEnvFor("user-profile")).toBe("USER_PROFILE_SERVICE_URL");
    });

    it("reads the list variable the operator renders", () => {
        expect(wake.WAKE_FUNCTIONS_ENV).toBe("KNEXT_WAKE_FUNCTIONS");
    });

    it("never scans the env: a *_SERVICE_URL that is not listed is not woken", () => {
        const { targets } = wake.wakeTargets({
            KNEXT_WAKE_FUNCTIONS: "orders",
            ORDERS_SERVICE_URL: "http://orders.shop.svc.cluster.local",
            BILLING_SERVICE_URL: "http://billing.shop.svc.cluster.local",
        });
        expect(targets.map((t) => t.name)).toEqual(["orders"]);
    });

    it("a listed name with no URL is reported, and duplicates and blanks are ignored", () => {
        expect(
            wake.wakeTargets({
                KNEXT_WAKE_FUNCTIONS: " orders,,ghost,orders ",
                ORDERS_SERVICE_URL: "http://orders.shop.svc.cluster.local",
            }),
        ).toEqual({
            targets: [
                { name: "orders", url: "http://orders.shop.svc.cluster.local" },
            ],
            missing: ["ghost"],
        });
    });

    it("sends the wake to /healthz on the binding URL", () => {
        expect(wake.wakeUrl("http://orders.shop.svc.cluster.local")).toBe(
            "http://orders.shop.svc.cluster.local/healthz",
        );
        expect(wake.wakeUrl("http://orders.shop.svc.cluster.local/")).toBe(
            "http://orders.shop.svc.cluster.local/healthz",
        );
    });
});

const ENV = {
    KNEXT_WAKE_FUNCTIONS: "orders,billing",
    ORDERS_SERVICE_URL: "http://orders.shop.svc.cluster.local",
    BILLING_SERVICE_URL: "http://billing.shop.svc.cluster.local",
};

/** A fetch that never settles until its signal aborts. */
function hangingFetch(calls: string[]) {
    return (url: string, init: { method: string; signal: AbortSignal }) => {
        calls.push(`${init.method} ${url}`);
        return new Promise((_resolve, reject) => {
            if (init.signal.aborted) return reject(new Error("aborted"));
            init.signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
            );
        });
    };
}

describe("wake-ahead keeps the primer contract", () => {
    it("returns before any call settles, one GET per listed function", async () => {
        const calls: string[] = [];
        const shared = new AbortController();
        const pending = wake.wakeAheadNow({
            env: ENV,
            fetch: hangingFetch(calls),
            signal: shared.signal,
        });
        expect(pending.length).toBe(2);
        expect(calls).toEqual([]); // nothing has left yet: the calls are detached
        await new Promise((r) => setTimeout(r, 20));
        shared.abort();
        return Promise.all(pending).then(() => {
            expect(calls.sort()).toEqual([
                "GET http://billing.shop.svc.cluster.local/healthz",
                "GET http://orders.shop.svc.cluster.local/healthz",
            ]);
        });
    });

    it("KNEXT_WAKE_AHEAD=0 sends nothing", () => {
        const calls: string[] = [];
        const pending = wake.wakeAheadNow({
            env: { ...ENV, KNEXT_WAKE_AHEAD: "0" },
            fetch: hangingFetch(calls),
        });
        expect(pending).toEqual([]);
        expect(calls).toEqual([]);
    });

    it("an empty or absent list sends nothing", () => {
        const calls: string[] = [];
        expect(
            wake.wakeAheadNow({ env: {}, fetch: hangingFetch(calls) }),
        ).toEqual([]);
        expect(
            wake.wakeAheadNow({
                env: { KNEXT_WAKE_FUNCTIONS: "" },
                fetch: hangingFetch(calls),
            }),
        ).toEqual([]);
        expect(calls).toEqual([]);
    });

    it("an abort before the call leaves sends nothing (a SIGTERM during boot)", async () => {
        const calls: string[] = [];
        const shared = new AbortController();
        const pending = wake.wakeAheadNow({
            env: ENV,
            fetch: hangingFetch(calls),
            signal: shared.signal,
        });
        shared.abort();
        await Promise.all(pending);
        expect(calls).toEqual([]);
    });

    it("the hard timeout ends a call that never answers, without a warning", async () => {
        const warnings: string[] = [];
        const started = Date.now();
        const pending = wake.wakeAheadNow({
            env: ENV,
            fetch: hangingFetch([]),
            signal: new AbortController().signal,
            timeoutMs: 50,
            warn: (m) => warnings.push(m),
        });
        await Promise.all(pending);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(warnings).toEqual([]);
    });

    it("the shared primer signal cancels the calls", async () => {
        const shared = new AbortController();
        const pending = wake.wakeAheadNow({
            env: ENV,
            fetch: hangingFetch([]),
            signal: shared.signal,
            timeoutMs: 60_000,
        });
        await new Promise((r) => setTimeout(r, 20));
        const started = Date.now();
        shared.abort();
        await Promise.all(pending);
        expect(Date.now() - started).toBeLessThan(200);
    });

    it("a failed call is warned about once per process, never retried, never rethrown", async () => {
        const warnings: string[] = [];
        let calls = 0;
        const pending = wake.wakeAheadNow({
            env: ENV,
            fetch: () => {
                calls++;
                return Promise.reject(new Error("connection refused"));
            },
            signal: new AbortController().signal,
            warn: (m) => warnings.push(m),
        });
        await Promise.all(pending);
        expect(calls).toBe(2);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("connection refused");
    });

    it("a fetch that throws synchronously never escapes", async () => {
        const pending = wake.wakeAheadNow({
            env: ENV,
            fetch: () => {
                throw new Error("boom");
            },
            signal: new AbortController().signal,
            warn: () => {},
        });
        await Promise.all(pending);
    });

    it("a listed function with no URL is warned about and skipped", () => {
        const warnings: string[] = [];
        const calls: string[] = [];
        const shared = new AbortController();
        const pending = wake.wakeAheadNow({
            env: { KNEXT_WAKE_FUNCTIONS: "ghost" },
            fetch: hangingFetch(calls),
            signal: shared.signal,
            warn: (m) => warnings.push(m),
        });
        expect(pending).toEqual([]);
        expect(calls).toEqual([]);
        expect(warnings).toEqual([
            '[knext] wake-ahead: no GHOST_SERVICE_URL for bound function "ghost"; skipped',
        ]);
    });

    it("every party uses the one controller key the primer list names", () => {
        const name = primers.PRIMER_ABORT_KEY_NAME;
        expect(name).toBe("knext.runtime.primerAbort");
        expect(wake.PRIMER_ABORT_KEY).toBe(Symbol.for(name));
        const read = (f: string) => readFileSync(resolve(ADAPTERS, f), "utf8");
        // node-server.ts defaults to it before reading the list; the
        // self-contained supervisor aborts it directly.
        expect(read("node-server.ts")).toContain(
            `let primerAbortKey = "${name}";`,
        );
        expect(read("standalone-self-contained-supervisor.cjs")).toContain(
            `globalThis[Symbol.for('${name}')]?.abort()`,
        );
    });

    it("is the primer list's second entry, after the ARP primer", () => {
        expect(primers.PROCESS_START_PRIMERS).toEqual([
            "arp-primer.cjs",
            "wake-ahead.cjs",
        ]);
    });
});

/**
 * A child that does what node-server.ts does: run the primer list first, then
 * serve `/healthz`, and on SIGTERM call abortPrimers() before it closes the
 * server. The bound function is a TCP listener that accepts and never answers,
 * so a wake call that is not cancelled holds the event loop until its timeout.
 */
const CHILD = `
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const http = require("node:http");
const started = Date.now();
const req = createRequire(${JSON.stringify(PRIMERS)});
const primers = req(${JSON.stringify(PRIMERS)});
for (const name of primers.PROCESS_START_PRIMERS) req(resolve(${JSON.stringify(ADAPTERS)}, name));
const server = http.createServer((_q, s) => s.end("ok"));
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port, bootMs: Date.now() - started }) + "\\n");
});
process.on("SIGTERM", () => {
  globalThis[Symbol.for(primers.PRIMER_ABORT_KEY_NAME)]?.abort();
  server.close();
});
`;

function blackhole(): Promise<{ server: Server; url: string }> {
    return new Promise((done) => {
        const sockets: import("node:net").Socket[] = [];
        const server = createServer((s) => sockets.push(s));
        server.on("close", () => {
            for (const s of sockets) s.destroy();
        });
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            done({ server, url: `http://127.0.0.1:${port}` });
        });
    });
}

const RUNTIMES: Array<[string, string]> = [["bun", process.execPath]];
if (Bun.which("node")) RUNTIMES.push(["node", Bun.which("node") as string]);

describe("a wake-ahead at a function that never answers delays nothing", () => {
    for (const [runtime, exe] of RUNTIMES) {
        it(`${runtime}: the first /healthz answers at once, and SIGTERM exits without waiting for the call`, async () => {
            const hole = await blackhole();
            const child = spawn(exe, ["-e", CHILD], {
                env: {
                    ...process.env,
                    KNEXT_ARP_PRIMER: "0",
                    KNEXT_WAKE_FUNCTIONS: "orders",
                    ORDERS_SERVICE_URL: hole.url,
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
            try {
                const ready = await new Promise<{
                    port: number;
                    bootMs: number;
                }>((done, fail) => {
                    let buf = "";
                    child.stdout.on("data", (d) => {
                        buf += d;
                        const nl = buf.indexOf("\n");
                        if (nl >= 0) done(JSON.parse(buf.slice(0, nl)));
                    });
                    child.on("exit", (code) =>
                        fail(
                            new Error(`child exited ${code} before listening`),
                        ),
                    );
                });
                // Not delayed by the wake call, which never settles on its own.
                expect(ready.bootMs).toBeLessThan(500);
                const t0 = Date.now();
                const res = await fetch(
                    `http://127.0.0.1:${ready.port}/healthz`,
                );
                expect(await res.text()).toBe("ok");
                expect(Date.now() - t0).toBeLessThan(500);

                const exited = new Promise<number>((done) =>
                    child.on("exit", () => done(Date.now())),
                );
                const killedAt = Date.now();
                child.kill("SIGTERM");
                // The wake call's own timeout is 1 s; only abortPrimers() gets under it.
                expect((await exited) - killedAt).toBeLessThan(600);
            } finally {
                child.kill("SIGKILL");
                hole.server.close();
            }
        });
    }
});

describe("both SIGTERM handlers cancel the primers before they drain", () => {
    it("node-server.ts: onSignal calls abortPrimers() before gracefulShutdown()", () => {
        const src = readFileSync(resolve(ADAPTERS, "node-server.ts"), "utf8");
        const onSignalAt = src.indexOf(
            "const onSignal = (signal: string) => {",
        );
        expect(onSignalAt).toBeGreaterThan(-1);
        const abortAt = src.indexOf("abortPrimers();", onSignalAt);
        const drainAt = src.indexOf("gracefulShutdown(signal", onSignalAt);
        expect(abortAt).toBeGreaterThan(onSignalAt);
        expect(drainAt).toBeGreaterThan(abortAt);
        // and the key it aborts is the one the list names
        expect(src).toContain(
            "primerAbortKey = primers.PRIMER_ABORT_KEY_NAME;",
        );
    });

    it("the self-contained supervisor aborts the shared controller on SIGTERM", () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sup = require(
            resolve(ADAPTERS, "standalone-self-contained-supervisor.cjs"),
        ) as {
            installDrainHandler: (
                server: { close: (cb: () => void) => void },
                opts: {
                    on: (ev: string, fn: () => void) => void;
                    exit: (c: number) => void;
                    env: Record<string, string>;
                },
            ) => unknown;
        };
        const key = PRIMER_ABORT_KEY;
        const g = globalThis as Record<symbol, AbortController | undefined>;
        const saved = g[key];
        const controller = new AbortController();
        g[key] = controller;
        try {
            const handlers: Record<string, () => void> = {};
            sup.installDrainHandler(
                { close: () => {} },
                {
                    on: (ev, fn) => (handlers[ev] = fn),
                    exit: () => {},
                    env: { SHUTDOWN_GRACE_MS: "60000" },
                },
            );
            expect(controller.signal.aborted).toBe(false);
            handlers.SIGTERM();
            expect(controller.signal.aborted).toBe(true);
        } finally {
            g[key] = saved;
        }
    });
});
