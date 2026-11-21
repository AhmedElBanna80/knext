/**
 * A REAL `compile.include`-shape compile (vite build + vinext-compile.mjs on
 * the host, stock Bun), driven through `buildVinextExecutable` exactly as
 * `vinext-compile-og-exec.test.ts` drives the default shape. It proves the
 * CLI's per-shape verifier (`verifyBytecodeModules` over the entry plus every
 * planned module) accepts what Bun REALLY emits for this shape -- a stand-in
 * artifact only proves the author's model of the layout.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVinextExecutable, hostSmokeArch } from "../cli/vinext-build";

const FIXTURE_SRC = join(__dirname, "fixtures", "vinext-bun-og-app");
let buildDir = "";

beforeAll(() => {
    buildDir = mkdtempSync(join(tmpdir(), "knext-vinext-include-build-"));
    cpSync(FIXTURE_SRC, buildDir, { recursive: true });
    const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
        cwd: buildDir,
        timeout: 180_000,
        encoding: "utf-8",
    });
    if (install.status !== 0) {
        throw new Error(
            `fixture 'bun install' failed:\n${install.stdout}\n${install.stderr}`,
        );
    }
    mkdirSync(join(buildDir, "lib"), { recursive: true });
    writeFileSync(join(buildDir, "lib", "one.js"), "export const one = 1;\n");
    writeFileSync(join(buildDir, "lib", "two.js"), "export const two = 2;\n");
}, 240_000);

afterAll(() => {
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

describe("real compile.include compile passes the CLI's per-shape bytecode check", () => {
    it("builds the include shape and keeps the verified binary", () => {
        const prevCwd = process.cwd();
        process.chdir(buildDir);
        try {
            const out = buildVinextExecutable({
                cwd: buildDir,
                arch: hostSmokeArch(),
                outFile: "knext-include-exec",
                include: ["lib/*.js"],
            });
            expect(existsSync(join(buildDir, out))).toBe(true);
        } finally {
            process.chdir(prevCwd);
        }
    }, 240_000);
});
