/**
 * The static-export refusal covers two cases the first version missed:
 *
 *  1. a custom `distDir` - the refusal looked for `.next/export-detail.json`
 *     only, so an app building into `build/` was never refused;
 *  2. the vinext target - it never writes `export-detail.json`, so an
 *     `output: 'export'` app sailed through. It is refused up front, before
 *     the slow `vite build`, from the literal `output` in next.config.
 *
 * Both run the real guard (`runProjectBuild`) against a temp fixture dir.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectBuild } from "../cli/project-build";
import { USAGE_ERROR_CODE } from "../cli/shared";
import { adapterBuild } from "./helpers/next-adapter-build";

const scratchDirs: string[] = [];

afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function appDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-export-guard-"));
    scratchDirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }
    return dir;
}

const EXPORT_DETAIL = JSON.stringify({ version: 1, success: true });
const ESM_PKG = JSON.stringify({ type: "module" });

/** A build stub that exports, as Next does: it writes `.next/export-detail.json` (a stale one is removed first). */
const exportsDuringBuild = (dir: string) => () => {
    mkdirSync(join(dir, ".next"), { recursive: true });
    writeFileSync(join(dir, ".next", "export-detail.json"), EXPORT_DETAIL);
};

function run(
    dir: string,
    requireEsm: boolean,
    build: (argv: readonly unknown[]) => void = () => {},
) {
    const runner = mock(build);
    const warnings: string[] = [];
    let caught: unknown;
    try {
        runProjectBuild({
            requireEsm,
            runtimeId: "node",
            builderId: requireEsm ? "vinext" : "webpack",
            cwd: dir,
            run: runner,
            warn: (line) => warnings.push(line),
        });
    } catch (err) {
        caught = err;
    }
    return { runner, caught, warnings };
}

function expectRefusal(caught: unknown) {
    expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
    const message = (caught as Error).message;
    expect(message).toContain("static export is not a server deployment");
    expect(message).toContain("remove `output: 'export'`");
}

function expectDistDirRefusal(caught: unknown, distDir: string) {
    expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
    const message = (caught as Error).message;
    expect(message).toContain(`sets \`distDir: '${distDir}'\``);
    expect(message).toContain("Remove `distDir`");
}

