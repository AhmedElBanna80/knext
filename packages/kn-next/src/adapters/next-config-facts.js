/**
 * The resolved next.config facts (#2250): what Next actually resolved, read in
 * the official adapter's `modifyConfig`, never from the config source text.
 *
 * `modifyConfig` runs at the start of `next build`, after every wrapper and
 * plugin in next.config has run and Next's defaults are applied, so the
 * `distDir`, `output` and `experimental.turbopackModuleFragments` it sees are
 * the values the build uses. knext's adapter (`next-adapter.ts`) records them
 * through `recordNextConfigFacts`. An app without knext's adapter is judged
 * by the CLI after its build, from the resolved config Next itself writes to
 * `.next/required-server-files.json`: no adapter is injected, because any
 * `adapterPath` changes Next's build output.
 *
 * Recording and refusing happen ONLY when the CLI asked: `KNEXT_CONFIG_FACTS_OUT`
 * names a fresh per-build file, and the phase is the production build. So a
 * plain `next build`, `next typegen` (which also loads the production-build
 * phase) and `next dev` are untouched. The path is unique per build, so a
 * record is never stale.
 *
 * The bundler is NOT part of the resolved config `modifyConfig` sees (Next
 * finalises bundler-specific flags after it), so the builder comes from
 * `KNEXT_BUILDER`, knext's own setting. A build script that passes a different
 * bundler flag is not seen; the earlier text check had the same limit.
 *
 * Plain JS with no imports beyond node, so the CLI and the adapter bundle
 * share it without a TypeScript step.
 */

