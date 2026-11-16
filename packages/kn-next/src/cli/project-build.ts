/**
 * The one seam for running the project's build script (UX ledger row 4, 4c).
 *
 * Both deploy and build invoke `npm run build` (which runs `next build`,
 * output:'standalone', or `vite build` for the vinext target). When the app's
 * dependencies are not installed yet, npm's shell cannot find `next`/`vite` and
 * exits 127 — and that used to render as FATAL + a serialized Error object,
 * because the #810 friendly-error contract covered USAGE mistakes only. For the
 * zero-cloud persona the answer is one sentence: run `npm install` first.
 *
 * This seam also owns the vinext ESM preflight. vinext builds with Vite/Rollup
 * (ESM); a CommonJS app dies deep inside vite/nitro with a cryptic
 * `[UNRESOLVED_IMPORT]` before this could ever help. The preflight fires HERE —
 * the real path — because both production callers of `buildVinextExecutable`
 * pass `skipViteBuild: true`; the app's actual `vite build` runs through this
 * seam, not there. It is target-gated: a `node`-target app's `npm run build`
 * is `next build`, which builds CommonJS fine and MUST NOT be blocked.
 *
 * A guard test (project-build.test.ts) scans src/cli for raw
 * `["npm", "run", "build"]` spawns so the translation cannot drift by one
 * caller re-inlining the command, and scans every `runProjectBuild(` call for
 * a `requireEsm` argument so the target gate cannot be silently skipped.
 */

import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CONFIG_FACTS_OUT_ENV,
    CONFIG_FACTS_PROJECT_ENV,
    isDefaultDistDir,
    KNEXT_BUILDER_ENV,
    type NextConfigFacts,
    readForeignProjectDir,
    readNextConfigFacts,
    refusalFor,
} from "../adapters/next-config-facts.js";
import { KNEXT_RUNTIME_ENV } from "../adapters/runtime-env";
import { runQuiet } from "./exec";
import { warnOnVulnerableNext } from "./next-advisory-warning";
import { UsageError } from "./shared";
import {
    assertDefaultDistDir,
    assertNotStaticExport,
    assertNotStaticExportFromFacts,
    assertVinextNotStaticExport,
} from "./static-export-guard";
import {
    assertNoBunTurbopackFragments,
    readNextConfigStrict,
} from "./turbopack-fragments-guard";
import { describeEnsureResult, ensureVinextPatches } from "./vinext-patches";

/** Exit code every POSIX shell uses for "command not found". */
const EXIT_COMMAND_NOT_FOUND = 127;

const MISSING_NEXT_MESSAGE = `The build could not run: the \`next\` command was not found.

That usually means this app's dependencies are not installed yet.
Run \`npm install\` in this directory, then try again.`;

/**
 * Fail fast, before the build, when the app is not an ES module.
 *
 * vinext builds with Vite/Rollup (ESM). A CommonJS app dies deep inside
 * vite/nitro with a cryptic `[UNRESOLVED_IMPORT] Could not resolve
 * '../ssr/index.js'` — it cannot resolve the rsc↔ssr entry graph. Replace that
 * with a message that names the cause and the fix, thrown before the slow build
 * runs at all. Shared with `buildVinextExecutable` (one implementation).
 */
export function preflightEsmPackage(cwd: string): void {
    const pkgPath = join(cwd, "package.json");
    const unreadable = new UsageError(
        "The vinext single-executable build must run in an app directory containing a readable package.json.\n\n" +
            `Could not read or parse '${pkgPath}'.\n` +
            "Run this from the app's root, where its package.json lives.",
    );
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
        throw unreadable;
    }
    // `JSON.parse("null")` succeeds and yields null; reading `.type` off it
    // would throw an uncaught TypeError instead of our friendly message. Treat
    // any non-object (null included) as unreadable rather than crashing.
    if (typeof parsed !== "object" || parsed === null) {
        throw unreadable;
    }
    const pkg = parsed as { type?: unknown };

    if (pkg.type !== "module") {
        throw new UsageError(
            'The vinext single-executable target requires the app to be an ES module: its package.json must have `"type": "module"`.\n\n' +
                "vinext builds with Vite/Rollup (ESM); a CommonJS app fails to resolve the rsc↔ssr entry graph and dies mid-build.\n" +
                'Add `"type": "module"` to package.json (apps scaffolded with `knext create` already have it).',
        );
    }
}

