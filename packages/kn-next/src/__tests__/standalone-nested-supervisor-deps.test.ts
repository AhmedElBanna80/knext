/**
 * #2609 — the standalone image must not carry host symlinks for the
 * supervisor's own dependencies.
 *
 * A bun workspace installs `@getknext/core` as a symlink into the workspace
 * (`node_modules/@getknext/core -> ../../packages/kn-next`), and nests that
 * package's dependencies as RELATIVE symlinks into the content-addressed
 * `node_modules/.bun` store (`packages/kn-next/node_modules/pino ->
 * ../../../node_modules/.bun/pino@9.14.0/node_modules/pino`).
 *
 * The standalone Dockerfile COPYs the whole package
 * (`COPY node_modules/@getknext/core /app/node_modules/@getknext/core`). Docker
 * follows the top-level source but copies every nested symlink VERBATIM, so
 * inside the image `/app/node_modules/@getknext/core/node_modules/pino` points
 * at `/app/node_modules/.bun/...`, which is not in the image: the supervisor
 * crash-loops with ENOENT reading that path. `next build` never traces it,
 * because the supervisor entry is outside Next's graph.
 *
 * The fix keeps that host subtree out of the COPY (a `.dockerignore` pattern),
 * so the module resolution falls through to the `standalone-deps` stage, which
 * installs the supervisor's closure with a real package manager. The closure
 * below walks the COPY source the way the builder does and asserts that no
 * symlink survives.
 *
 * The file-manager reference app must also resolve a nested standalone layout
 * from its committed next.config, with no hand edits: a bun workspace's lockfile
 * sits at the repo root, so Next's inferred tracing root is above the app, and
 * knext only packages that layout for an EXPLICIT root.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
    dockerignoreExcludes,
    runtimeStandaloneTemplateDir,
    stageStandaloneBuildContext,
} from "../cli/runtime-image";
import { resolveStandaloneLayout } from "../cli/standalone-layout";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

// packages/kn-next/src/__tests__ -> repo root (../../../../)
const REPO_ROOT = realpathSync(resolve(__dirname, "..", "..", "..", ".."));

const WEB_CONFIG = `const path = require("node:path");
module.exports = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "..", ".."),
    turbopack: { root: path.join(__dirname, "..", "..") },
};
`;

/** Write files, and create symlinks, under a fresh real temp root. */
function tree(
    files: Record<string, string>,
    links: Record<string, string> = {},
): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-2609-")));
    tempRoots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    for (const [rel, target] of Object.entries(links)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        symlinkSync(target, abs);
    }
    return base;
}

/**
 * A bun-workspace install of an app at `apps/web` whose `@getknext/core` is
 * hoisted to the workspace root (`root`) or installed by the app itself (`app`).
 * The nested `pino` is a relative symlink into `node_modules/.bun`, exactly as
 * bun's isolated linker writes it.
 */
function bunWorkspace(coreAt: "root" | "app"): string {
    const coreDir =
        coreAt === "root" ? "node_modules" : "apps/web/node_modules";
    const coreRel = relativeFromTo(`${coreDir}/@getknext`, "packages/kn-next");
    return tree(
        {
            "package.json": "{}",
            "bun.lock": "{}",
            "apps/web/package.json": "{}",
            "apps/web/next.config.js": WEB_CONFIG,
            "packages/kn-next/package.json": '{"name":"@getknext/core"}',
            "packages/kn-next/dist/adapters/node-server.js":
                'require("pino");\n',
            "node_modules/.bun/pino@9.14.0/node_modules/pino/package.json":
                '{"name":"pino"}',
            "node_modules/.bun/pino@9.14.0/node_modules/pino/index.js":
                "module.exports = {};\n",
        },
        {
            [`${coreDir}/@getknext/core`]: coreRel,
            "packages/kn-next/node_modules/pino":
                "../../../node_modules/.bun/pino@9.14.0/node_modules/pino",
        },
    );
}

/** `../` steps from `from` (a directory, repo-relative) to `to`. */
function relativeFromTo(from: string, to: string): string {
    const depth = from.split("/").length;
    return `${"../".repeat(depth)}${to}`;
}

interface Entry {
    readonly path: string;
    readonly symlink: boolean;
}

/**
 * Every entry a `COPY <srcRel>` carries, as the builder sees it: the COPY
 * source itself is resolved through its symlink, every entry below it is
 * taken verbatim (a symlink is not followed), and `.dockerignore` removes
 * whatever it excludes.
 */
function copyClosure(context: string, srcRel: string, ignore: string): Entry[] {
    const out: Entry[] = [];
    const walk = (abs: string, rel: string): void => {
        if (dockerignoreExcludes(ignore, rel)) return;
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) {
            out.push({ path: rel, symlink: true });
            return;
        }
        if (st.isDirectory()) {
            for (const name of readdirSync(abs)) {
                walk(join(abs, name), `${rel}/${name}`);
            }
            return;
        }
        out.push({ path: rel, symlink: false });
    };
    // The context is filtered on REAL paths: the client walks the directory
    // tree and sends a symlink as a symlink, so `node_modules/@getknext/core`
    // (a link into the workspace) never carries the package's files under that
    // name. The COPY resolves the link inside the already-filtered snapshot, so
    // the ignore must be evaluated against where the files really live.
    const realContext = realpathSync(context);
    const realSrc = realpathSync(join(context, srcRel));
    walk(realSrc, relative(realContext, realSrc).split(sep).join("/"));
    return out;
}

describe("#2609: the supervisor's COPY never carries host symlinks", () => {
    for (const coreAt of ["root", "app"] as const) {
        it(`@getknext/core installed at the ${coreAt} still ships no symlink into the image`, () => {
            const root = bunWorkspace(coreAt);
            const app = join(root, "apps", "web");
            stageStandaloneBuildContext({ cwd: app, buildContext: root });
            const ignore = readFileSync(
                join(app, "Dockerfile.standalone.dockerignore"),
                "utf8",
            );
            const coreSrc =
                coreAt === "root"
                    ? "node_modules/@getknext/core"
                    : "apps/web/node_modules/@getknext/core";
            const closure = copyClosure(root, coreSrc, ignore);

            // Not vacuous: the package's own files are carried.
            expect(closure.map((e) => e.path)).toContain(
                "packages/kn-next/dist/adapters/node-server.js",
            );
            // The bug: the nested pino link survives the COPY and dangles.
            expect(closure.filter((e) => e.symlink).map((e) => e.path)).toEqual(
                [],
            );
        });
    }

    it("the supervisor closure the image installs itself covers the names the nested tree held", () => {
        const template = readFileSync(
            join(runtimeStandaloneTemplateDir(), "Dockerfile.standalone.hbs"),
            "utf8",
        );
        expect(template).toContain("pino@^9.6.0");
        expect(template).toContain("prom-client@^15.1.3");
        expect(template).toContain("@opentelemetry/api@^1.9.0");
    });
});

describe("#2609: file-manager builds a standalone layout from its committed config", () => {
    it("resolves nested mode, rooted at the workspace root, with no hand edits", () => {
        const layout = resolveStandaloneLayout(
            join(REPO_ROOT, "apps", "file-manager"),
        );
        expect(layout.nested).toBe(true);
        expect(layout.root).toBe(REPO_ROOT);
        expect(layout.appRel).toBe("apps/file-manager");
    });
});
