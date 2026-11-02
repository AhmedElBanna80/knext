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

/**
 * The same bun-workspace app, but `@getknext/core` is a REAL directory (an
 * npm-style install, not a workspace link) with its OWN `node_modules`, whose
 * `pino` is a relative symlink into `node_modules/.bun`. This is the branch the
 * nested-core ignore must cover without a workspace link to resolve through.
 */
function bunWorkspaceRealCore(coreAt: "root" | "app"): {
    root: string;
    coreSrc: string;
} {
    const coreDir =
        coreAt === "root" ? "node_modules" : "apps/web/node_modules";
    const coreSrc = `${coreDir}/@getknext/core`;
    const root = tree(
        {
            "package.json": "{}",
            "bun.lock": "{}",
            "apps/web/package.json": "{}",
            "apps/web/next.config.js": WEB_CONFIG,
            [`${coreSrc}/package.json`]: '{"name":"@getknext/core"}',
            [`${coreSrc}/dist/adapters/node-server.js`]: 'require("pino");\n',
            "node_modules/.bun/pino@9.14.0/node_modules/pino/package.json":
                '{"name":"pino"}',
            "node_modules/.bun/pino@9.14.0/node_modules/pino/index.js":
                "module.exports = {};\n",
        },
        {
            [`${coreSrc}/node_modules/pino`]: relativeFromTo(
                `${coreSrc}/node_modules`,
                "node_modules/.bun/pino@9.14.0/node_modules/pino",
            ),
        },
    );
    return { root, coreSrc };
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

    for (const coreAt of ["root", "app"] as const) {
        it(`@getknext/core installed as a REAL directory at the ${coreAt} keeps its own files and drops its nested node_modules`, () => {
            const { root, coreSrc } = bunWorkspaceRealCore(coreAt);
            const app = join(root, "apps", "web");
            stageStandaloneBuildContext({ cwd: app, buildContext: root });
            const ignore = readFileSync(
                join(app, "Dockerfile.standalone.dockerignore"),
                "utf8",
            );
            const closure = copyClosure(root, coreSrc, ignore);

            // The package's own files are carried (a real dir, not a link).
            expect(closure.map((e) => e.path)).toContain(
                `${coreSrc}/dist/adapters/node-server.js`,
            );
            // Its nested pino link is not: no symlink reaches the image.
            expect(closure.filter((e) => e.symlink).map((e) => e.path)).toEqual(
                [],
            );
            expect(
                dockerignoreExcludes(ignore, `${coreSrc}/node_modules`),
            ).toBe(true);
        });
    }

    it("#2609: a workspace link whose target directory name starts with '..' is still named in the ignore", () => {
        // The package lives in a directory literally called `..foo`, which is a
        // normal name inside the context, not a parent-directory escape.
        const root = tree(
            {
                "package.json": "{}",
                "bun.lock": "{}",
                "apps/web/package.json": "{}",
                "apps/web/next.config.js": WEB_CONFIG,
                "..foo/kn-next/package.json": '{"name":"@getknext/core"}',
                "..foo/kn-next/dist/adapters/node-server.js":
                    'require("pino");\n',
                "node_modules/.bun/pino@9.14.0/node_modules/pino/package.json":
                    '{"name":"pino"}',
                "node_modules/.bun/pino@9.14.0/node_modules/pino/index.js":
                    "module.exports = {};\n",
            },
            {
                "node_modules/@getknext/core": "../../..foo/kn-next",
                "..foo/kn-next/node_modules/pino":
                    "../../../node_modules/.bun/pino@9.14.0/node_modules/pino",
            },
        );
        const app = join(root, "apps", "web");
        stageStandaloneBuildContext({ cwd: app, buildContext: root });
        const ignore = readFileSync(
            join(app, "Dockerfile.standalone.dockerignore"),
            "utf8",
        );
        expect(dockerignoreExcludes(ignore, "..foo/kn-next/node_modules")).toBe(
            true,
        );
        const closure = copyClosure(
            root,
            "node_modules/@getknext/core",
            ignore,
        );
        expect(closure.map((e) => e.path)).toContain(
            "..foo/kn-next/dist/adapters/node-server.js",
        );
        expect(closure.filter((e) => e.symlink).map((e) => e.path)).toEqual([]);
    });

    it("#2609: the nested-core ignore is anchored, so a traced .next/standalone copy under the same name is not excluded", () => {
        // `next build` may trace a `node_modules/@getknext/core/node_modules` tree
        // into `.next/standalone`, and the image COPYs that whole subtree. The
        // ignore must name only the COPY source's own node_modules, not any
        // path that happens to end the same way.
        const root = bunWorkspace("app");
        const app = join(root, "apps", "web");
        stageStandaloneBuildContext({ cwd: app, buildContext: root });
        const ignore = readFileSync(
            join(app, "Dockerfile.standalone.dockerignore"),
            "utf8",
        );
        expect(
            dockerignoreExcludes(
                ignore,
                "apps/web/.next/standalone/node_modules/@getknext/core/node_modules/pino/index.js",
            ),
        ).toBe(false);
        // The COPY source is a workspace link, so the ignore names the REAL
        // directory it resolves to: that package's own node_modules is excluded.
        expect(
            dockerignoreExcludes(
                ignore,
                "packages/kn-next/node_modules/pino/index.js",
            ),
        ).toBe(true);
    });
});