// #2251: a custom distDir is refused until the build, artifact and standalone
// steps honour it (they assume `.next`). These stub the build with no adapter,
// so they exercise the source-text FALLBACK (#2250), which refuses after the
// build; the resolved-config path is below.
describe("a custom distDir is refused by the text fallback when no adapter ran", () => {
    it("refuses distDir: 'build'", () => {
        const dir = appDir({
            "next.config.mjs": "export default { distDir: 'build' };",
            "build/export-detail.json": EXPORT_DETAIL,
        });
        const { runner, caught } = run(dir, false);
        expectDistDirRefusal(caught, "build");
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it("refuses a double-quoted distDir in a .ts config", () => {
        const dir = appDir({
            "next.config.ts": 'export default { distDir: "dist" };',
        });
        expectDistDirRefusal(run(dir, false).caught, "dist");
    });

    it("accepts the default spelled out: .next, ./.next and .next/", () => {
        for (const spelled of [".next", "./.next", ".next/"]) {
            const dir = appDir({
                "next.config.mjs": `export default { distDir: '${spelled}' };`,
            });
            const { runner, caught } = run(dir, false);
            expect(caught).toBeUndefined();
            expect(runner).toHaveBeenCalledTimes(1);
        }
    });

    it("refuses a quoted key, an assignment, and an empty value", () => {
        for (const [config, value] of [
            ['export default { "distDir": "build" };', "build"],
            ["const c = {}; c.distDir = 'out'; export default c;", "out"],
            ["export default { distDir: '' };", ""],
        ] as const) {
            const { runner, caught } = run(
                appDir({ "next.config.mjs": config }),
                false,
            );
            expectDistDirRefusal(caught, value);
            expect(runner).toHaveBeenCalledTimes(1);
        }
    });

    it("refuses a computed-key property and a bracket assignment", () => {
        for (const config of [
            "export default { ['distDir']: 'build' };",
            "const c = {}; c['distDir'] = 'build'; export default c;",
        ]) {
            expectDistDirRefusal(
                run(appDir({ "next.config.mjs": config }), false).caught,
                "build",
            );
        }
    });

    it("does not treat an arrow function named distDir as an assignment", () => {
        const dir = appDir({
            "next.config.mjs": "const distDir => 1;\nexport default {};",
        });
        const { runner, caught } = run(dir, false);
        expect(caught).toBeUndefined();
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it("checks every distDir key, so an earlier default one does not mask a later custom one", () => {
        const dir = appDir({
            "next.config.mjs":
                "const base = { distDir: '.next' };\nexport default { ...base, distDir: 'build' };",
        });
        expectDistDirRefusal(run(dir, false).caught, "build");
    });

    it("refuses a computed distDir it cannot read (an env var, a template with ${})", () => {
        for (const config of [
            "export default { distDir: process.env.DIST || '.next' };",
            "export default { distDir: `${'build'}` };",
        ]) {
            const { runner, caught } = run(
                appDir({ "next.config.mjs": config }),
                false,
            );
            expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
            expect((caught as Error).message).toContain(
                "which knext cannot read from the next.config source",
            );
            expect(runner).toHaveBeenCalledTimes(1);
        }
    });

    it("does not refuse the vinext target, which never reads Next's distDir", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "export default { distDir: 'build', output: 'standalone' };",
        });
        expect(run(dir, true).caught).toBeUndefined();
    });
});

describe("static-export refusal on the default distDir", () => {
    it("ignores a commented-out distDir", () => {
        const dir = appDir({
            "next.config.mjs": "// distDir: 'build'\nexport default {};",
        });
        expectRefusal(run(dir, false, exportsDuringBuild(dir)).caught);
    });

    it("still refuses on the default `.next` with no distDir configured", () => {
        const dir = appDir({
            "next.config.mjs": "export default {};",
        });
        expectRefusal(run(dir, false, exportsDuringBuild(dir)).caught);
    });

    it("fails closed when next.config exists but cannot be read", () => {
        const dir = appDir({ ".next/.keep": "" });
        // A directory named like the config: it exists, reading it throws.
        mkdirSync(join(dir, "next.config.mjs"));
        const { caught } = run(dir, false);
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect((caught as Error).message).toContain("next.config");
    });
});

describe("vinext target refuses output: 'export'", () => {
    it("refuses before the build runs, with the same actionable message", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": "export default { output: 'export' };",
        });
        const { runner, caught } = run(dir, true);
        expectRefusal(caught);
        expect(runner).not.toHaveBeenCalled();
    });

    it("detects a double-quoted and a .ts config", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.ts": 'export default { output: "export" };',
        });
        expectRefusal(run(dir, true).caught);
    });

    it("lets a normal vinext app build", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": "export default { output: 'standalone' };",
        });
        const { runner, caught } = run(dir, true);
        expect(caught).toBeUndefined();
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it("ignores a commented-out output: 'export'", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": "// output: 'export'\nexport default {};",
        });
        expect(run(dir, true).caught).toBeUndefined();
    });

    it("fails closed on an unreadable next.config", () => {
        const dir = appDir({ "package.json": ESM_PKG });
        mkdirSync(join(dir, "next.config.mjs"));
        const { runner, caught } = run(dir, true);
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect(runner).not.toHaveBeenCalled();
    });

    it("does not pre-refuse the non-vinext target (it is caught after the build)", () => {
        const dir = appDir({
            "next.config.mjs": "export default { output: 'export' };",
        });
        const { runner, caught } = run(dir, false);
        // No export-detail.json was written by the (mock) build, so the
        // node/bun target is not refused here; only vinext reads the config.
        expect(caught).toBeUndefined();
        expect(runner).toHaveBeenCalledTimes(1);
    });
});

