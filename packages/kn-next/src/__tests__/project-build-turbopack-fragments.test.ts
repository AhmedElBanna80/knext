/**
 * The Bun + turbopackModuleFragments guard lives in `runProjectBuild`, so
 * build, deploy and preview all sit behind it. Real module, temp-dir cwd, the
 * `run` seam stubbed (no mocks of project modules).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectBuild } from "../cli/project-build";
import { adapterBuild, FRAGMENTS_ON } from "./helpers/next-adapter-build";

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-pb-frag-"));
    writeFileSync(
        join(dir, "next.config.ts"),
        "export default { experimental: { turbopackModuleFragments: true } };",
    );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The build stub records the resolved config the way knext's adapter does in
// `modifyConfig` (#2250), so this exercises the real decision path.
const go = (runtimeId: string, builderId: string) => {
    const calls: unknown[] = [];
    const build = adapterBuild(FRAGMENTS_ON);
    const attempt = () =>
        runProjectBuild({
            requireEsm: false,
            cwd: dir,
            runtimeId,
            builderId,
            run: (argv) => {
                calls.push(argv);
                build(argv);
            },
        });
    return { calls, attempt };
};

describe("runProjectBuild guards turbopackModuleFragments on Bun", () => {
    it("refuses bun + turbopack from the resolved config, inside the one build", () => {
        const { calls, attempt } = go("bun", "turbopack");
        expect(attempt).toThrow(/turbopackModuleFragments/);
        expect(calls).toHaveLength(1);
    });
    it("allows node, webpack and vinext, running the build exactly once", () => {
        for (const [r, b] of [
            ["node", "turbopack"],
            ["bun", "webpack"],
            ["bun", "vinext"],
        ] as const) {
            const { calls, attempt } = go(r, b);
            expect(attempt).not.toThrow();
            expect(calls).toHaveLength(1);
        }
    });
});
