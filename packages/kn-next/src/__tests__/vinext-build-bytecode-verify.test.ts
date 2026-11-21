/**
 * The vinext x bun compiled executable is proved to carry bytecode by the CLI
 * itself, with the SAME verifier the compiled standalone target uses
 * (`bytecode-exec-verify.mjs`) -- independent of whatever the compile script
 * claims. Both directions: a bytecode artifact passes, a plain one (and a
 * stale/foreign one with no marker) is rejected and removed.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVinextExecutable } from "../cli/vinext-build";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function appWithOutput(): string {
    const cwd = mkdtempSync(join(tmpdir(), "knext-vinext-bc-"));
    tempDirs.push(cwd);
    writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({ name: "app", type: "module" }),
    );
    mkdirSync(join(cwd, ".output", "server"), { recursive: true });
    writeFileSync(join(cwd, ".output", "server", "index.mjs"), "");
    return cwd;
}

function markerOf(argv: readonly string[]): string {
    const i = argv.indexOf("--marker");
    expect(i, "the CLI must hand the compile a marker").toBeGreaterThan(-1);
    return argv[i + 1] as string;
}

const bytecodeArtifact = (m: string) =>
    Buffer.from(
        `ELF…pool:${m}…// @bun @bytecode @bun-esm\n(function(){globalThis.m="${m}";})`,
        "latin1",
    );
const plainArtifact = (m: string) =>
    Buffer.from(
        `ELF…// @bun @bun-esm\n(function(){globalThis.m="${m}";})`,
        "latin1",
    );

function build(read: (marker: string) => Buffer, selfContained = false) {
    const cwd = appWithOutput();
    const argvs: string[][] = [];
    return buildVinextExecutable({
        cwd,
        bunVersion: "1.4.0",
        selfContained,
        skipViteBuild: true,
        run: (argv) => argvs.push([...argv]),
        readArtifact: () => read(markerOf(argvs[argvs.length - 1] as string[])),
    });
}

describe("vinext x bun: the CLI verifies the compiled executable", () => {
    it("accepts an executable that carries bytecode", () => {
        expect(() => build(bytecodeArtifact)).not.toThrow();
    });

    it("REJECTS an executable compiled without bytecode", () => {
        expect(() => build(plainArtifact)).toThrow(/bytecode/i);
    });

    it("REJECTS an executable that lacks the entry marker entirely", () => {
        expect(() => build(() => Buffer.from("ELF no marker here"))).toThrow(
            /marker|bytecode/i,
        );
    });

    it("applies to the self-contained shape too", () => {
        expect(() => build(plainArtifact, true)).toThrow(/bytecode/i);
    });
});
