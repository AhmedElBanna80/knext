/**
 * Spawned-server specs flaked with `server exited before ready (code=0
 * signal=null)` and an empty server log.
 *
 * Cause: the Nitro node/bun server (srvx) starts with `this.serve().catch(() =>
 * {})`, so an EADDRINUSE on listen is swallowed. Nothing is left keeping the
 * event loop alive and the process exits 0, printing nothing. The specs chose
 * their port as `20000 + random * 20000`: 36% of that range is the Linux
 * ephemeral range (32768-60999), where any outbound socket (a package fetch,
 * a build step) may hold the port. Both failing ports in CI were in it
 * (35728, 35638).
 *
 * Two guards: specs pick ports with `pickServerPort` (below the ephemeral range,
 * verified bindable), and a silent exit is diagnosed with the port's state
 * rather than reported as a bare "code=0".
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { pickServerPort } from "./helpers/free-port";
import { waitForHttpOk } from "./helpers/wait-for-http-ok";

const holders: Server[] = [];
afterEach(() => {
    for (const h of holders.splice(0)) h.close();
});

/** Hold a port the way another process's listener or outbound socket would. */
function hold(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const s = createServer();
        holders.push(s);
        s.once("error", reject);
        s.listen({ port, host: "::" }, () => resolve());
    });
}

const rejection = (p: Promise<unknown>) =>
    p.then(
        () => undefined,
        (e: Error) => e,
    );

describe("pickServerPort", () => {
    it("never picks from the Linux ephemeral range, where outbound sockets live", async () => {
        for (const r of [0, 0.5, 0.999999]) {
            const port = await pickServerPort({ random: () => r });
            expect(port).toBeGreaterThanOrEqual(20000);
            expect(port).toBeLessThan(32768);
        }
    });

    it("skips a port that is already held and takes the next free draw", async () => {
        // Two distinct, in-range draws: the first is occupied, the second free.
        const draws = [0.1, 0.1, 0.7];
        const busy = Math.floor(20000 + 0.1 * (32768 - 20000));
        await hold(busy);
        const port = await pickServerPort({
            random: () => draws.shift() ?? 0.7,
        });
        expect(port).not.toBe(busy);
        expect(draws.length).toBeLessThanOrEqual(1);
    });

    it("does not hand the same port out twice in one process", async () => {
        const first = await pickServerPort({ random: () => 0.33 });
        const second = await pickServerPort({
            random: (() => {
                const seq = [0.33, 0.34];
                return () => seq.shift() ?? 0.35;
            })(),
        });
        expect(second).not.toBe(first);
    });

    it("gives up loudly after bounded attempts instead of looping", async () => {
        const err = await rejection(
            pickServerPort({
                random: () => 0.2,
                attempts: 3,
                isFree: async () => false,
            }),
        );
        expect(err?.message).toMatch(/no free port/);
    });
});

describe("silent exit diagnosis", () => {
    // A server that swallows its own listen error, as srvx does: when the
    // port is taken it has no handles left and exits 0 with no output.
    const swallowListenError = (port: number) =>
        spawn(
            "node",
            [
                "-e",
                `const s=require("net").createServer();s.on("error",()=>{});s.listen({port:${port},host:"::"})`,
            ],
            { stdio: "ignore" },
        );

    async function run(port: number) {
        const child = swallowListenError(port);
        let exited: string | null = null;
        child.on("exit", (code, signal) => {
            exited = `code=${code} signal=${signal}`;
        });
        try {
            return await rejection(
                waitForHttpOk(`http://127.0.0.1:${port}/`, {
                    deadlineMs: 20_000,
                    intervalMs: 50,
                    log: () => "",
                    exited: () => exited,
                }),
            );
        } finally {
            child.kill("SIGKILL");
        }
    }

    it("a swallowed EADDRINUSE says the port is held by another process", async () => {
        const port = await pickServerPort();
        await hold(port);
        const err = await run(port);
        expect(err?.message).toContain("server exited before ready (code=0");
        expect(err?.message).toContain(
            `port ${port} is held by another process`,
        );
        // The holder accepts the probe and never answers it, so the exit is
        // seen only once the 5 s probe times out.
    }, 30_000);

    it("a silent exit on a free port does not claim a collision", async () => {
        const port = await pickServerPort();
        // Free port: the child listens fine, so make it exit by faking the
        // exit state instead of racing a real server.
        const err = await rejection(
            waitForHttpOk(`http://127.0.0.1:${port}/`, {
                deadlineMs: 5_000,
                intervalMs: 10,
                log: () => "",
                exited: () => "code=0 signal=null",
            }),
        );
        expect(err?.message).toContain("printed no output");
        expect(err?.message).toContain(`port ${port} is free now`);
        expect(err?.message).not.toContain("held by another process");
    });

    it("keeps the server log when there is one, with no silent-exit hint", async () => {
        const port = await pickServerPort();
        const err = await rejection(
            waitForHttpOk(`http://127.0.0.1:${port}/`, {
                deadlineMs: 5_000,
                intervalMs: 10,
                log: () => "boom: something real\n",
                exited: () => "code=1 signal=null",
            }),
        );
        expect(err?.message).toContain("--- server output ---");
        expect(err?.message).toContain("boom: something real");
        expect(err?.message).not.toContain("printed no output");
    });
});

describe("spawned-server specs choose ports safely", () => {
    const specs = [
        "vinext-nitro-public-files.test.ts",
        "vinext-styled-jsx-single-react.test.ts",
        "vinext-image-loaderfile.test.ts",
    ];
    for (const spec of specs) {
        it(`${spec} uses pickServerPort, not a bare random port`, () => {
            const src = readFileSync(join(import.meta.dir, spec), "utf8");
            expect(src).toContain("pickServerPort(");
            expect(src).not.toMatch(/Math\.random\(\)\s*\*\s*20000/);
        });
    }
});
