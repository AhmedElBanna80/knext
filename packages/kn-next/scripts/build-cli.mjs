#!/usr/bin/env node
/**
 * build-cli.mjs (#68) — emit runnable JS for the kn-next CLI.
 *
 * Why esbuild and not bare `tsc`:
 *   The package source uses extensionless relative imports (`./exec`,
 *   `../config`) under TS `moduleResolution: "bundler"`. Plain `tsc` emit keeps
 *   those specifiers verbatim, which Node ESM rejects (it requires `./exec.js`).
 *   Rewriting every import across the package would be a large, out-of-scope
 *   change. esbuild bundles each CLI entry into a single self-contained ESM
 *   file with all relative deps inlined and `node:`/npm deps left external —
 *   so `node dist/cli/deploy.js` runs with no Bun and no extension fixups.
 *
 * Runtime safety: the bundle contains NO `import ... from "bun"` and NO
 * `Bun.*` — the CLI source was ported to `node:child_process` (see cli/exec.ts).
 * Bun stays supported because `node:child_process` works on both runtimes.
 */

import { build } from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const srcCli = join(pkgDir, "src", "cli");
const outDir = join(pkgDir, "dist", "cli");

/** CLI entry points that get a `#!/usr/bin/env node` shebang + chmod +x. */
const ENTRIES = ["deploy.ts", "build.ts", "cleanup.ts"];

await build({
    entryPoints: ENTRIES.map((f) => join(srcCli, f)),
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // Keep node builtins and npm deps external — only inline our own relative
    // source. `--packages=external` leaves every bare specifier (pino, yaml,
    // @google-cloud/storage, …) as a runtime `import`, resolved from
    // node_modules at install time.
    packages: "external",
    logLevel: "info",
});

// esbuild preserves the entry file's first-line shebang. Our source CLIs now
// start with `#!/usr/bin/env node`, so the emitted bin is a Node script. Assert
// it — a wrong/missing/duplicated shebang silently breaks `npx kn-next`.
for (const f of ENTRIES) {
    const out = join(outDir, f.replace(/\.ts$/, ".js"));
    const firstLine = readFileSync(out, "utf-8").split("\n", 1)[0];
    if (firstLine !== "#!/usr/bin/env node") {
        throw new Error(
            `build-cli: ${out} first line is "${firstLine}", expected "#!/usr/bin/env node".`,
        );
    }
}

// Mark the emitted entry files executable (npm does this for `bin` on install,
// but a local `node dist/cli/deploy.js` and direct `./dist/cli/deploy.js` both
// benefit from the +x bit being set).
for (const f of ENTRIES) {
    const out = join(outDir, f.replace(/\.ts$/, ".js"));
    chmodSync(out, 0o755);
}

// Sanity guard: the emitted deploy bin must be Bun-free (acceptance criterion).
const deployJs = readFileSync(join(outDir, "deploy.js"), "utf-8");
if (/from\s*["']bun["']/.test(deployJs) || /\bBun\.\w/.test(deployJs)) {
    // Re-stringify so the failure is loud in CI; never ship a Bun-coupled bin.
    writeFileSync(join(outDir, "deploy.js"), deployJs);
    throw new Error(
        "build-cli: emitted dist/cli/deploy.js still references Bun — refusing to ship.",
    );
}

console.log("[build-cli] emitted:", ENTRIES.map((f) => f.replace(/\.ts$/, ".js")).join(", "));
