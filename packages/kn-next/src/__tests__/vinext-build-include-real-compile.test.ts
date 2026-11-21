/**
 * A REAL `compile.include`-shape compile (vite build + vinext-compile.mjs on
 * the host, stock Bun), driven through `buildVinextExecutable` exactly as
 * `vinext-compile-og-exec.test.ts` drives the default shape. It proves the
 * CLI's per-shape verifier (`verifyBytecodeModules`, held to the module count
 * the compile script attested in its sidecar) accepts what Bun REALLY emits for
 * this shape -- a stand-in artifact only proves the author's model of the layout.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBytecodeModules } from "../adapters/bytecode-exec-verify.mjs";
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
            // Explicit verdict: the banner marker the script baked in heads the
            // entry plus both included modules, each under @bytecode.
            const bytes = readFileSync(join(buildDir, out));
            const marker = /knext-vinext-exec:[0-9a-f]{24}/.exec(
                bytes.toString("latin1"),
            )?.[0];
            expect(marker, "the marker is found in the binary").toBeDefined();
            expect(verifyBytecodeModules(bytes, marker as string, 3)).toEqual({
                ok: true,
            });
        } finally {
            process.chdir(prevCwd);
        }
    }, 240_000);

    it("a include glob that matches the ENTRY itself fails closed with the script's own message (never a silent mis-count)", () => {
        // The entry is compiled under its own name; planning it a second time
        // as an included module cannot embed it twice, so the script's
        // embedded-path check refuses it BEFORE any count is compared. The CLI
        // surfaces that failure; it does not ship the binary.
        const prevCwd = process.cwd();
        process.chdir(buildDir);
        try {
            expect(() =>
                buildVinextExecutable({
                    cwd: buildDir,
                    arch: hostSmokeArch(),
                    outFile: "knext-include-entry-exec",
                    include: [".output/server/index.mjs"],
                }),
            ).toThrow(/Command failed: bun run .*vinext-compile/);
            expect(existsSync(join(buildDir, "knext-include-entry-exec"))).toBe(
                false,
            );
        } finally {
            process.chdir(prevCwd);
        }
    }, 240_000);
});
