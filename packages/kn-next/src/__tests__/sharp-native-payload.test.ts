/**
 * Which files the sharp shim hashes before it `dlopen`s.
 *
 * The shim verifies every manifest entry it classifies as a native payload.
 * The real libvips file is `libvips-cpp.so.8.18.6`, a multi-part soname; a
 * classifier that only knew `.so.<one number>` silently skipped it. This spec
 * RUNS the real shim against staged trees (a subprocess with `process.dlopen`
 * stubbed), so the classifier is judged by what the shim does, not by its text.
 *
 *   - a tampered file the classifier counts is REFUSED;
 *   - a tampered file it must not count (`foo.so.txt`, `foo.sox`, `foo.so.`,
 *     `README`) is left alone and the shim still loads.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SHIM = join(
    dirname(import.meta.dirname),
    "adapters",
    "sharp-addon-dlopen.mjs",
);

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const sha = (p: string) =>
    createHash("sha256").update(readFileSync(p)).digest("hex");

/** A staged native tree whose manifest lists the addon and one extra file. */
function stage(extraName: string): {
    addon: string;
    extra: string;
    dir: string;
} {
    const dir = mkdtempSync(join(tmpdir(), "knext-sharp-payload-"));
    tempDirs.push(dir);
    const lib = join(dir, "native", "sharp-linux-x64", "lib");
    mkdirSync(lib, { recursive: true });
    const addon = join(lib, "sharp-linux-x64.node");
    writeFileSync(addon, "ADDON BYTES");
    const extra = join(lib, extraName);
    writeFileSync(extra, "EXTRA BYTES");
    writeFileSync(
        join(dir, "native", ".integrity.json"),
        JSON.stringify({
            version: 1,
            algorithm: "sha256",
            packages: {},
            files: {
                "sharp-linux-x64/lib/sharp-linux-x64.node": sha(addon),
                [`sharp-linux-x64/lib/${extraName}`]: sha(extra),
            },
        }),
    );
    return { addon, extra, dir };
}

/** Run the real shim with dlopen stubbed; the shim's path is an argv entry. */
function runShim(
    addon: string,
    dir: string,
): { status: number; stderr: string; stdout: string } {
    const harness = join(dir, "harness.mjs");
    writeFileSync(
        harness,
        "import { pathToFileURL } from 'node:url';\n" +
            "process.dlopen = (m) => { m.exports = { KNEXT_STUB: true }; };\n" +
            "await import(pathToFileURL(process.argv[2]).href);\n" +
            "console.log('DLOPENED');\n",
    );
    const r = spawnSync(process.execPath, [harness, SHIM], {
        encoding: "utf8",
        env: { ...process.env, KNEXT_SHARP_ADDON: addon },
    });
    return {
        status: r.status ?? -1,
        stderr: r.stderr ?? "",
        stdout: r.stdout ?? "",
    };
}

describe("the shim hashes every native payload, including multi-part sonames", () => {
    it.each([
        "libvips-cpp.so.8.18.6",
        "libfoo.so.1.2",
        "libx.so.42",
        "libx.so",
        "libx.dylib",
        "other.node",
    ])("loads an intact %s and REFUSES a tampered one", (name) => {
        const { addon, extra, dir } = stage(name);
        expect(runShim(addon, dir).status).toBe(0);
        writeFileSync(extra, "tampered");
        const r = runShim(addon, dir);
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain("DLOPENED");
        expect(r.stderr).toContain(`sharp-linux-x64/lib/${name}`);
    });

    it.each([
        "foo.so.txt",
        "foo.sox",
        "foo.so.",
        "README",
    ])("does not treat %s as a native payload", (name) => {
        const { addon, extra, dir } = stage(name);
        writeFileSync(extra, "tampered");
        const r = runShim(addon, dir);
        expect(r.stderr).not.toContain("refusing");
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("DLOPENED");
    });
});
