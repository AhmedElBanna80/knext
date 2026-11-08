/**
 * Refuse a static export (`output: 'export'`) as a knext deployment.
 *
 * knext deploys a Next.js SERVER. `output: 'export'` makes `next build` emit a
 * static `out/` folder and no server, so carrying on would build an image with
 * nothing to run. The adapter deliberately leaves an explicit `export` alone
 * (so Next runs its own export validation); this is the CLI half, called by
 * `runProjectBuild` so build, deploy and preview all share it.
 *
 * Two signals, one per build path:
 *  - Next build: Next writes `<distDir>/export-detail.json` when it exports,
 *    and deletes it on every non-export build, so a present file always
 *    belongs to the build that just ran. `distDir` is read from next.config.
 *  - vinext build: vinext handles `output: 'export'` itself and never writes
 *    that file, so the literal `output` in next.config is checked BEFORE the
 *    build (it would only waste a `vite build`).
 *
 * Both read next.config as text, like the turbopack-fragments guard: a value
 * computed at runtime is not visible. An unreadable config is refused rather
 * than assumed clean.
 *
 * build.ts, build-artifact.ts and standalone-layout.ts assume `.next`, so a
 * custom `distDir` is refused before a Next build (`assertDefaultDistDir`).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { stripComments } from "../adapters/js-source-lexer.mjs";
import { UsageError } from "./shared";
import { readNextConfigStrict } from "./turbopack-fragments-guard";

/** Written by `next build` only for `output: 'export'` (removed otherwise). */
const EXPORT_DETAIL_FILE = "export-detail.json";
const DEFAULT_DIST_DIR = ".next";

const STATIC_EXPORT_MESSAGE = `This app builds as a static export (\`output: 'export'\`), and a static export is not a server deployment.

knext deploys a Next.js server, so there is nothing for it to run from an export.
Either remove \`output: 'export'\` from your Next.js config and build again,
or host the \`out/\` folder on a static host instead.`;

