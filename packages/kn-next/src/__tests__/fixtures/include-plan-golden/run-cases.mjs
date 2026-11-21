// Golden runner for the compile.include planner.
//
//   bun run-cases.mjs <module-with-planIncludes-and-planEmbed.mjs>
//
// Builds ONE deterministic fixture tree in a temp dir, runs every case through
// the given planner module and prints JSON (roots replaced by "<root>"). The
// committed `golden.json` is this script's output for the BASE planner (the
// Bun.Glob implementation), generated under Bun:
//
//   git archive personal/integration/v2 packages/kn-next/src/adapters | tar -x -C "$TMP"
//   bun packages/kn-next/src/__tests__/fixtures/include-plan-golden/run-cases.mjs \
//       "$TMP/packages/kn-next/src/adapters/compile-embed.mjs" \
//       > packages/kn-next/src/__tests__/fixtures/include-plan-golden/golden.json
//
// include-plan-golden.test.ts then asserts the NEW planner reproduces it
// byte-for-byte under node and under bun.
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const put = (p, body = "export default 1;\n") => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
};

export function buildFixture() {
    const base = realpathSync(
        mkdtempSync(join(tmpdir(), "knext-include-golden-")),
    );
    const root = join(base, "app");
    const outside = join(base, "outside");
    for (const f of ["a", "b", "c", "f1", "f2", "Case"])
        put(join(root, `lib/${f}.js`));
    put(join(root, "lib/x.ts"));
    put(join(root, "lib/m.mjs"));
    put(join(root, "lib/z.cjs"));
    put(join(root, "lib/.hidden.js"));
    put(join(root, "lib/.dot/inner.js"));
    put(join(root, "lib/deep/d1.js"));
    put(join(root, "lib/deep/.d2.js"));
    put(join(root, "shared/s.js"));
    put(join(root, "shared/.sd.js"));
    put(join(outside, "o.js"));
    put(join(root, ".output/server/index.mjs"));
    put(join(root, ".output/server/chunk.mjs"));
    put(join(root, "node_modules/pkg/index.js"));
    symlinkSync(join(root, "shared"), join(root, "lib/linkdir")); // in-root symlinked dir
    symlinkSync(outside, join(root, "lib/outdir")); // symlinked dir leaving the root
    return { base, root };
}

export const CASES = [
    ...[
        ["lib/*.js"], // `*` vs dotfiles
        ["lib/**/*.js"], // `**` vs dot dirs and symlinked dirs
        ["lib/**"],
        ["./lib/**/*.js"], // leading ./ (a documented form)
        ["./lib/*.js"],
        ["./lib"],
        ["lib/[ab].js"], // character class
        ["lib/f[0-9].js"],
        ["lib/[!a].js"],
        ["lib/{a,b}.js"],
        ["lib/?.js"],
        ["lib/.*.js"], // explicit dot
        ["lib/**/.*.js"],
        ["lib/c*.js"], // case sensitivity: matches c.js only
        ["lib/C*.js"], // matches Case.js only
        ["lib/case*.js"], // matches nothing (Case.js differs in case)
        ["lib/b.js", "lib/a.js"], // ordering follows the sorted plan, not the pattern order
        ["lib/*.ts", "lib/*.js"],
        ["lib/linkdir/**"], // ** into a symlinked directory inside the root
        ["lib/linkdir/*.js"],
        ["lib/outdir/**"], // ** into a symlinked directory outside the root
        [".output/server/*.mjs"], // the entry matched by its own include glob
        [".output/server/index.mjs"],
        ["node_modules/**/*.js"],
    ].map((include) => ({ fn: "planIncludes", include })),
    ...[
        [["lib/**/*.js"], ["lib/a.js"]],
        [["lib/**/*.js"], ["**/a.js"]],
        [["lib/**/*.js"], ["./lib/a.js"]], // leading ./ in an exclude
        [["lib/**/*.js"], ["lib/*.ts"]],
        [["lib/**/*.js"], ["lib/.*"]],
        [["lib/**/*.js"], ["lib/**/.*.js"]],
        [["lib/**/*.js"], ["lib/A.js"]], // case
        [["lib/**/*.js"], ["lib/Case.js"]],
        [["lib/**/*.js"], ["lib/{a,b}.js"]],
        [["lib/**/*.js"], ["lib/deep/**"]],
        [["lib"], ["lib/deep"]],
    ].map(([include, exclude]) => ({ fn: "planEmbed", include, exclude })),
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const mod = await import(pathToFileURL(process.argv[2]).href);
    const { base, root } = buildFixture();
    try {
        const rel = (s) => s.split(root).join("<root>");
        const out = CASES.map((c) => {
            try {
                const plan =
                    c.fn === "planIncludes"
                        ? mod.planIncludes(root, c.include)
                        : mod.planEmbed({
                              root,
                              include: c.include,
                              exclude: c.exclude,
                          });
                return {
                    ...c,
                    relpaths: plan.relpaths,
                    entrypoints: plan.entrypoints.map((e) => relative(root, e)),
                    report: plan.report,
                };
            } catch (e) {
                return { ...c, error: rel(String(e?.message ?? e)) };
            }
        });
        console.log(JSON.stringify(out, null, 2));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
}
