/**
 * runtime-contract-ffi-metrics.test.ts — the in-process Rust counters reach
 * :9464 on the vinext single-executable build (#2432).
 *
 * THE GAP. An app that opts into in-process Rust (`knext.ffi.json`) gets a
 * generated `bun:ffi` wrapper that counts slow calls and publishes a render
 * function under `Symbol.for('knext.ffi.renderMetrics')`. On the standalone
 * targets core's loopback listener appends it (`deep-health-lite`
 * `readSeamMetrics`). The vinext build serves :9464 in-process from the
 * runtime contract's `renderScrape`, which bridged only the deep-health family
 * from the loopback port and never read the seam, so the counters existed in
 * the process and on no port anything scrapes.
 *
 * THE FIX UNDER TEST. `renderScrape` appends the seam's text, read in-process
 * and fail-open (no seam, a throwing render, or a non-string result add
 * nothing). Without the opt-in the body is unchanged. Run against every copy of
 * the contract, like app-metrics-bridge.test.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");

/** Every copy of the contract. `.hbs` has no template syntax and loads as `.mjs`. */
const COPIES = [
    "packages/kn-next/templates/app/runtime-contract.mjs.hbs",
    "turbo/generators/templates/zone/runtime-contract.mjs.hbs",
    "apps/file-manager/runtime-contract.mjs",
    "apps/docs/runtime-contract.mjs",
    "examples/bun-exec/runtime-contract.mjs",
];

const SEAM = Symbol.for("knext.ffi.renderMetrics");
const g = globalThis as unknown as Record<symbol, unknown>;

/** What the generated wrapper renders once its library has loaded. */
const FFI_TEXT = [
    "# HELP knext_ffi_slow_calls_total In-process Rust calls slower than KNEXT_FFI_SLOW_CALL_MS.",
    "# TYPE knext_ffi_slow_calls_total counter",
    'knext_ffi_slow_calls_total{fn="stretch"} 2',
    "# HELP knext_ffi_load_seconds Time to load the in-process Rust library.",
    "# TYPE knext_ffi_load_seconds gauge",
    'knext_ffi_load_seconds{lib="zone"} 0.004',
    "",
].join("\n");

/** No child listener: port 1 refuses at once, so the bridge adds nothing. */
const NO_CHILD = { KN_CHILD_METRICS_PORT: "1" };

const tmpDirs: string[] = [];

afterEach(() => {
    delete g[SEAM];
    for (const d of tmpDirs.splice(0))
        rmSync(d, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: dynamic ESM import of an untyped .mjs
type Contract = Record<string, any>;

async function load(rel: string): Promise<Contract> {
    const src = join(REPO_ROOT, rel);
    let target = src;
    if (!src.endsWith(".mjs")) {
        const dir = mkdtempSync(join(tmpdir(), "knext-ffi-contract-"));
        tmpDirs.push(dir);
        target = join(dir, "runtime-contract.mjs");
        copyFileSync(src, target);
    }
    return import(`${pathToFileURL(target).href}?t=${Math.random()}`);
}

/** The exposition with its numbers masked: uptime moves between two renders. */
const shape = (body: string) =>
    body.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi, "N");

describe.each(COPIES)("runtime contract ffi seam: %s", (copy) => {
    it("appends the in-process Rust counters when the app publishes the seam", async () => {
        const c = await load(copy);
        g[SEAM] = () => FFI_TEXT;
        const body: string = await c.renderScrape(
            c.createMetricsState(),
            NO_CHILD,
        );
        expect(body).toContain("knext_bunexec_process_uptime_seconds");
        expect(body).toContain('knext_ffi_slow_calls_total{fn="stretch"} 2');
        expect(body).toContain('knext_ffi_load_seconds{lib="zone"} 0.004');
        expect(
            body.match(/^# TYPE knext_ffi_slow_calls_total /gm),
        ).toHaveLength(1);
        // One newline at the seam: no blank line, no glued lines.
        expect(body).not.toContain("\n\n");
        expect(body.endsWith("\n")).toBe(true);
    });

    it("without the opt-in the body is unchanged", async () => {
        const c = await load(copy);
        const state = c.createMetricsState();
        const base = c.renderMetrics(state);
        const body: string = await c.renderScrape(state, NO_CHILD);
        expect(shape(body)).toBe(shape(base));
        expect(body).not.toContain("knext_ffi");
    });

    it("fails open: a throwing render or a non-string result adds nothing", async () => {
        const c = await load(copy);
        const state = c.createMetricsState();
        const base = shape(c.renderMetrics(state));
        g[SEAM] = () => {
            throw new Error("render failed");
        };
        expect(shape(await c.renderScrape(state, NO_CHILD))).toBe(base);
        g[SEAM] = () => 42;
        expect(shape(await c.renderScrape(state, NO_CHILD))).toBe(base);
        g[SEAM] = "not a function";
        expect(shape(await c.renderScrape(state, NO_CHILD))).toBe(base);
    });

    it("names the seam with the generator's exact Symbol.for key, once", () => {
        const src = readFileSync(join(REPO_ROOT, copy), "utf8");
        const SQ = "Symbol.for('knext.ffi.renderMetrics')";
        const DQ = 'Symbol.for("knext.ffi.renderMetrics")';
        expect(src.split(SQ).length - 1 + (src.split(DQ).length - 1)).toBe(1);
    });
});
