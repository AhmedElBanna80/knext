/**
 * One implementation of "what version is this CLI", shared by the `version`
 * subcommand, the build-identity stamp and `doctor`.
 *
 * Before, each of the three carried its own `package.json` read with a
 * different failure mode, and two of them swallowed a failure into `"0.0.0"` —
 * which `hashBuildIdentity` then hashed, so an unreadable manifest made every
 * CLI version stamp identically and a stale cached build looked fresh.
 *
 * What is pinned here:
 *   - the walk-up finds `@getknext/core`'s manifest from the `src/cli/` layout,
 *     from the bundled `dist/cli/` bin, and from a `dist/` chunk (the layout
 *     that broke the gRPC dispatcher);
 *   - an unreadable manifest is `undefined`, never `"0.0.0"`;
 *   - build identity fails closed on it;
 *   - the three call sites really import the shared module (a scan, so a
 *     fourth copy cannot reappear in one of them unnoticed).
 *
 * The `version` subcommand printing `unknown` is in `deploy-cli-args.test.ts`;
 * doctor's `unknown` row is in `doctor-operator-version.test.ts`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hashBuildIdentity } from "../cli/build-artifact";
import { coreVersion, readCoreVersion } from "../cli/core-version";

const PKG_JSON = join(import.meta.dir, "..", "..", "package.json");
const REAL_VERSION = (
    JSON.parse(readFileSync(PKG_JSON, "utf-8")) as { version: string }
).version;

const scratch: string[] = [];
function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "core-version-"));
    scratch.push(d);
    return d;
}
afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A fake installed `@getknext/core` with the bundled `dist/` layout. */
function fakeInstall(version = "9.8.7"): string {
    const root = tmp();
    writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "@getknext/core", version }),
    );
    mkdirSync(join(root, "dist", "cli"), { recursive: true });
    writeFileSync(join(root, "dist", "cli", "kn-next.js"), "");
    writeFileSync(join(root, "dist", "chunk-ABC.js"), "");
    return root;
}

const binOf = (root: string) =>
    pathToFileURL(join(root, "dist", "cli", "kn-next.js")).href;
const chunkOf = (root: string) =>
    pathToFileURL(join(root, "dist", "chunk-ABC.js")).href;

describe("readCoreVersion — walks up to @getknext/core's package.json", () => {
    it("resolves from the src/ layout (this very module) and equals package.json", () => {
        expect(readCoreVersion()).toBe(REAL_VERSION);
    });

    it("resolves from the built dist/cli/ layout", () => {
        expect(readCoreVersion(binOf(fakeInstall()))).toBe("9.8.7");
    });

    it("resolves from a dist/ chunk one level above dist/cli/ (the layout a fixed ../.. read got wrong)", () => {
        expect(readCoreVersion(chunkOf(fakeInstall()))).toBe("9.8.7");
    });

    it("accepts a plain filesystem path as well as a file: URL", () => {
        const root = fakeInstall();
        expect(readCoreVersion(join(root, "dist", "chunk-ABC.js"))).toBe(
            "9.8.7",
        );
    });

    it("skips an intervening package.json that is not @getknext/core (e.g. {type:module})", () => {
        const root = fakeInstall();
        writeFileSync(
            join(root, "dist", "package.json"),
            JSON.stringify({ type: "module" }),
        );
        expect(readCoreVersion(binOf(root))).toBe("9.8.7");
    });

    it("is undefined — never '0.0.0' — when no @getknext/core manifest exists above", () => {
        const dir = tmp();
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({ name: "someone-else", version: "1.2.3" }),
        );
        expect(
            readCoreVersion(pathToFileURL(join(dir, "x.js")).href),
        ).toBeUndefined();
    });

    it("is undefined when the manifest has no version field", () => {
        const dir = tmp();
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({ name: "@getknext/core" }),
        );
        expect(
            readCoreVersion(pathToFileURL(join(dir, "x.js")).href),
        ).toBeUndefined();
    });

    it("is undefined when the manifest is not valid JSON", () => {
        const dir = tmp();
        writeFileSync(join(dir, "package.json"), "{ not json");
        expect(
            readCoreVersion(pathToFileURL(join(dir, "x.js")).href),
        ).toBeUndefined();
    });
});

describe("coreVersion — the peer-range callers keep their refusing fallback", () => {
    it("returns the real version when readable and 0.0.0 (which every peer range refuses) when not", () => {
        expect(coreVersion()).toBe(REAL_VERSION);
        const dir = tmp();
        expect(coreVersion(pathToFileURL(join(dir, "x.js")).href)).toBe(
            "0.0.0",
        );
    });
});

describe("hashBuildIdentity — fails closed on an unreadable CLI version", () => {
    const opts = { builderId: "turbopack", runtimeId: "bun" } as const;

    it("is stable for the same tree and CLI version", () => {
        const root = tmp();
        writeFileSync(join(root, "a.txt"), "hello");
        expect(hashBuildIdentity(root, opts)).toBe(
            hashBuildIdentity(root, opts),
        );
    });

    it("different CLI versions produce different stamps", () => {
        const root = tmp();
        writeFileSync(join(root, "a.txt"), "hello");
        const at = (v: string) => chunkOf(fakeInstall(v));
        expect(
            hashBuildIdentity(root, { ...opts, versionFrom: at("1.0.0") }),
        ).not.toBe(
            hashBuildIdentity(root, { ...opts, versionFrom: at("2.0.0") }),
        );
    });

    it("THROWS when the CLI version cannot be read, rather than hashing '0.0.0'", () => {
        const root = tmp();
        writeFileSync(join(root, "a.txt"), "hello");
        const nowhere = pathToFileURL(join(tmp(), "x.js")).href;
        expect(() =>
            hashBuildIdentity(root, { ...opts, versionFrom: nowhere }),
        ).toThrow(/version/i);
    });
});

describe("single implementation — no call site carries its own package.json read", () => {
    const cli = join(import.meta.dir, "..", "cli");
    for (const file of ["deploy.ts", "build-artifact.ts", "doctor.ts"]) {
        it(`${file} imports the shared reader and has no version fallback of its own`, () => {
            const src = readFileSync(join(cli, file), "utf-8");
            expect(src).toMatch(/from "\.\/core-version"/);
            expect(src).not.toMatch(/"package\.json"/);
            expect(src).not.toMatch(/\?\?\s*"0\.0\.0"/);
            expect(src).not.toMatch(/return "0\.0\.0"/);
        });
    }
});
