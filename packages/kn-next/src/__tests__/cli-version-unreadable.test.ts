/**
 * An unreadable CLI version must REFUSE the scaffold and `init-ci --provider
 * gitlab` — never silently pin `@getknext/core@0.0.0`.
 *
 * `cliVersion()` used to read `package.json` itself and fall back to `"0.0.0"`;
 * that range was written into the scaffold's `@getknext/*` deps and into the
 * generated pipeline's `npx --yes @getknext/core@<version>`. The one shared
 * reader (`readCoreVersion`) is tri-state and never invents a version, so this
 * file makes it report "unreadable" for the whole process (the runner gives
 * each test file its own process, so the module mock cannot leak).
 */
import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = await import("../cli/core-version");
mock.module("../cli/core-version", () => ({
    ...real,
    readCoreVersion: () => undefined,
}));

const { cliVersion, writeScaffold, createMain } = await import("../cli/create");
const { initCi } = await import("../cli/ci/init-ci");
const { renderGitlabPipeline } = await import("../cli/ci/init-ci-gitlab");
const { UsageError } = await import("../cli/shared");

const REFUSAL = /cannot determine the knext CLI version/;

describe("an unreadable CLI version is refused, not pinned as 0.0.0", () => {
    it("cliVersion() throws a UsageError instead of returning 0.0.0", () => {
        let thrown: unknown;
        try {
            cliVersion();
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(UsageError);
        expect((thrown as Error).message).toMatch(REFUSAL);
    });

    it("writeScaffold refuses and writes nothing", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-cliver-scaffold-"));
        try {
            expect(() => writeScaffold({ appDir: dir, name: "x" })).toThrow(
                REFUSAL,
            );
            expect(readdirSync(dir)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("createMain exits 1 with the refusal on stderr and writes no app", async () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-cliver-create-"));
        const chunks: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((c: string | Uint8Array) => {
            chunks.push(String(c));
            return true;
        }) as typeof process.stderr.write;
        try {
            const code = await createMain([join(dir, "app"), "--name", "x"]);
            expect(code).toBe(1);
            expect(chunks.join("")).toMatch(REFUSAL);
            expect(existsSync(join(dir, "app", "package.json"))).toBe(false);
        } finally {
            process.stderr.write = original;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("renderGitlabPipeline refuses instead of rendering @getknext/core@0.0.0", () => {
        expect(() => renderGitlabPipeline(".")).toThrow(REFUSAL);
    });

    it("initCi --provider gitlab refuses and writes no file", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-cliver-initci-"));
        try {
            expect(() =>
                initCi(dir, {
                    namespace: "acme",
                    appDir: ".",
                    provider: "gitlab",
                }),
            ).toThrow(REFUSAL);
            expect(readdirSync(dir)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