/** The literal `distDir` in the config text, or undefined (default `.next`). */
export function configuredDistDir(configText: string): string | undefined {
    return stripCommentsStringAware(configText).match(
        /\bdistDir\s*:\s*(["'`])([^"'`\n]+)\1/,
    )?.[2];
}

/**
 * How the config text declares `output: 'export'`:
 *  - `unconditional`: a top-level property of the config object literal
 *    (exactly one enclosing `{`, no `[`; wrapping calls like `defineConfig(`
 *    are fine). The app really is a static export.
 *  - `conditional`: the literal appears, but under a spread, ternary branch,
 *    nested object, array or function body, or the structure cannot be
 *    determined. A heuristic must never block a working app, so this only warns.
 *  - `none`: the literal never appears.
 */
export type StaticExportDeclaration = "unconditional" | "conditional" | "none";

export function classifyStaticExport(
    configText: string,
): StaticExportDeclaration {
    const text = stripCommentsStringAware(configText);
    // The brace walk reads a copy with string and regex BODIES blanked (same
    // width, so offsets line up with `text`): a quote or bracket inside a
    // string, template or regex literal is then plain padding, and the walk
    // needs no quote tracking of its own.
    const walk = stripComments(configText, {
        blankStrings: true,
        blankRegex: true,
    });
    const re = /\boutput\s*:\s*(["'`])export\1/g;
    let result: StaticExportDeclaration = "none";
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const stack: { c: string; at: number }[] = [];
        let broken = false;
        for (let i = 0; i < m.index; i++) {
            const c = walk[i];
            if (c === "{" || c === "[" || c === "(") stack.push({ c, at: i });
            else if (c === "}" || c === "]" || c === ")") {
                if (stack.pop() === undefined) broken = true;
            }
        }
        const braces = stack.filter((s) => s.c === "{");
        const brackets = stack.filter((s) => s.c === "[").length;
        const prev = walk.slice(0, m.index).trimEnd().slice(-1);
        const topLevel =
            !broken &&
            braces.length === 1 &&
            brackets === 0 &&
            (prev === "{" || prev === ",");
        if (topLevel && isExportedObject(text, braces[0].at)) {
            return "unconditional";
        }
        result = "conditional";
    }
    return result;
}

/**
 * Strip `//` and block comments, but never inside a string, template literal
 * or regex literal. The shared lexer (keep-strings mode): comments become
 * same-width blanks, so offsets and newlines are preserved.
 */
export function stripCommentsStringAware(src: string): string {
    return stripComments(src);
}

/** Wrapper calls (`defineConfig(`, `withX(`) and an optional `(phase) => (` arrow. */
const WRAPPERS =
    "(?:async\\s*)?(?:[\\w$.]+\\s*\\(\\s*)*(?:(?:async\\s*)?(?:\\([^()]*\\)|[\\w$]+)\\s*=>\\s*\\(\\s*)?";
const INLINE_EXPORT = new RegExp(
    `(?:export\\s+default|module\\.exports\\s*=)\\s*${WRAPPERS}$`,
);
const BOUND_TO = new RegExp(
    `(?:const|let|var)\\s+([\\w$]+)\\s*(?::[^=]+)?=\\s*${WRAPPERS}$`,
);

/** Whether the object literal opening at `open` is the one the file exports. */
function isExportedObject(text: string, open: number): boolean {
    const before = text.slice(0, open);
    if (INLINE_EXPORT.test(before)) return true;
    const id = before.match(BOUND_TO)?.[1];
    return id !== undefined && isExportedIdentifier(text, id);
}

/** `export default <id>` (alone or as the first argument of a wrapper-call chain) / `module.exports = <id>`. */
function isExportedIdentifier(text: string, id: string): boolean {
    const escaped = id.replace(/\$/g, "\\$");
    const re = new RegExp(
        `(?:export\\s+default|module\\.exports\\s*=)\\s*${escaped}(?![\\w$])([^\\n;]*)`,
        "g",
    );
    // `export default withX(withY(<id>, { ...options }))`: the id is the first
    // whole argument of a call chain that begins the exported expression.
    const wrapped = new RegExp(
        `(?:export\\s+default|module\\.exports\\s*=)\\s*(?:[\\w$.]+\\s*\\(\\s*)+${escaped}\\s*[,)]`,
    );
    if (wrapped.test(text)) return true;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        // Only `as X` / `satisfies X` may follow on the line; `?`, `&&`, a
        // call or a member access make it a different expression.
        if (/^\s*((as|satisfies)\s+[\w$.<>\s]+)?$/.test(m[1])) return true;
    }
    return false;
}

function readConfigOrRefuse(
    readNextConfig: () => string | undefined,
): string | undefined {
    try {
        return readNextConfig();
    } catch (err) {
        throw new UsageError(
            `Could not read your next.config, which knext checks before it builds (a static export and a custom \`distDir\` are not supported) (${err instanceof Error ? err.message : String(err)}). Fix the file's permissions and try again.`,
        );
    }
}

/**
 * Every `distDir` key in the config text (comments stripped): a property
 * (`distDir:`, quoted, bare or a computed `['distDir']:`) or an assignment
 * (`x.distDir =`, `x['distDir'] =`). Each is either
 * a plain string literal (`literal`) or anything else (`raw`: an env var, a
 * ternary, a template with `${}`), which this text scan cannot evaluate.
 */
function distDirMentions(
    configText: string,
): { literal?: string; raw: string }[] {
    const out: { literal?: string; raw: string }[] = [];
    const text = stripCommentsStringAware(configText);
    for (const m of text.matchAll(
        /["'`]?\bdistDir["'`]?(?:\s*\])?\s*(?::|=(?![=>]))\s*([^,;}\n]*)/g,
    )) {
        const raw = (m[1] ?? "").trim();
        const lit = raw.match(/^(["'`])([^"'`\n]*)\1$/);
        out.push(
            lit && !lit[2].includes("${") ? { literal: lit[2], raw } : { raw },
        );
    }
    return out;
}

const UNREADABLE_DIST_DIR_MESSAGE = (
    raw: string,
) => `Your Next.js config sets \`distDir\` to \`${raw}\`, which knext cannot read before the build.

knext does not support a custom build directory yet, and its build, artifact and standalone steps
read the build output from \`.next\`. Remove \`distDir\` from your Next.js config (the default is
\`.next\`), or set it to the literal \`".next"\`, and build again.`;

const CUSTOM_DIST_DIR_MESSAGE = (
    distDir: string,
) => `Your Next.js config sets \`distDir: '${distDir}'\`, and knext does not support a custom build directory yet.

knext's build, artifact and standalone steps read the build output from \`.next\`, so a different
directory would produce a wrong artifact or fail later in the pipeline.
Remove \`distDir\` from your Next.js config (the default is \`.next\`) and build again.`;

/** True when `distDir` names the default `.next` (`.next`, `./.next`, `.next/`). */
function isDefaultDistDir(distDir: string): boolean {
    return (
        distDir.replace(/^\.\//, "").replace(/\/+$/, "") === DEFAULT_DIST_DIR
    );
}

/**
 * Before a Next build: refuse a custom `distDir` (#2251). Only the static-export
 * guard honours it; the build, artifact and standalone steps assume `.next`, so
 * half-supporting it gives a wrong artifact path or a confusing late failure.
 * Refused up front until the resolved value is threaded through. It reads the
 * config text, like the other guards here, and fails closed: every `distDir`
 * key must be a plain literal for the default, or the build is refused, so a
 * computed value (an env var, a ternary, a `${}` template) refuses too. It is a
 * best-effort text check, not an evaluation (#2250): not seen are a shorthand
 * property (`{ distDir }`), `Object.defineProperty`, a value set outside the
 * file, and builds that skip it (`build --skip-next`, `deploy --skip-build`).
 */
export function assertDefaultDistDir(
    cwd: string,
    readNextConfig: () => string | undefined = () => readNextConfigStrict(cwd),
): void {
    const text = readConfigOrRefuse(readNextConfig);
    if (text === undefined) return;
    for (const m of distDirMentions(text)) {
        if (m.literal === undefined)
            throw new UsageError(UNREADABLE_DIST_DIR_MESSAGE(m.raw));
        if (!isDefaultDistDir(m.literal))
            throw new UsageError(CUSTOM_DIST_DIR_MESSAGE(m.literal));
    }
}

/** After a Next build: refuse if it wrote an export marker into `distDir`. */
export function assertNotStaticExport(
    cwd: string,
    readNextConfig: () => string | undefined = () => readNextConfigStrict(cwd),
): void {
    const text = readConfigOrRefuse(readNextConfig);
    const distDir =
        (text === undefined ? undefined : configuredDistDir(text)) ??
        DEFAULT_DIST_DIR;
    if (existsSync(resolve(cwd, distDir, EXPORT_DETAIL_FILE))) {
        throw new UsageError(STATIC_EXPORT_MESSAGE);
    }
}

/** Before a vinext build: refuse an app whose config unconditionally asks for a static export. */
export function assertVinextNotStaticExport(
    cwd: string,
    readNextConfig: () => string | undefined = () => readNextConfigStrict(cwd),
    warn: (line: string) => void = (line) => {
        process.stderr.write(`${line}\n`);
    },
): void {
    const text = readConfigOrRefuse(readNextConfig);
    if (text === undefined) return;
    const kind = classifyStaticExport(text);
    if (kind === "unconditional") throw new UsageError(STATIC_EXPORT_MESSAGE);
    if (kind === "conditional") {
        warn(
            "warning: your next.config sets `output: 'export'` under a condition or inside a nested value; a static export is not a server deployment and knext deploys standalone only. Continuing the build.",
        );
    }
}