describe("vinext: a conditional or nested output: 'export' warns instead of refusing", () => {
    function runCapturingStderr(dir: string) {
        const writes: string[] = [];
        const original = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        try {
            return { ...run(dir, true), stderr: writes.join("") };
        } finally {
            process.stderr.write = original;
        }
    }

    const cases: Record<string, string> = {
        "conditional spread": `export default { ...(process.env.STATIC ? { output: "export" } : {}) };`,
        "&& spread": `export default { ...(process.env.STATIC && { output: 'export' }) };`,
        "nested in experimental": `export default { experimental: { output: 'export' } };`,
        "inside a function body": `export default () => { return { output: 'export' }; };`,
    };

    for (const [name, config] of Object.entries(cases)) {
        it(`${name}: builds and warns`, () => {
            const dir = appDir({
                "package.json": ESM_PKG,
                "next.config.mjs": config,
            });
            const { runner, caught, stderr } = runCapturingStderr(dir);
            expect(caught).toBeUndefined();
            expect(runner).toHaveBeenCalledTimes(1);
            expect(stderr).toContain("static export");
            expect(stderr).toContain("standalone");
        });
    }

    it("a ternary value is not a literal export, so it builds", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "export default { output: process.env.S ? 'export' : 'standalone' };",
        });
        expect(run(dir, true).caught).toBeUndefined();
    });

    it("an unconditional top-level property is still refused (wrapped in defineConfig too)", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "export default defineConfig({ reactStrictMode: true, output: 'export' });",
        });
        expectRefusal(run(dir, true).caught);
    });

    it("a string containing braces before the property does not confuse the depth", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "export default { basePath: '/{x', output: \"export\" };",
        });
        expectRefusal(run(dir, true).caught);
    });
});

describe("vinext: only the object that is actually exported can be refused", () => {
    const notExported: Record<string, string> = {
        "a non-exported object, export is a ternary of two":
            "const s = { output: 'export' }; const v = { output: 'standalone' }; export default process.env.STATIC ? s : v;",
        "a non-exported object next to module.exports of another":
            "const doc = { output: 'export' }; module.exports = { a: 1 };",
        "a non-exported object next to an empty export default":
            "const o = { output: 'export' }; export default {};",
    };
    for (const [name, config] of Object.entries(notExported)) {
        it(`${name}: builds`, () => {
            const dir = appDir({
                "package.json": ESM_PKG,
                "next.config.mjs": config,
            });
            const { runner, caught } = run(dir, true);
            expect(caught).toBeUndefined();
            expect(runner).toHaveBeenCalledTimes(1);
        });
    }

    const exported: Record<string, string> = {
        "export default <id> binding":
            "const nextConfig = { output: 'export' };\nexport default nextConfig;",
        "typed binding with satisfies":
            "const nextConfig: NextConfig = { output: 'export' };\nexport default nextConfig satisfies NextConfig;",
        "module.exports = <id> binding":
            "const c = { output: 'export' };\nmodule.exports = c;",
        "module.exports inline": "module.exports = { output: 'export' };",
        "arrow returning the object":
            "export default (phase) => ({ output: 'export' });",
        "a string containing a comment opener before the export":
            "export default { basePath: 'a/*b', output: 'export' }; /* c */",
    };
    for (const [name, config] of Object.entries(exported)) {
        it(`${name}: refused`, () => {
            const dir = appDir({
                "package.json": ESM_PKG,
                "next.config.mjs": config,
            });
            expectRefusal(run(dir, true).caught);
        });
    }

    it("an identifier exported through a ternary is not a binding match", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs":
                "const s = { output: 'export' };\nexport default process.env.X ? s : {};",
        });
        expect(run(dir, true).caught).toBeUndefined();
    });
});

