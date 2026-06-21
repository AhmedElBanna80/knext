/**
 * #68 — the kn-next CLI runs on plain Node and the bin is an emitted JS entry.
 *
 * Acceptance criteria (issue #68):
 *  - `node <emitted-bin> deploy --dry-run` runs with NO Bun and prints a NextApp CR.
 *  - No `import ... from "bun"` / `Bun.` on the Node code path in src/cli/.
 *  - package.json `bin.kn-next` resolves to an EMITTED JS entry (a build step),
 *    not raw .ts.
 *
 * These tests shell out to a real `node` (never bun) so they prove the Node
 * code path end-to-end. The build step is invoked from the test so the emitted
 * bin always reflects the current source.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

const pkgDir = resolve(__dirname, "..", "..");
const cliDir = resolve(__dirname, "..", "cli");

/** Strip // line comments and block comments so comment text isn't matched. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Read pkg.bin.kn-next and resolve it to an absolute path. */
function binEntry(): { rel: string; abs: string } {
    const pkg = JSON.parse(
        readFileSync(join(pkgDir, "package.json"), "utf-8"),
    ) as { bin?: Record<string, string> };
    const rel = pkg.bin?.["kn-next"] ?? "";
    return { rel, abs: resolve(pkgDir, rel) };
}

describe("#68 packaging — bin.kn-next is an emitted JS entry", () => {
    it("package.json bin.kn-next points at a .js file, not raw .ts", () => {
        const { rel } = binEntry();
        expect(rel).toMatch(/\.js$/);
        expect(rel).not.toMatch(/\.ts$/);
        expect(rel).not.toMatch(/^\.\/src\//);
    });

    it("a build script that EMITS JS exists (not a bare --noEmit)", () => {
        const pkg = JSON.parse(
            readFileSync(join(pkgDir, "package.json"), "utf-8"),
        ) as { scripts?: Record<string, string> };
        const build = pkg.scripts?.build ?? "";
        // Must invoke an emit step (esbuild bundler / tsup / emitting tsc).
        // A *bare* `tsc --noEmit` with nothing after it produces nothing runnable;
        // here typecheck (--noEmit) is chained with a real emit step.
        expect(build).toMatch(/build-cli|tsup|esbuild/);
        expect(build).not.toBe("tsc --noEmit");
    });
});

describe("#68 source — no bun on the Node CLI code path", () => {
    it("no src/cli/*.ts imports the bun module or references Bun. on the Node path", () => {
        const files = readdirSync(cliDir).filter((f) => f.endsWith(".ts"));
        const offenders: string[] = [];
        for (const f of files) {
            // Strip comments so doc/comment mentions of `bun` / `Bun.` (e.g. the
            // ported helper explaining what it replaced) don't false-positive.
            // Only real CODE references count.
            const code = stripComments(readFileSync(join(cliDir, f), "utf-8"));
            if (/import[^;]*from\s+["']bun["']/.test(code)) {
                offenders.push(`${f}: imports "bun"`);
            }
            // `Bun.` used outside a runtime-guarded fallback is not allowed.
            if (/\bBun\.\w/.test(code)) {
                offenders.push(`${f}: references Bun.`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("shebangs on entry CLIs are #!/usr/bin/env node", () => {
        for (const f of ["deploy.ts", "build.ts", "cleanup.ts"]) {
            const first = readFileSync(join(cliDir, f), "utf-8").split("\n")[0];
            expect(first).toBe("#!/usr/bin/env node");
        }
    });
});

describe("#68 runtime — node <emitted-bin> deploy --dry-run prints a NextApp CR", () => {
    const { abs: binAbs } = binEntry();
    const fixtureDir = join(pkgDir, "src", "__tests__", "fixtures", "cli-68");

    beforeAll(() => {
        // Emit JS so the bin reflects current source (no Bun involved).
        execFileSync("npm", ["run", "build"], {
            cwd: pkgDir,
            stdio: "inherit",
        });
    }, 120_000);

    it("emitted bin file exists after build", () => {
        expect(existsSync(binAbs)).toBe(true);
    });

    it("runs under plain `node` and emits a valid NextApp CR to stdout", () => {
        const run = spawnSync(
            process.execPath,
            [binAbs, "deploy", "--dry-run"],
            {
                cwd: fixtureDir,
                encoding: "utf-8",
                env: { ...process.env },
            },
        );

        const out = `${run.stdout ?? ""}`;
        // Must exit cleanly on the Node path.
        expect(run.status).toBe(0);

        // stdout carries the NextApp CR (deploy.ts writes the YAML via
        // process.stdout.write in dry-run mode), interleaved with pretty logs.
        // Extract the contiguous CR block: from `apiVersion:` up to the next
        // pino-pretty log line (which starts with a `[HH:MM:SS]` timestamp).
        const lines = out.split("\n");
        const start = lines.findIndex((l) => l.startsWith("apiVersion:"));
        expect(start).toBeGreaterThanOrEqual(0);
        const rest = lines.slice(start);
        const end = rest.findIndex((l, i) => i > 0 && /^\[\d{2}:\d{2}/.test(l));
        const yamlBlock = (end === -1 ? rest : rest.slice(0, end)).join("\n");

        const cr = YAML.parse(yamlBlock) as {
            kind: string;
            spec: { scaling: { minScale: number } };
        };
        expect(cr.kind).toBe("NextApp");
        // Scale-to-zero invariant survives the Node path.
        expect(cr.spec.scaling.minScale).toBe(0);
    });
});
