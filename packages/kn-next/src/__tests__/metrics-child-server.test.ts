/**
 * metrics.ts — the child↔supervisor scrape bridge + the runtime singleton.
 *  - startChildMetricsServer serves /metrics (running the onScrape hook first,
 *    fail-open on a throwing hook) and 404s everything else,
 *  - fetchChildMetrics round-trips the body over localhost and returns "" on a
 *    non-200 / connection error,
 *  - initRuntimeMetrics is idempotent and can seed prom-client defaults.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import http from "node:http";
import { Counter, Registry } from "prom-client";
import {
    CHILD_METRICS_PORT,
    fetchChildMetrics,
    getRuntimeMetrics,
    initRuntimeMetrics,
    resetRuntimeMetrics,
    startChildMetricsServer,
} from "../adapters/metrics";

const servers: http.Server[] = [];
function track<T extends http.Server>(s: T): T {
    servers.push(s);
    return s;
}
function port(s: http.Server): number {
    return (s.address() as { port: number }).port;
}
async function ready(s: http.Server): Promise<http.Server> {
    if (s.listening) return s;
    await new Promise((r) => s.once("listening", r));
    return s;
}

afterEach(async () => {
    await Promise.all(
        servers
            .splice(0)
            .map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    resetRuntimeMetrics();
    jest.restoreAllMocks();
});

function registryWith(name = "test_counter"): Registry {
    const reg = new Registry();
    new Counter({ name, help: "h", registers: [reg] }).inc();
    return reg;
}

describe("startChildMetricsServer + fetchChildMetrics", () => {
    it("round-trips the registry exposition over localhost", async () => {
        const reg = registryWith();
        const srv = await ready(
            track(startChildMetricsServer(reg, 0, "127.0.0.1")),
        );
        const body = await fetchChildMetrics(port(srv), "127.0.0.1");
        expect(body).toContain("test_counter");
    });

    it("runs the onScrape hook before serving and is fail-open on a throwing hook", async () => {
        const reg = registryWith();
        const good = mock(async () => {});
        const srvGood = await ready(
            track(startChildMetricsServer(reg, 0, "127.0.0.1", good)),
        );
        expect(await fetchChildMetrics(port(srvGood), "127.0.0.1")).toContain(
            "test_counter",
        );
        expect(good).toHaveBeenCalled();

        const bad = mock(async () => {
            throw new Error("scrape hook boom");
        });
        const srvBad = await ready(
            track(startChildMetricsServer(reg, 0, "127.0.0.1", bad)),
        );
        // Still serves the base registry despite the hook throwing.
        expect(await fetchChildMetrics(port(srvBad), "127.0.0.1")).toContain(
            "test_counter",
        );
    });

    it("404s any non-/metrics request", async () => {
        const srv = await ready(
            track(startChildMetricsServer(registryWith(), 0, "127.0.0.1")),
        );
        const status = await new Promise<number>((resolve) => {
            http.get(
                { host: "127.0.0.1", port: port(srv), path: "/nope" },
                (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                },
            );
        });
        expect(status).toBe(404);
    });

    it("fetchChildMetrics returns '' on a non-200 response", async () => {
        const srv = await ready(
            track(
                http
                    .createServer((_req, res) => {
                        res.writeHead(500);
                        res.end("nope");
                    })
                    .listen(0, "127.0.0.1"),
            ),
        );
        expect(await fetchChildMetrics(port(srv), "127.0.0.1")).toBe("");
    });

    it("fetchChildMetrics returns '' when nothing is listening", async () => {
        // Reserve then close a port to guarantee a refused connect.
        const srv = await ready(
            track(http.createServer().listen(0, "127.0.0.1")),
        );
        const p = port(srv);
        await new Promise<void>((r) => srv.close(() => r()));
        servers.pop();
        expect(await fetchChildMetrics(p, "127.0.0.1")).toBe("");
    });

    it("exposes a default child metrics port constant", () => {
        expect(typeof CHILD_METRICS_PORT).toBe("number");
    });

    // The child's listener (this constant) and deep-health-lite's listener
    // must agree on the port, or the supervisor scrapes one and misses the
    // other. Both now go through resolveLitePort, so an unusable value falls
    // back to 9092 for both rather than NaN/0 here and 9092 there.
    it.each([
        ["9100", 9100],
        ["junk", 9092],
        ["", 9092],
        ["0", 9092],
        ["70000", 9092],
        ["65535", 65535],
        ["65536", 9092],
        ["-1", 9092],
        // parseInt reads the leading integer: these are accepted, as in
        // deep-health-lite and the runtime-contract copies.
        ["9100abc", 9100],
        ["1.5", 1],
        // Radix 10, so hex is not read as hex; Number() read these as 26 and 1000.
        ["0x1A", 9092],
        ["1e3", 1],
        [" 9100", 9100],
        ["+9100", 9100],
        [undefined, 9092],
    ])("KN_CHILD_METRICS_PORT=%p resolves to %p, as deep-health-lite does", (raw, want) => {
        const env: Record<string, string> = { ...process.env } as Record<
            string,
            string
        >;
        delete env.KN_CHILD_METRICS_PORT;
        if (raw !== undefined) env.KN_CHILD_METRICS_PORT = raw;
        const out = Bun.spawnSync({
            cmd: [
                process.execPath,
                "-e",
                `const m = require(${JSON.stringify(require.resolve("../adapters/metrics"))});
                 const l = require(${JSON.stringify(require.resolve("../adapters/deep-health-lite"))});
                 console.log(JSON.stringify([m.CHILD_METRICS_PORT, l.resolveLitePort()]));`,
            ],
            env,
        });
        expect(out.exitCode).toBe(0);
        expect(JSON.parse(out.stdout.toString().trim())).toEqual([want, want]);
    });
});

describe("the child listener binds the port KN_CHILD_METRICS_PORT names", () => {
    it("startChildMetricsServer and fetchChildMetrics with no port argument meet on it", async () => {
        const free = await new Promise<number>((r) => {
            const s = http.createServer().listen(0, "127.0.0.1", () => {
                const p = (s.address() as { port: number }).port;
                s.close(() => r(p));
            });
        });
        const env: Record<string, string> = {
            ...process.env,
            KN_CHILD_METRICS_PORT: String(free),
        } as Record<string, string>;
        const out = Bun.spawnSync({
            cmd: [
                process.execPath,
                "-e",
                `const { Counter, Registry } = require(${JSON.stringify(require.resolve("prom-client"))});
                 const m = require(${JSON.stringify(require.resolve("../adapters/metrics"))});
                 const reg = new Registry();
                 new Counter({ name: "knext_child_port_probe_total", help: "probe", registers: [reg] }).inc();
                 const server = m.startChildMetricsServer(reg);
                 server.once("listening", async () => {
                   const body = await m.fetchChildMetrics();
                   console.log(JSON.stringify([server.address().port, body.includes("knext_child_port_probe_total 1")]));
                   server.close();
                 });`,
            ],
            env,
        });
        expect(out.exitCode, out.stderr.toString()).toBe(0);
        expect(JSON.parse(out.stdout.toString().trim())).toEqual([free, true]);
    });
});

describe("initRuntimeMetrics singleton", () => {
    it("is idempotent and returns the same instance", () => {
        const reg = new Registry();
        const first = initRuntimeMetrics(reg, "app-a");
        const second = initRuntimeMetrics(new Registry(), "app-b");
        expect(second).toBe(first);
        expect(getRuntimeMetrics()).toBe(first);
    });

    it("seeds prom-client default metrics when asked", async () => {
        const reg = new Registry();
        initRuntimeMetrics(reg, "app-c", true);
        expect(await reg.metrics()).toContain("process_cpu");
    });

    it("getRuntimeMetrics is undefined after reset", () => {
        initRuntimeMetrics(new Registry(), "app-d");
        resetRuntimeMetrics();
        expect(getRuntimeMetrics()).toBeUndefined();
    });
});
