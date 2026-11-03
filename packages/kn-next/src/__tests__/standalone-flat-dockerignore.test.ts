/**
 * #2609 — the flat (non-monorepo) standalone target must not change.
 *
 * The nested-core ignore (`coreHostModules`) exists for a bun workspace. A flat
 * app (its own `node_modules/@getknext/core`, no tracing root above it) already
 * builds a bootable image, so its `.dockerignore` must stay BYTE-IDENTICAL to
 * the output that shipped before #2609. Excluding a flat app's real
 * `@getknext/core/node_modules` would silently swap the pino / prom-client
 * versions the app's own install resolved for the standalone-deps install.
 *
 * The fixture is the pre-#2609 `standaloneDockerignore({ nested: false })`
 * output, captured from the integration base, not regenerated from the code
 * under test.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    stageStandaloneBuildContext,
    standaloneDockerignore,
} from "../cli/runtime-image";

const FLAT_FIXTURE = join(
    __dirname,
    "fixtures",
    "standalone-dockerignore.flat.txt",
);

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

function flatApp(files: Record<string, string>): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-2609-flat-")));
    tempRoots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    return base;
}

describe("#2609: the flat standalone target's .dockerignore is unchanged", () => {
    it("standaloneDockerignore({ nested: false }) is byte-identical to the pre-#2609 output", () => {
        expect(standaloneDockerignore({ nested: false })).toBe(
            readFileSync(FLAT_FIXTURE, "utf8"),
        );
    });

    it("staging a flat app whose @getknext/core is a REAL directory with its own node_modules writes the same file", () => {
        // A flat install: @getknext/core is a plain directory, and its own
        // node_modules holds real packages. Nothing about it is a workspace link,
        // so the image must keep carrying it exactly as it did before #2609.
        const app = flatApp({
            "package.json": "{}",
            "next.config.js": 'module.exports = { output: "standalone" };\n',
            "node_modules/@getknext/core/package.json":
                '{"name":"@getknext/core"}',
            "node_modules/@getknext/core/dist/adapters/node-server.js":
                'require("pino");\n',
            "node_modules/@getknext/core/node_modules/pino/package.json":
                '{"name":"pino","version":"9.6.0"}',
            "node_modules/@getknext/core/node_modules/pino/index.js":
                "module.exports = {};\n",
        });
        const { dockerfile } = stageStandaloneBuildContext({
            cwd: app,
            buildContext: app,
        });
        expect(readFileSync(`${dockerfile}.dockerignore`, "utf8")).toBe(
            readFileSync(FLAT_FIXTURE, "utf8"),
        );
    });
});
