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

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** The CLI-created file the adapter writes the facts to. Unset = do nothing. */
export const CONFIG_FACTS_OUT_ENV = "KNEXT_CONFIG_FACTS_OUT";
/** knext's builder id (`turbopack`, `webpack`), set by the CLI for the build. */
export const KNEXT_BUILDER_ENV = "KNEXT_BUILDER";
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

/**
 * Record the resolved facts of `config` (the config the adapter hands back to
 * Next) and throw a marked refusal when they call for one. Returns the facts,
 * or undefined when the CLI did not ask (see the file comment).
 *
 * `modifyConfig` runs in the main build process and again in the bundler's
 * workers, so the file is written tmp-then-rename: a reader never sees a
 * partial record, and identical writes simply replace each other.
 */
export function recordNextConfigFacts(
    config,
    { phase, projectDir },
    env = process.env,
) {
    const outPath = env[CONFIG_FACTS_OUT_ENV];
    if (!outPath || phase !== PRODUCTION_BUILD) return undefined;
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
    const tmp = `${outPath}.${process.pid}.tmp`;
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