export interface RunProjectBuildOptions {
    /**
     * Whether the resolved build target requires the app to be an ES module.
     * REQUIRED — not defaulted — so every caller is forced by the compiler to
     * decide. The vinext target (`config.build === "vinext"`, selectable
     * since #1183 — no longer the default) requires ESM; the standalone
     * (turbopack/webpack) target does not.
     */
    readonly requireEsm: boolean;
    /** App directory to build/preflight in; defaults to the process cwd. */
    readonly cwd?: string;
    /**
     * Injectable for tests; the real runner inherits stderr, so the shell's own
     * `next: command not found` line appears right above the guidance.
     */
    readonly run?: (argv: readonly string[]) => void;
    /**
     * The app's configured runtime (`config.runtime ?? DEFAULT_RUNTIME_ID`),
     * exported to the build as `KNEXT_RUNTIME` so the knext adapter points
     * `cacheHandler` at that runtime's entry (#1843). REQUIRED, like
     * `builderId`: the fragments guard cannot decide without both.
     */
    readonly runtimeId: string;
    /**
     * The resolved builder id (`config.build ?? DEFAULT_BUILDER_ID`), which the
     * Bun turbopack-fragments guard needs (runtime bun AND builder turbopack).
     */
    readonly builderId: string;
    /**
     * Where the vulnerable-Next.js warning goes (#2594); defaults to stderr.
     * Injectable for tests.
     */
    readonly warn?: (line: string) => void;
}

/** Where Next writes the resolved config of every build into its distDir. */
const REQUIRED_SERVER_FILES = "required-server-files.json";
/** Slack for coarse filesystem mtimes when judging a file this build wrote. */
const FRESH_SLACK_MS = 2000;
const DEFAULT_DIST_DIR = ".next";

const FACTS_FALLBACK_WARNING =
    "warning: knext could not read your resolved Next.js config from this build (the app's build script did not run `next build`, or Next wrote its output somewhere knext does not look), so it checked the next.config source text instead.";

/** Set `name` for the build and hand back a restore for afterwards. */
function setEnv(name: string, value: string): () => void {
    const had = Object.hasOwn(process.env, name);
    const prev = process.env[name];
    process.env[name] = value;
    return () => {
        if (had) process.env[name] = prev;
        else delete process.env[name];
    };
}

/** realpath, or the path itself when it cannot be resolved. */
function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * The resolved config facts Next itself wrote DURING this build, or undefined
 * when it wrote none knext can find. Every `next build` writes
 * `<distDir>/required-server-files.json`; `.next` is checked first, then each
 * top-level directory of the app (a custom distDir; a nested one such as
 * `out/next` is not searched). Only a file modified at or after the build
 * started counts, with two seconds of slack for coarse filesystem clocks, so
 * nothing is deleted beforehand and a file an earlier build left is ignored.
 * A file that does not parse fails closed.
 */
function nextWrittenFacts(
    cwd: string,
    buildStartMs: number,
): NextConfigFacts | undefined {
    // No build start, no notion of "this build": never accept every file.
    if (!(buildStartMs > 0)) return undefined;
    let dirs: string[] = [];
    try {
        dirs = readdirSync(cwd, { withFileTypes: true })
            .filter(
                (e) =>
                    e.isDirectory() &&
                    !["node_modules", ".git", DEFAULT_DIST_DIR].includes(
                        e.name,
                    ),
            )
            .map((e) => e.name);
    } catch {
        dirs = [];
    }
    // Every fresh candidate, not the first: a `.next` copy that only LOOKS
    // fresh (a cache restore that rewrote mtimes) must not hide the custom
    // distDir this build wrote to. Any fresh custom distDir decides (it is
    // refused); otherwise the newest file does.
    const fresh: { facts: NextConfigFacts; mtimeMs: number }[] = [];
    for (const dir of [DEFAULT_DIST_DIR, ...dirs]) {
        const path = join(cwd, dir, REQUIRED_SERVER_FILES);
        let mtimeMs: number;
        try {
            mtimeMs = statSync(path).mtimeMs;
        } catch {
            continue;
        }
        if (mtimeMs >= buildStartMs - FRESH_SLACK_MS) {
            fresh.push({ facts: parseRequiredServerFiles(path), mtimeMs });
        }
    }
    const custom = fresh.find((c) => !isDefaultDistDir(c.facts.distDir));
    if (custom) return custom.facts;
    return fresh.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.facts;
}

