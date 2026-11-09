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

describe("parseWarmPaths", () => {
    it("defaults to the root route", () => {
        expect(parseWarmPaths({})).toEqual(["/"]);
    });
    it("an empty value turns it off", () => {
        expect(parseWarmPaths({ KNEXT_WARM_PATHS: "" })).toEqual([]);
        expect(parseWarmPaths({ KNEXT_WARM_PATHS: "  " })).toEqual([]);
    });
    it("reads a comma list, keeps only absolute paths, and caps the count", () => {
        expect(
            parseWarmPaths({
                KNEXT_WARM_PATHS: " /, /blog ,x,//evil.example/a,/docs",
            }),
        ).toEqual(["/", "/blog", "/docs"]);
        const many = Array.from({ length: 20 }, (_, i) => `/p${i}`).join(",");
        expect(parseWarmPaths({ KNEXT_WARM_PATHS: many })).toHaveLength(8);
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
            const out = await selfWarm({
                port: srv.port,
                paths: ["/", "/blog"],
                log: silent,
            });
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

    it("never throws: a refused port and a non-2xx answer are both reported, not raised", async () => {
        const srv = await server(() => 500);
        const port = srv.port;
        await srv.close();
        const out = await selfWarm({ port, paths: ["/"], log: silent });
        expect(out[0]?.path).toBe("/");
        expect(out[0]?.status).toBeUndefined();
        expect(out[0]?.error).toBeDefined();
    });

    it("gives up on a hung route after its timeout", async () => {
        const s = createServer(() => {
            /* never answers */
        });
        await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
        const port = (s.address() as AddressInfo).port;
        const t0 = Date.now();
        const out = await selfWarm({
            port,
            paths: ["/"],
            log: silent,
            timeoutMs: 100,
        });
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(out[0]?.error).toBeDefined();
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