import { randomBytes } from "node:crypto";
import {
    existsSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { threadId } from "node:worker_threads";

/** The CLI-created file the adapter writes the facts to. Unset = do nothing. */
export const CONFIG_FACTS_OUT_ENV = "KNEXT_CONFIG_FACTS_OUT";
/** knext's builder id (`turbopack`, `webpack`), set by the CLI for the build. */
export const KNEXT_BUILDER_ENV = "KNEXT_BUILDER";
/**
 * The app directory the CLI is building. A build script that builds several
 * apps passes the CLI's env to every `next build`; only this app records or
 * refuses, so a sibling app with the knext adapter is left alone.
 */
export const CONFIG_FACTS_PROJECT_ENV = "KNEXT_CONFIG_FACTS_PROJECT";
/** Same value as `runtime-env.ts`'s KNEXT_RUNTIME_ENV (lockstep-tested). */
const RUNTIME_ENV = "KNEXT_RUNTIME";

const PRODUCTION_BUILD = "phase-production-build";
const DEFAULT_DIST_DIR = ".next";
const REFUSE_MARKER = (code) => `[knext-refuse:${code}] `;

export const CUSTOM_DIST_DIR_MESSAGE = (
    distDir,
) => `Your Next.js config sets \`distDir: '${distDir}'\`, and knext does not support a custom build directory yet.

knext's build, artifact and standalone steps read the build output from \`.next\`, so a different
directory would produce a wrong artifact or fail later in the pipeline.
Remove \`distDir\` from your Next.js config (the default is \`.next\`) and build again.`;

export const TURBOPACK_FRAGMENTS_BUN_DETAIL =
    "experimental.turbopackModuleFragments is on, the build is Turbopack and the runtime is Bun, whose parser rejects the chunks that flag makes Turbopack emit (they assign to a const in code that never runs), so the app fails when those chunks load. Node and non-Turbopack (webpack, vinext) builds are not affected.";
export const TURBOPACK_FRAGMENTS_BUN_HINT =
    'turn experimental.turbopackModuleFragments off in your next.config, or set runtime: "node" in your knext config';

/** True when `distDir` names the default `.next` (`.next`, `./.next`, `.next/`). */
export function isDefaultDistDir(distDir) {
    return (
        typeof distDir === "string" &&
        distDir.replace(/^\.\//, "").replace(/\/+$/, "") === DEFAULT_DIST_DIR
    );
}

/**
 * The refusal the facts call for, or undefined. A static export is NOT refused
 * here: Next runs its own export validation first, and the CLI refuses the
 * export after the build.
 */
export function refusalFor(facts, { runtime, builder }) {
    if (!isDefaultDistDir(facts.distDir)) {
        return {
            code: "custom-dist-dir",
            message: CUSTOM_DIST_DIR_MESSAGE(facts.distDir),
        };
    }
    if (
        facts.turbopackModuleFragments &&
        runtime === "bun" &&
        builder === "turbopack"
    ) {
        return {
            code: "bun-turbopack-fragments",
            message: `${TURBOPACK_FRAGMENTS_BUN_DETAIL} Fix: ${TURBOPACK_FRAGMENTS_BUN_HINT}.`,
        };
    }
    return undefined;
}

/** Resolve symlinks when the path exists, so two spellings of one app match. */
function canonical(path) {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * A temp name unique per call: pid, thread and a random suffix. `modifyConfig`
 * also runs in the bundler's workers, and worker threads share the pid.
 */
export function factsTempPath(outPath) {
    return `${outPath}.${process.pid}.${threadId}.${randomBytes(4).toString("hex")}.tmp`;
}

/**
 * Record the resolved facts of `config` (the config the adapter hands back to
 * Next) and throw a marked refusal when they call for one. Returns the facts,
 * or undefined when the CLI did not ask (see the file comment).
 *
 * `modifyConfig` runs in the main build process and again in the bundler's
 * workers, so the file is written tmp-then-rename: a reader never sees a
 * partial record, and identical writes simply replace each other.
 */
/**
 * Where a build for ANOTHER directory leaves its directory. The record file
 * stays the CLI app's alone; this side file lets the CLI tell "Next built a
 * different directory" (a build script that cd's, or `next build ./web`) from
 * "no adapter ran", and fail closed instead of text-checking the wrong config.
 */
export function foreignMarkerPath(outPath) {
    return `${outPath}.foreign`;
}

/** The directory a foreign build left at `outPath`'s marker, if any. */
export function readForeignProjectDir(outPath) {
    try {
        return readFileSync(foreignMarkerPath(outPath), "utf8").trim() || undefined;
    } catch {
        return undefined;
    }
}

export function recordNextConfigFacts(
    config,
    { phase, projectDir },
    env = process.env,
) {
    const outPath = env[CONFIG_FACTS_OUT_ENV];
    if (!outPath || phase !== PRODUCTION_BUILD) return undefined;
    const target = env[CONFIG_FACTS_PROJECT_ENV];
    if (target && projectDir && canonical(projectDir) !== canonical(target)) {
        // Not the CLI's app: neither record nor refuse, but say which
        // directory Next built. Best effort: a sibling's build must not fail
        // because the marker could not be written.
        try {
            const marker = foreignMarkerPath(outPath);
            const tmp = factsTempPath(marker);
            writeFileSync(tmp, `${canonical(projectDir)}\n`);
            renameSync(tmp, marker);
        } catch {}
        return undefined;
    }
    const facts = {
        ...(projectDir ? { projectDir } : {}),
        distDir: config.distDir ?? DEFAULT_DIST_DIR,
        output: config.output ?? null,
        turbopackModuleFragments:
            config.experimental?.turbopackModuleFragments === true,
    };
    const refusal = refusalFor(facts, {
        runtime: env[RUNTIME_ENV],
        builder: env[KNEXT_BUILDER_ENV],
    });
    const record = refusal ? { ...facts, refused: refusal.code } : facts;
    const tmp = factsTempPath(outPath);
    try {
        writeFileSync(tmp, `${JSON.stringify(record)}\n`);
        renameSync(tmp, outPath);
    } catch (err) {
        throw new Error(
            `[knext-adapter] could not record the resolved Next.js config at ${outPath} (${err instanceof Error ? err.message : String(err)}).`,
        );
    }
    if (refusal) throw new Error(`${REFUSE_MARKER(refusal.code)}${refusal.message}`);
    return record;
}

/**
 * The facts an adapter recorded at `path`, or undefined when none did (no
 * adapter ran, or the build failed before `modifyConfig`). A record that does
 * not parse, or has the wrong shape, throws: it is never read as "clean".
 */
export function readNextConfigFacts(path) {
    if (!existsSync(path)) return undefined;
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch (err) {
        if (err && err.code === "ENOENT") return undefined;
        throw new Error(
            `Could not read the resolved Next.js config record at ${path} (${err instanceof Error ? err.message : String(err)}).`,
        );
    }
    let facts;
    try {
        facts = JSON.parse(text);
    } catch {
        facts = undefined;
    }
    if (
        !facts ||
        typeof facts.distDir !== "string" ||
        (facts.output !== null && typeof facts.output !== "string") ||
        typeof facts.turbopackModuleFragments !== "boolean"
    ) {
        throw new Error(
            `The resolved Next.js config record at ${path} is not valid, so knext cannot confirm your build settings. Build again; if it persists, report it.`,
        );
    }
    return facts;
}
