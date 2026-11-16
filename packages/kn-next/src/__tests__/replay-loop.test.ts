import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReplayLoop } from "../adapters/replay-loop.js";

/**
 * The one replay loop the cache runtime runs while a backlog is pending: the
 * ISR invalidation replay (cache-handler.js) and the 'use cache' tag replay
 * (use-cache-handler.js) both drive theirs through it.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(over: Record<string, unknown> = {}) {
    let pending = true;
    let unreachable = false;
    const calls = { run: 0, tracked: 0, unreachable: 0 };
    const errors: unknown[] = [];
    let release: () => void = () => {};
    const loop = createReplayLoop({
        label: "test replay",
        pending: () => pending,
        unreachable: () => unreachable,
        onUnreachable: () => {
            calls.unreachable++;
        },
        retryInMs: () => 5,
        track: (p: Promise<unknown>) => {
            calls.tracked++;
            return p;
        },
        run: () => {
            calls.run++;
            return new Promise<void>((r) => {
                release = r;
            });
        },
        log: (...a: unknown[]) => errors.push(a),
        ...over,
    });
    return {
        loop,
        calls,
        errors,
        release: () => release(),
        setPending: (v: boolean) => {
            pending = v;
        },
        setUnreachable: (v: boolean) => {
            unreachable = v;
        },
    };
}

describe("createReplayLoop", () => {
    it("runs once at a time, and the run is tracked", async () => {
        const h = harness();
        h.loop.start();
        h.loop.start();
        expect(h.calls.run).toBe(1);
        expect(h.calls.tracked).toBe(1);
        h.release();
        await tick();
    });

    it("does nothing when nothing is pending", () => {
        const h = harness();
        h.setPending(false);
        h.loop.start();
        expect(h.calls.run).toBe(0);
    });

    it("probes again after a run while something is still pending", async () => {
        const h = harness();
        h.loop.start();
        h.release();
        await tick();
        expect(h.calls.run).toBe(1);
        await new Promise((r) => setTimeout(r, 20));
        expect(h.calls.run).toBe(2);
        h.setPending(false);
        h.release();
        await new Promise((r) => setTimeout(r, 20));
        expect(h.calls.run).toBe(2);
    });

    it("hands over to onUnreachable instead of probing when the store cannot be reached", async () => {
        const h = harness();
        h.setUnreachable(true);
        h.loop.start();
        h.release();
        await tick();
        expect(h.calls.unreachable).toBe(1);
        await new Promise((r) => setTimeout(r, 20));
        expect(h.calls.run).toBe(1);
    });

    it("a failed run is logged with its label and still probes", async () => {
        const h = harness({
            run: () => Promise.reject(new Error("boom")),
        });
        h.loop.start();
        await tick();
        expect(JSON.stringify(h.errors)).toContain("test replay stopped:");
        expect(JSON.stringify(h.errors)).toContain("boom");
    });

    it("reset drops the run and the pending probe", async () => {
        const h = harness();
        h.loop.start();
        h.release();
        await tick();
        h.loop.reset();
        await new Promise((r) => setTimeout(r, 20));
        expect(h.calls.run).toBe(1);
        h.loop.start();
        expect(h.calls.run).toBe(2);
        h.setPending(false);
        h.release();
        await tick();
    });

    it("both handlers drive their replay through it, with no copy of the loop left", () => {
        const dir = join(
            dirname(fileURLToPath(import.meta.url)),
            "../adapters",
        );
        for (const f of ["cache-handler.js", "use-cache-handler.js"]) {
            const src = readFileSync(join(dir, f), "utf8");
            expect(src, f).toContain("createReplayLoop(");
            expect(src, f).not.toMatch(
                /setTimeout\([^)]*\n?[^)]*start(Invalidation|Tag)Replay/,
            );
            expect(src, f).not.toMatch(/function schedule(Replay|Tag)Probe/);
        }
    });
});
