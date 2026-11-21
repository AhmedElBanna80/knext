/**
 * `planIncludes` is runtime-neutral (node fs/path only), so the CLI (node) and
 * the compile script (bun) derive the same plan and refuse the same things. One
 * fixture, one case list, run under BOTH runtimes: the outputs must be
 * identical, and the security filters must actually fire (not merely agree on
 * silence).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const RUNNER = join(import.meta.dir, "fixtures", "include-plan-runner.mjs");

function write(path: string, body = "export default 1;\n") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
}

function fixture(): string {
    const base = mkdtempSync(join(tmpdir(), "knext-include-parity-"));
    tempDirs.push(base);
    const root = join(base, "app");
    const outside = join(base, "outside");
    write(join(root, "lib/a.js"));
    write(join(root, "lib/b.ts"));
    write(join(root, "lib/deep/c.mjs"));
    write(join(root, "lib/.hidden.js"));
    write(join(root, "lib/data.json"), "{}");
    write(join(root, "lib/[id]/page.js"));
    write(join(root, "lib/config/.env.js"));
    write(join(root, "lib/config/id_deploy.js"));
    write(join(root, "lib/addon.node"), "bin");
    write(join(root, "node_modules/pkg/index.js"));
    write(join(outside, "secret.js"));
    symlinkSync(join(outside, "secret.js"), join(root, "lib/link.js"));
    return root;
}

const CASES: string[][] = [
    ["lib/*.js"],
    ["lib/**/*.js"],
    ["lib/deep"],
    ["lib/{a,b}.*"],
    ["lib/[id]/page.js"], // a literal path that holds glob metacharacters
    ["lib/config/*.js"], // secrets by glob: refused
    ["lib/config/.env.js"], // secret named exactly: allowed
    ["lib/link.js"], // symlink escaping the root, named literally: refused
    ["lib/*.node"], // native addon by glob: refused
    ["lib/*.json"], // non-module: refused
    ["nothing/*.js"], // unmatched: refused
    ["/etc/passwd"], // absolute: refused
    ["lib/../../outside/secret.js"], // `..`: refused
    ["node_modules/**/*.js"], // never descends into node_modules
];

interface Result {
    include: string[];
    relpaths?: string[];
    error?: string;
}

function run(bin: string, root: string): Result[] {
    const r = spawnSync(bin, [RUNNER, root, JSON.stringify(CASES)], {
        encoding: "utf8",
    });
    expect(r.status, `${bin}: ${r.stderr}`).toBe(0);
    return JSON.parse(r.stdout) as Result[];
}

describe("planIncludes behaves identically under node and bun", () => {
    const root = fixture();
    const underNode = run("node", root);
    const underBun = run("bun", root);

    it("node and bun produce byte-identical plans and refusals", () => {
        expect(underBun).toEqual(underNode);
    });

    const byCase = (r: Result[], ...include: string[]) =>
        r.find((c) => JSON.stringify(c.include) === JSON.stringify(include));

    it("the plans are what the filters promise (under both runtimes)", () => {
        for (const r of [underNode, underBun]) {
            expect(byCase(r, "lib/deep")?.relpaths).toEqual(["lib/deep/c.js"]);
            expect(byCase(r, "lib/[id]/page.js")?.relpaths).toEqual([
                "lib/[id]/page.js",
            ]);
            expect(byCase(r, "lib/config/.env.js")?.relpaths).toEqual([
                "lib/config/.env.js",
            ]);
        }
    });

    it("each security filter actually fires (under both runtimes)", () => {
        const expectations: [string, RegExp][] = [
            ["lib/config/*.js", /look like secrets/],
            ["lib/link.js", /outside the app root/],
            ["lib/*.node", /native addons cannot be included/],
            ["lib/*.json", /JavaScript\/TypeScript modules only/],
            ["nothing/*.js", /no file matches/],
            ["/etc/passwd", /is absolute/],
            ["lib/../../outside/secret.js", /contains '\.\.'/],
        ];
        for (const r of [underNode, underBun]) {
            for (const [pattern, re] of expectations) {
                const c = byCase(r, pattern);
                expect(c?.error, `${pattern} must be refused`).toMatch(re);
            }
        }
    });
});
