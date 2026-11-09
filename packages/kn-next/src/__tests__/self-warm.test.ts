// @vitest-environment node
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
    parseWarmPaths,
    SELF_WARM_HEADER,
    selfWarm,
} from "../adapters/self-warm";

/**
 * Self-warm: once the child is listening, the supervisor requests the app's own
 * first route(s) on loopback. On a cold start the pod waits about half a second
 * for kubelet to report it before any traffic can arrive, so the route loads and
 * renders in that idle window instead of on the first real request.
 */

const silent = { info() {}, warn() {} };

describe("parseWarmPaths (ADR-0042 surface, opt-in in the supervisor)", () => {
    it("is off unless KNEXT_WARM_PATH is set", () => {
        expect(parseWarmPaths({})).toEqual([]);
    });
    it("KNEXT_EAGER_WARM=0 turns it off even with paths set", () => {
        expect(
            parseWarmPaths({ KNEXT_WARM_PATH: "/", KNEXT_EAGER_WARM: "0" }),
        ).toEqual([]);
    });
    it("reads a comma list, keeps only absolute paths, and caps the count", () => {
        expect(
            parseWarmPaths({
                KNEXT_WARM_PATH: " /, /blog ,x,//evil.example/a,/docs",
            }),
        ).toEqual(["/", "/blog", "/docs"]);
        const many = Array.from({ length: 20 }, (_, i) => `/p${i}`).join(",");
        expect(parseWarmPaths({ KNEXT_WARM_PATH: many })).toHaveLength(8);
    });
});

async function server(
    handler: (path: string, headers: Record<string, unknown>) => number,
) {
    const seen: { path: string; warm: unknown }[] = [];
    const s = createServer((req, res) => {
        seen.push({ path: req.url ?? "", warm: req.headers[SELF_WARM_HEADER] });
        res.statusCode = handler(req.url ?? "", req.headers);
        if (res.statusCode >= 300 && res.statusCode < 400)
            res.setHeader("location", "/target");
        res.end("ok");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    return { port, seen, close: () => new Promise((r) => s.close(r)) };
}

describe("selfWarm", () => {
    it("requests each path on loopback, in order, marked with the warm header", async () => {
        const srv = await server(() => 200);
        try {
            const lines: string[] = [];
            const out = await selfWarm({
                port: srv.port,
                paths: ["/", "/blog"],
                log: { info: (_o, m) => lines.push(m), warn() {} },
            });
            // The same log line the vinext entry prints (ADR-0042).
            expect(lines.map((l) => l.replace(/ms=\d+/, "ms=N"))).toEqual([
                "WARMED:/ status=200 ms=N",
                "WARMED:/blog status=200 ms=N",
            ]);
            expect(srv.seen).toEqual([
                { path: "/", warm: "1" },
                { path: "/blog", warm: "1" },
            ]);
            expect(out).toEqual([
                { path: "/", status: 200 },
                { path: "/blog", status: 200 },
            ]);
        } finally {
            await srv.close();
        }
    });

    it("skips the warm-up when the server is not listening yet, without an error", async () => {
        const srv = await server(() => 200);
        const port = srv.port;
        await srv.close();
        const warned: unknown[] = [];
        const out = await selfWarm({
            port,
            paths: ["/"],
            log: { info() {}, warn: (o) => warned.push(o) },
        });
        expect(out).toEqual([]);
        expect(warned).toEqual([]);
    });

    it("reports a non-2xx answer as a status, not an error", async () => {
        const srv = await server(() => 500);
        try {
            const out = await selfWarm({
                port: srv.port,
                paths: ["/"],
                log: silent,
            });
            expect(out).toEqual([{ path: "/", status: 500 }]);
        } finally {
            await srv.close();
        }
    });

    it("stops before the next path once shouldStop() is true (shutdown)", async () => {
        const srv = await server(() => 200);
        try {
            let stop = false;
            const out = await selfWarm({
                port: srv.port,
                paths: ["/a", "/b", "/c"],
                log: {
                    info() {
                        stop = true;
                    },
                    warn() {},
                },
                shouldStop: () => stop,
            });
            expect(out.map((r) => r.path)).toEqual(["/a"]);
            expect(srv.seen.map((x) => x.path)).toEqual(["/a"]);
        } finally {
            await srv.close();
        }
    });

    it("one budget covers the whole warm-up: a hung route does not hold the later ones past it", async () => {
        const s = createServer(() => {
            /* never answers */
        });
        await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
        const port = (s.address() as AddressInfo).port;
        const t0 = Date.now();
        const out = await selfWarm({
            port,
            paths: ["/", "/b", "/c"],
            log: silent,
            timeoutMs: 150,
        });
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(out[0]?.error).toBeDefined();
        // The budget was spent on the first route, so the others were not tried.
        expect(out).toHaveLength(1);
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
    });

    it("does not follow a redirect", async () => {
        const srv = await server((p) => (p === "/" ? 307 : 200));
        try {
            const out = await selfWarm({
                port: srv.port,
                paths: ["/"],
                log: silent,
            });
            expect(out).toEqual([{ path: "/", status: 307 }]);
            expect(srv.seen.map((x) => x.path)).toEqual(["/"]);
        } finally {
            await srv.close();
        }
    });
});

describe("node-server wires self-warm as the FIRST deferred step", () => {
    it("runs before the metrics collector, whose ~790 ms load would otherwise compete with the warm render", () => {
        const src = readFileSync(
            resolve(import.meta.dir, "../adapters/node-server.ts"),
            "utf8",
        );
        const steps = [...src.matchAll(/name:\s*"([a-z-]+)"/g)].map(
            (m) => m[1],
        );
        expect(steps[0]).toBe("self-warm");
        expect(steps).toContain("metrics-collector");
    });
});