describe("#2609: the image installs the supervisor's closure itself", () => {
    // packages/kn-next/src/__tests__ -> packages/kn-next
    const PKG_ROOT = resolve(__dirname, "..", "..");
    /** The packages `@getknext/core/dist/adapters/node-server.js` loads. */
    const SUPERVISOR_RUNTIME_DEPS = [
        "pino",
        "prom-client",
        "@opentelemetry/api",
    ] as const;

    const template = readFileSync(
        join(runtimeStandaloneTemplateDir(), "Dockerfile.standalone.hbs"),
        "utf8",
    );

    /** The instruction lines of a `FROM ... AS <name>` stage, up to the next FROM. */
    function stageLines(name: string): string[] {
        const lines = template.split("\n");
        const start = lines.findIndex((l) =>
            new RegExp(`^FROM .* AS ${name}$`).test(l.trim()),
        );
        if (start < 0) throw new Error(`no stage named ${name}`);
        const out: string[] = [];
        for (const line of lines.slice(start + 1)) {
            if (line.startsWith("FROM ")) break;
            out.push(line.trim());
        }
        return out;
    }

    /** `name -> version spec` for every package in the stage's `npm install`. */
    function installSpecs(lines: string[]): Map<string, string> {
        // Join backslash continuations so the RUN instruction is one line.
        const joined: string[] = [];
        let acc = "";
        for (const l of lines) {
            if (l.endsWith("\\")) {
                acc += `${l.slice(0, -1)} `;
                continue;
            }
            joined.push(`${acc}${l}`);
            acc = "";
        }
        const run = joined.find((l) => /^RUN npm install\b/.test(l));
        if (!run) throw new Error("no `RUN npm install` in the stage");
        const specs = new Map<string, string>();
        for (const token of run.split(/\s+/).slice(3)) {
            if (token === "" || token.startsWith("-")) continue;
            const at = token.lastIndexOf("@");
            if (at <= 0) continue;
            specs.set(token.slice(0, at), token.slice(at + 1));
        }
        return specs;
    }

    it("every runtime stage that runs the supervisor COPYs the standalone-deps install", () => {
        for (const stage of ["standalone-bun", "standalone-node"]) {
            expect(stageLines(stage)).toContain(
                "COPY --from=standalone-deps /deps/node_modules /app/node_modules",
            );
        }
    });

    it("the standalone-deps install pins each supervisor runtime dependency to its package.json range", () => {
        const pkg = JSON.parse(
            readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
        ) as { dependencies: Record<string, string> };
        const specs = installSpecs(stageLines("standalone-deps"));
        for (const dep of SUPERVISOR_RUNTIME_DEPS) {
            const declared = pkg.dependencies[dep];
            expect(declared, `${dep} is a runtime dependency`).toBeDefined();
            expect(specs.get(dep), `${dep} is installed in the image`).toBe(
                declared,
            );
        }
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
