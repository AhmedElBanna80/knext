/**
 * seam-family-allowlists.test.ts — every metrics seam that reaches :9464 passes
 * only the families its emitter declares.
 *
 * The CDN counters (`cdn-edge.cjs`, plus the purge registry), the `'use cache'`
 * counters (`use-cache-handler.js`) and the in-process Rust counters reach the
 * metrics port through `globalThis` seams. Two readers append them:
 * `deep-health-lite.ts` (the loopback listener the standalone supervisor
 * merges) and the self-contained supervisor's in-process port. Both now keep
 * only each seam's named families, so the closed set the threat model lists is
 * enforced at the reader rather than trusted to whatever publishes the seam.
 * The allowlists are pinned to what the emitters actually render, so a new
 * family reds here until it is added on purpose.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as lite from "../adapters/deep-health-lite";

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTERS = resolve(here, "../adapters");

// biome-ignore lint/suspicious/noExplicitAny: CJS module without types
const selfContained: any = (() => {
    // Requiring the supervisor installs its process hooks unless this marker
    // is set, as in cdn-metrics-seam.test.ts.
    // biome-ignore lint/suspicious/noExplicitAny: node:http internals
    const http: any = require("node:http");
    const INSTALLED = Symbol.for("knext.selfContainedSupervisor.installed");
    const was = http[INSTALLED];
    http[INSTALLED] = true;
    try {
        return require(
            join(ADAPTERS, "standalone-self-contained-supervisor.cjs"),
        );
    } finally {
        if (was === undefined) delete http[INSTALLED];
        else http[INSTALLED] = was;
    }
})();

const CDN_SEAM = Symbol.for("knext.core.cdn.renderMetrics");
const USE_CACHE_SEAM = Symbol.for("knext.core.useCache.renderMetrics");
const g = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
    delete g[CDN_SEAM];
    delete g[USE_CACHE_SEAM];
});

const FOREIGN = [
    "# TYPE knext_http_requests_total counter",
    'knext_http_requests_total{method="GET"} 9',
    "# TYPE knext_cdn_edge_decision_total_extra counter",
    "knext_cdn_edge_decision_total_extra 1",
    "",
].join("\n");

const CDN_TEXT = [
    "# TYPE knext_cdn_edge_decision_total counter",
    'knext_cdn_edge_decision_total{result="edge",reason="ok"} 3',
    "# TYPE knext_cdn_foreign_edge_strip_total counter",
    "knext_cdn_foreign_edge_strip_total 1",
    "# TYPE knext_cdn_purge_total counter",
    'knext_cdn_purge_total{provider="cloudflare",result="ok"} 2',
    "",
].join("\n");

const USE_CACHE_TEXT = [
    "# TYPE knext_use_cache_events_total counter",
    'knext_use_cache_events_total{event="hit"} 4',
    "",
].join("\n");

const typeFamilies = (src: string) =>
    [
        ...new Set(
            [...src.matchAll(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) /gm)].map(
                (m) => m[1],
            ),
        ),
    ].sort();

describe("the allowlists are the families the emitters render", () => {
    // Read from each emitter's RENDERED output, not its source text, so a
    // family added through a template or a constant is still seen.
    it("CDN: the edge counters cdn-edge.cjs renders plus the purge counter", async () => {
        // biome-ignore lint/suspicious/noExplicitAny: CJS module without types
        const edge: any = require(join(ADAPTERS, "cdn-edge.cjs"));
        const { renderCdnPurgeMetrics } = await import(
            "../adapters/cdn-purge/metrics.js"
        );
        const emitted = [
            ...new Set([
                ...typeFamilies(edge.renderEdgeDecisionMetrics()),
                ...typeFamilies(renderCdnPurgeMetrics()),
            ]),
        ].sort();
        expect(emitted.length).toBe(3);
        expect([...lite.CDN_METRIC_FAMILIES].sort() as string[]).toEqual(
            emitted,
        );
        expect([...selfContained.CDN_METRIC_FAMILIES].sort()).toEqual(emitted);
    });

    it("'use cache': the families the use-cache handler renders", async () => {
        const { renderUseCacheMetrics } = await import(
            "../adapters/use-cache-handler.js"
        );
        const emitted = typeFamilies(renderUseCacheMetrics());
        expect(emitted.length).toBeGreaterThan(0);
        expect([...lite.USE_CACHE_METRIC_FAMILIES].sort() as string[]).toEqual(
            emitted,
        );
        expect([...selfContained.USE_CACHE_METRIC_FAMILIES].sort()).toEqual(
            emitted,
        );
    });
});

describe("deep-health-lite drops any family a seam renders outside its allowlist", () => {
    it("CDN", () => {
        g[CDN_SEAM] = () => CDN_TEXT + FOREIGN;
        expect(lite.readCdnMetrics()).toBe(CDN_TEXT);
    });

    it("'use cache'", () => {
        g[USE_CACHE_SEAM] = () => USE_CACHE_TEXT + FOREIGN;
        expect(lite.readUseCacheMetrics()).toBe(USE_CACHE_TEXT);
    });
});

describe("the self-contained in-process port drops it too", () => {
    it("CDN and 'use cache', in that order, each on one newline", () => {
        g[CDN_SEAM] = () => CDN_TEXT + FOREIGN;
        g[USE_CACHE_SEAM] = () => USE_CACHE_TEXT + FOREIGN;
        expect(selfContained.readSeamMetrics()).toBe(CDN_TEXT + USE_CACHE_TEXT);
    });

    it("is empty without the seams", () => {
        expect(selfContained.readSeamMetrics()).toBe("");
    });
});

// A histogram (or summary) family's sample lines carry a `_bucket` / `_sum` /
// `_count` suffix its HELP and TYPE lines do not. Matching the family name
// exactly would keep the TYPE line and drop every sample.
const HISTOGRAM = [
    "# HELP knext_test_seconds a histogram",
    "# TYPE knext_test_seconds histogram",
    'knext_test_seconds_bucket{le="0.1"} 1',
    'knext_test_seconds_bucket{le="+Inf"} 2',
    "knext_test_seconds_sum 0.3",
    "knext_test_seconds_count 2",
    "",
].join("\n");
// Suffixed names whose base is NOT allowed, and an allowed base with a suffix
// the exposition format does not define: all dropped.
const HISTOGRAM_FOREIGN = [
    "knext_other_seconds_bucket 1",
    "knext_other_seconds_count 1",
    "knext_test_seconds_extra 1",
    "# TYPE knext_test_seconds_count counter",
    "",
].join("\n");

describe("a histogram family keeps its _bucket, _sum and _count samples", () => {
    it.each([
        ["deep-health-lite", () => lite.keepFamilies],
        ["the self-contained supervisor", () => selfContained.keepFamilies],
    ])("%s", (_name, get) => {
        const keep = get() as (b: string, f: readonly string[]) => string;
        expect(
            keep(HISTOGRAM + HISTOGRAM_FOREIGN, ["knext_test_seconds"]),
        ).toBe(HISTOGRAM);
    });
});