describe("vinext: a bound config exported through wrapper calls is still refused", () => {
    const base = "const nextConfig = { output: 'export' };\n";
    const wrapped: Record<string, string> = {
        "ESM single wrapper": `${base}export default withX(nextConfig);`,
        "CJS single wrapper": `${base}module.exports = withBundleAnalyzer(nextConfig);`,
        "nested wrappers": `${base}export default withA(withB(nextConfig));`,
        "wrapper with an extra options argument": `${base}export default withSentryConfig(nextConfig, { silent: true, org: "o" });`,
        "multi-line wrapper": `${base}export default withX(\n    nextConfig,\n);`,
        "member-call wrapper": `${base}module.exports = plugins.withX(nextConfig);`,
    };
    for (const [name, config] of Object.entries(wrapped)) {
        it(`${name}: refused`, () => {
            const dir = appDir({
                "package.json": ESM_PKG,
                "next.config.mjs": config,
            });
            expectRefusal(run(dir, true).caught);
        });
    }

    it("a wrapper around a DIFFERENT config builds (warns)", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": `${base}const otherConfig = { output: 'standalone' };\nexport default withX(otherConfig);`,
        });
        const { runner, caught } = run(dir, true);
        expect(caught).toBeUndefined();
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it("the id inside a ternary branch of a wrapper call builds", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": `${base}export default process.env.X ? withX(nextConfig) : {};`,
        });
        expect(run(dir, true).caught).toBeUndefined();
    });
});

// #2250: the decisions come from the config Next resolved, so shapes the text
// cannot evaluate are decided correctly. FALLBACK is the warning printed only
// when neither knext's adapter nor Next recorded the resolved config.
const FALLBACK = /checked the next\.config source text instead/;
const fellBack = (warnings: string[]) => FALLBACK.test(warnings.join("\n"));

/** A stand-in for a plain `next build` (no knext adapter): Next writes the resolved config into `.next`. */
function nextWrites(
    dir: string,
    config: Record<string, unknown>,
    raw?: string,
): (argv: readonly unknown[]) => void {
    return () => {
        mkdirSync(join(dir, ".next"), { recursive: true });
        writeFileSync(
            join(dir, ".next", "required-server-files.json"),
            raw ??
                JSON.stringify({
                    version: 1,
                    config: { distDir: ".next", ...config },
                }),
        );
        // Next writes the export marker on an export build and deletes it on
        // every other one.
        if (config.output === "export") {
            writeFileSync(
                join(dir, ".next", "export-detail.json"),
                EXPORT_DETAIL,
            );
        } else {
            rmSync(join(dir, ".next", "export-detail.json"), { force: true });
        }
    };
}