function parseRequiredServerFiles(path: string): NextConfigFacts {
    let config: Record<string, unknown> | undefined;
    try {
        config = JSON.parse(readFileSync(path, "utf8"))?.config;
    } catch {
        config = undefined;
    }
    if (!config || typeof config !== "object") {
        throw new UsageError(
            `Next.js wrote ${path}, but knext cannot read the resolved config in it, so it cannot confirm your build settings. Build again; if it persists, report it.`,
        );
    }
    const experimental = config.experimental as
        | Record<string, unknown>
        | undefined;
    return {
        distDir:
            typeof config.distDir === "string"
                ? config.distDir
                : DEFAULT_DIST_DIR,
        output: typeof config.output === "string" ? config.output : null,
        turbopackModuleFragments:
            experimental?.turbopackModuleFragments === true,
    };
}

/**
 * Run `npm run build`, translating the deps-not-installed failure (exit 127)
 * into plain guidance. Raised through the UsageError FAMILY deliberately:
 * that is the CLI's friendly write-and-exit rendering path — an expected
 * local-environment state prints as a message and exit 1, never as
 * `log.fatal({ err })` with a stack and a dist chunk path. Any other build
 * failure is rethrown untouched — the underlying build's own stderr is already
 * on screen (stderr is inherited), and dressing a real build break up as
 * guidance would hide it.
 *
 * When `requireEsm` is true (vinext target) the ESM preflight runs FIRST, so a
 * CommonJS app fails fast with a named cause rather than deep inside vite.
 */