describe("a Next build with knext's adapter decides from the config it recorded", () => {
    it("refuses a custom distDir from the resolved value, inside the build", () => {
        const dir = appDir({
            "next.config.mjs":
                "export default withPlugins({ distDir: process.env.OUT });",
        });
        const { runner, caught, warnings } = run(
            dir,
            false,
            adapterBuild({ distDir: "build" }),
        );
        expectDistDirRefusal(caught, "build");
        expect(runner).toHaveBeenCalledTimes(1);
        expect(fellBack(warnings)).toBe(false);
    });

    it("allows a computed distDir the text check would refuse, when it resolves to .next", () => {
        const dir = appDir({
            "next.config.mjs":
                "export default { distDir: process.env.OUT ?? '.next' };",
        });
        expect(run(dir, false).caught).toMatchObject({
            code: USAGE_ERROR_CODE,
        });
        const { caught, warnings } = run(
            dir,
            false,
            adapterBuild({ distDir: "./.next" }),
        );
        expect(caught).toBeUndefined();
        expect(fellBack(warnings)).toBe(false);
        // The text check still flagged it before the build, as a warning only.
        expect(warnings.join("\n")).toMatch(
            /may be refused; knext decides from the config Next resolves/,
        );
    });

    it("refuses a static export from the resolved output, even with no export-detail.json", () => {
        const dir = appDir({
            "next.config.mjs": "export default makeConfig();",
        });
        expectRefusal(
            run(dir, false, adapterBuild({ output: "export" })).caught,
        );
    });

    it("fails closed: a recorded refusal stands even when the build exits 0", () => {
        const dir = appDir({ "next.config.mjs": "export default {};" });
        const swallowed = (argv: readonly unknown[]) => {
            try {
                adapterBuild({ distDir: "build" })(argv);
            } catch {
                // A bundler worker that swallowed the adapter's throw.
            }
        };
        expectDistDirRefusal(run(dir, false, swallowed).caught, "build");
    });

    it("never replaces the build's own error with a record it cannot read", () => {
        const dir = appDir({ "next.config.mjs": "export default {};" });
        const boom = new Error("real compile error");
        const { caught } = run(dir, false, () => {
            writeFileSync(
                process.env.KNEXT_CONFIG_FACTS_OUT as string,
                "{not json",
            );
            throw boom;
        });
        expect(caught).toBe(boom);
    });

    it("ignores a record another app's build wrote, and decides from what Next wrote here", () => {
        const dir = appDir({ "next.config.mjs": "export default {};" });
        const { caught, warnings } = run(dir, false, (argv) => {
            writeFileSync(
                process.env.KNEXT_CONFIG_FACTS_OUT as string,
                JSON.stringify({
                    projectDir: "/somewhere/else",
                    distDir: "build",
                    output: null,
                    turbopackModuleFragments: false,
                    refused: "custom-dist-dir",
                }),
            );
            nextWrites(dir, {})(argv);
        });
        expect(caught).toBeUndefined();
        expect(fellBack(warnings)).toBe(false);
    });
});

describe("a Next build without knext's adapter decides from what Next wrote", () => {
    it("refuses Bun + Turbopack + turbopackModuleFragments set by a wrapper", () => {
        const dir = appDir({
            "next.config.mjs": "export default withFlags({});",
        });
        let caught: unknown;
        try {
            runProjectBuild({
                requireEsm: false,
                runtimeId: "bun",
                builderId: "turbopack",
                cwd: dir,
                run: nextWrites(dir, {
                    experimental: { turbopackModuleFragments: true },
                }),
                warn: () => {},
            });
        } catch (err) {
            caught = err;
        }
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect((caught as Error).message).toMatch(/turbopackModuleFragments/);
    });

    it("refuses a static export Next resolved, and allows a normal build with no warning", () => {
        const dir = appDir({
            "next.config.mjs": "export default makeConfig();",
        });
        expectRefusal(
            run(dir, false, nextWrites(dir, { output: "export" })).caught,
        );
        const ok = run(dir, false, nextWrites(dir, { output: "standalone" }));
        expect(ok.caught).toBeUndefined();
        expect(fellBack(ok.warnings)).toBe(false);
    });

    it("fails closed on a resolved-config file it cannot read", () => {
        const dir = appDir({ "next.config.mjs": "export default {};" });
        const { caught } = run(dir, false, nextWrites(dir, {}, "{not json"));
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect((caught as Error).message).toMatch(
            /cannot read the resolved config/,
        );
    });

    it("refuses a custom distDir set by a wrapper, from the file Next wrote into it", () => {
        const dir = appDir({
            "next.config.mjs": "export default withOut({});",
        });
        const { caught, warnings } = run(dir, false, () => {
            mkdirSync(join(dir, "build"), { recursive: true });
            writeFileSync(
                join(dir, "build", "required-server-files.json"),
                JSON.stringify({ version: 1, config: { distDir: "build" } }),
            );
        });
        expectDistDirRefusal(caught, "build");
        expect(fellBack(warnings)).toBe(false);
    });

    it("ignores another directory's file that this build did not write", () => {
        const dir = appDir({
            "next.config.mjs": "export default {};",
            "old/required-server-files.json": JSON.stringify({
                config: { distDir: "old" },
            }),
        });
        const past = new Date(Date.now() - 60_000);
        utimesSync(join(dir, "old", "required-server-files.json"), past, past);
        const { caught, warnings } = run(dir, false);
        expect(caught).toBeUndefined();
        expect(fellBack(warnings)).toBe(true);
    });

    it("never trusts a file an earlier build left in .next: only this build's counts", () => {
        const dir = appDir({
            "next.config.mjs": "export default {};",
            ".next/required-server-files.json": JSON.stringify({
                config: { distDir: ".next", output: "export" },
            }),
        });
        const past = new Date(Date.now() - 60_000);
        utimesSync(
            join(dir, ".next", "required-server-files.json"),
            past,
            past,
        );
        const { caught, warnings } = run(dir, false);
        expect(caught).toBeUndefined();
        expect(fellBack(warnings)).toBe(true);
    });
});