export function runProjectBuild(opts: RunProjectBuildOptions): void {
    const run = opts.run ?? runQuiet;
    const cwd = opts.cwd ?? process.cwd();

    // A Next.js with a published critical/high advisory builds and deploys,
    // but never silently (#2594). Here, so build, deploy and preview all say it.
    warnOnVulnerableNext(cwd, opts.warn);

    if (opts.requireEsm) {
        preflightEsmPackage(cwd);
        // vinext never writes `export-detail.json`, so a static export is
        // refused here from the config, before the slow build.
        assertVinextNotStaticExport(cwd);
        // The vinext target: (re-)apply knext's bundled vinext fixes before
        // `vite build` sees vinext. The app's postinstall normally did this
        // already (then it is a no-op); this covers apps scaffolded before
        // the postinstall existed and installs run with scripts disabled.
        for (const line of describeEnsureResult(ensureVinextPatches(cwd))) {
            process.stderr.write(`${line}\n`);
        }
    }

    process.env[KNEXT_RUNTIME_ENV] = opts.runtimeId;

    if (opts.requireEsm) {
        // vinext builds with vite and never runs a Next adapter, reads Next's
        // distDir or writes `export-detail.json`; its static-export check ran
        // above, so a marker an earlier Next build left must not refuse it.
        runBuild(run);
        return;
    }

    // #2250: a Next build decides its refusals (a custom distDir, and
    // turbopackModuleFragments on Bun + Turbopack) from the config Next
    // RESOLVED, never from the next.config source text:
    //  1. knext's adapter records it in `modifyConfig` and refuses there,
    //     before compilation (the CLI names the file, so a plain `next build`
    //     is untouched);
    //  2. an app without knext's adapter: after the build, from the resolved
    //     config Next itself writes to `<distDir>/required-server-files.json`
    //     during the build (`.next`, else a top-level directory). No adapter
    //     is injected: any adapterPath changes Next's build output;
    //  3. neither (the build script did not run `next build`): the earlier
    //     source-text checks, with a warning.
    // The text checks also run BEFORE the build, as warnings only, so the
    // common cases are flagged before a slow build.
    const say =
        opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    predictiveWarnings(cwd, opts, say);

    const restores: (() => void)[] = [];
    let factsDir: string | undefined;
    let facts: NextConfigFacts | undefined;
    let foreignDir: string | undefined;
    let buildStartMs = 0;
    try {
        factsDir = mkdtempSync(join(tmpdir(), "knext-config-facts-"));
        const factsPath = join(factsDir, "facts.json");
        restores.push(
            setEnv(CONFIG_FACTS_OUT_ENV, factsPath),
            setEnv(CONFIG_FACTS_PROJECT_ENV, cwd),
            setEnv(KNEXT_BUILDER_ENV, opts.builderId),
        );
        const recorded = (): NextConfigFacts | undefined => {
            let f: NextConfigFacts | undefined;
            try {
                f = readNextConfigFacts(factsPath);
            } catch (err) {
                throw new UsageError(
                    err instanceof Error ? err.message : String(err),
                );
            }
            // One record per build path; a record another app's build wrote
            // (a script that builds several apps) is not this app's.
            return f?.projectDir && real(f.projectDir) !== real(cwd)
                ? undefined
                : f;
        };
        buildStartMs = Date.now();
        try {
            runBuild(run);
        } catch (err) {
            // A refusal from the adapter fails `next build`; Next has already
            // printed it, so say it once more as knext's own usage error. A
            // record that cannot be read never replaces the build's own error.
            let refused: NextConfigFacts | undefined;
            try {
                refused = recorded();
            } catch {
                refused = undefined;
            }
            const refusal =
                refused?.refused && refusalFor(refused, refusalInput(opts));
            if (refusal) throw new UsageError(refusal.message);
            throw err;
        }
        facts = recorded();
        foreignDir = readForeignProjectDir(factsPath);
    } finally {
        for (const restore of restores.reverse()) restore();
        if (factsDir) rmSync(factsDir, { recursive: true, force: true });
    }

    facts ??= nextWrittenFacts(cwd, buildStartMs);
    if (facts) {
        // Fail closed: a refusal stands even if the build exited 0.
        const refusal = refusalFor(facts, refusalInput(opts));
        if (refusal) throw new UsageError(refusal.message);
        assertNotStaticExportFromFacts(cwd, facts);
        return;
    }

    // Next built a different directory than this app (the build script cd's,
    // or runs `next build <dir>`): the text check below would read the wrong
    // next.config, so fail closed rather than pass unchecked.
    if (foreignDir) {
        throw new UsageError(
            `the build ran Next.js in ${foreignDir}, not in ${cwd}, so knext could not check this app's resolved config. Run knext from the directory Next.js builds (the one with next.config), or make the build script build this directory.`,
        );
    }

    say(FACTS_FALLBACK_WARNING);
    assertNoBunTurbopackFragments({
        runtime: opts.runtimeId,
        builder: opts.builderId,
        readNextConfig: () => readNextConfigStrict(cwd),
    });
    assertDefaultDistDir(cwd);
    assertNotStaticExport(cwd);
}

function refusalInput(opts: RunProjectBuildOptions) {
    return { runtime: opts.runtimeId, builder: opts.builderId };
}

/**
 * The source-text checks, run before the build as WARNINGS: the resolved
 * config decides after, but a setting the text can see is flagged before a
 * slow build. An unreadable config is left for the resolved check.
 */
function predictiveWarnings(
    cwd: string,
    opts: RunProjectBuildOptions,
    say: (line: string) => void,
): void {
    for (const check of [
        () =>
            assertNoBunTurbopackFragments({
                runtime: opts.runtimeId,
                builder: opts.builderId,
                readNextConfig: () => readNextConfigStrict(cwd),
            }),
        () => assertDefaultDistDir(cwd),
    ]) {
        try {
            check();
        } catch (err) {
            if (err instanceof UsageError) {
                say(
                    `warning: read as text, your next.config may be refused; knext decides from the config Next resolves during the build: ${err.message.split("\n")[0]}`,
                );
            }
        }
    }
}

/** `npm run build`, with the deps-not-installed failure (127) translated. */
function runBuild(run: (argv: readonly string[]) => void): void {
    try {
        run(["npm", "run", "build"]);
    } catch (err) {
        if (
            typeof err === "object" &&
            err !== null &&
            (err as { status?: unknown }).status === EXIT_COMMAND_NOT_FOUND
        ) {
            throw new UsageError(MISSING_NEXT_MESSAGE);
        }
        throw err;
    }
}