describe("the adapter record and the default app", () => {
    it("accepts its own record when projectDir names the app through another path", () => {
        const dir = appDir({ "next.config.mjs": "export default {};" });
        // macOS tmp dirs: /var/folders/... is /private/var/folders/...
        const aliased = realpathSync(dir);
        const { caught } = run(dir, false, () => {
            writeFileSync(
                process.env.KNEXT_CONFIG_FACTS_OUT as string,
                JSON.stringify({
                    projectDir: aliased === dir ? `${dir}/.` : aliased,
                    distDir: "build",
                    output: null,
                    turbopackModuleFragments: false,
                    refused: "custom-dist-dir",
                }),
            );
        });
        expectDistDirRefusal(caught, "build");
    });

    it("refuses with a usage error when a successful build left a record it cannot read", () => {
        const dir = appDir({ "next.config.mjs": "export default {};" });
        const { caught } = run(dir, false, () => {
            writeFileSync(
                process.env.KNEXT_CONFIG_FACTS_OUT as string,
                "{not json",
            );
        });
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect((caught as Error).message).toMatch(
            /resolved Next\.js config record/,
        );
    });

    it("prints nothing for the default scaffold shape (no distDir, no flag)", () => {
        const dir = appDir({
            "next.config.mjs": "export default { output: 'standalone' };",
        });
        const { caught, warnings } = run(dir, false, adapterBuild());
        expect(caught).toBeUndefined();
        expect(warnings).toEqual([]);
    });
});

describe("the vinext target and Next's markers", () => {
    it("is never refused by an export marker an earlier Next build left", () => {
        const dir = appDir({
            "package.json": ESM_PKG,
            "next.config.mjs": "export default {};",
            ".next/export-detail.json": EXPORT_DETAIL,
        });
        expect(run(dir, true).caught).toBeUndefined();
    });
});

describe("the build env and temp files", () => {
    it("sets its env for the build only, removes its temp dir, and never injects an adapter", () => {
        const dir = appDir({ "next.config.mjs": "export default {};" });
        process.env.KNEXT_BUILDER = "preset-by-user";
        const before = {
            out: process.env.KNEXT_CONFIG_FACTS_OUT,
            builder: process.env.KNEXT_BUILDER,
            adapter: process.env.NEXT_ADAPTER_PATH,
        };
        let seenOut: string | undefined;
        let seenAdapter: string | undefined;
        try {
            run(dir, false, () => {
                seenOut = process.env.KNEXT_CONFIG_FACTS_OUT;
                seenAdapter = process.env.NEXT_ADAPTER_PATH;
            });
            expect(seenOut).toMatch(/facts\.json$/);
            expect(seenAdapter).toBe(before.adapter);
            expect(existsSync(join(seenOut as string, ".."))).toBe(false);
            expect({
                out: process.env.KNEXT_CONFIG_FACTS_OUT,
                builder: process.env.KNEXT_BUILDER,
                adapter: process.env.NEXT_ADAPTER_PATH,
            }).toEqual(before);
        } finally {
            delete process.env.KNEXT_BUILDER;
        }
    });
});
