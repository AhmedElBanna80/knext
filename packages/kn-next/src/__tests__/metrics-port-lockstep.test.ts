/**
 * metrics-port-lockstep — observability guard (#153 system-design review gap,
 * widened for #951).
 *
 * The app's metrics port is a PLATFORM CONTRACT with more than two parties:
 *
 *   1. the node runtime default        node-server.ts        `METRICS_PORT ?? <N>`
 *   2. the compiled-entry default      templates/app/knext-bun-entry.mjs.hbs
 *                                      (the canonical template; every checked-in
 *                                      copy is pinned to it byte-for-byte by
 *                                      scripts/lib/runtime-entry-copies.mjs)
 *   3. the operator scrape annotation  nextapp_controller.go `prometheus.io/port`
 *   4. the operator NetworkPolicy      nextapp_controller.go `appMetricsPort`
 *      (the metrics-scrape grants — same-namespace and the label-gated
 *      cross-namespace rule)
 *   5. the shipped PodMonitor          config/prometheus/app-podmonitor.yaml
 *
 * In production the operator does NOT inject a METRICS_PORT env, so the runtime
 * defaults and the operator's three port literals MUST be the same number. If
 * someone changes one without the others, Prometheus scrapes the wrong port, or
 * the NetworkPolicy blocks the scrape, and app metrics go dark silently.
 * This is AC2 of #951: annotation, NetworkPolicy grant, and entry bind port
 * cannot silently disagree.
 *
 * #951 adds a second invariant: the shared port must NOT be a port Knative's
 * queue-proxy sidecar owns inside the same pod network namespace. knext's old
 * default 9091 was literally Knative's UserQueueMetricsPort — the port
 * queue-proxy itself binds for its user-metrics server whenever serving's
 * `metrics.request-metrics-backend-destination` is active, which is the stock
 * install default. App and sidecar raced for the port, the app lost with
 * EADDRINUSE, and every scaffolded app crash-looped on a default Knative
 * cluster (S3-V Finding C-2). The default is now 9464 (the conventional
 * OpenTelemetry Prometheus-exporter port, unclaimed by queue-proxy).
 *
 * This is a pure cross-file guard: it reads the source files as text, extracts
 * each number, and asserts they are equal and non-colliding. It changes no
 * file. If any value cannot be located the test FAILS loudly (rather than
 * soft-skipping) so the guard can never silently no-op after a refactor.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { QUEUE_PROXY_OWNED_PORTS } from "../cli/doctor";

// repo root: packages/kn-next/src/__tests__ -> up 4
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

const RUNTIME_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next",
    "src",
    "adapters",
    "node-server.ts",
);
const ENTRY_TEMPLATE_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next",
    "templates",
    "app",
    "knext-bun-entry.mjs.hbs",
);
// The annotation is stamped in the ksvc builder; the NetworkPolicy grant lives
// in the network-policy file (nextapp_controller.go was split by concern).
const OPERATOR_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next-operator",
    "internal",
    "controller",
    "nextapp_ksvc.go",
);
const OPERATOR_NETPOL_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next-operator",
    "internal",
    "controller",
    "nextapp_networkpolicy.go",
);
const PODMONITOR_FILE = resolve(
    REPO_ROOT,
    "packages",
    "kn-next-operator",
    "config",
    "prometheus",
    "app-podmonitor.yaml",
);

const BUNEXEC_DOCKERFILE = resolve(
    REPO_ROOT,
    "examples",
    "bun-exec",
    "Dockerfile",
);
const BUNEXEC_ENTRY = resolve(
    REPO_ROOT,
    "examples",
    "bun-exec",
    "knext-bun-entry.mjs",
);

// QUEUE_PROXY_OWNED_PORTS is imported from cli/doctor.ts — ONE definition of
// "queue-proxy-owned", shared with the doctor check, so this guard and the
// runtime preflight cannot disagree about which ports are forbidden (#951):
//   8012 queue-proxy HTTP1, 8013 h2c, 8112 HTTPS, 8022 admin/drain,
//   9090 autoscaling metrics (always bound), 9091 user metrics (bound when the
//   request-metrics protocol is prometheus — the S3-V C-2 crash-loop).

/**
 * Runtime default: `process.env.METRICS_PORT ?? <N>`.
 * Tolerant of whitespace and numeric separators (e.g. 9_464).
 */
function extractMetricsPortDefault(src: string, file: string): number {
    const m = src.match(/process\.env\.METRICS_PORT\s*\?\?\s*([0-9][0-9_]*)/);
    if (!m) {
        throw new Error(
            `Could not find the METRICS_PORT default (process.env.METRICS_PORT ?? <N>) ` +
                `in ${file}. The lockstep guard cannot run — fix the regex or the source.`,
        );
    }
    return Number(m[1].replace(/_/g, ""));
}

/**
 * Operator scrape target: the Go assignment of the `prometheus.io/port` annotation
 * to a quoted numeric string, e.g.  annotations["prometheus.io/port"] = "9464".
 */
function extractOperatorScrapePort(src: string): number {
    const m = src.match(
        /["']prometheus\.io\/port["']\s*\]?\s*[:=]\s*["']([0-9]+)["']/,
    );
    if (!m) {
        throw new Error(
            `Could not find the prometheus.io/port annotation ("prometheus.io/port" = "<N>") ` +
                `in ${OPERATOR_FILE}. The lockstep guard cannot run — fix the regex or the source.`,
        );
    }
    return Number(m[1]);
}

/**
 * Operator NetworkPolicy grant: the `appMetricsPort` literal that feeds every
 * metrics-scrape ingress rule. Two accepted spellings:
 *   appMetricsPort = int32(9464)                                 (a literal)
 *   appMetricsPort = int32(knativenetworking.UserQueueMetricsPort) (the OLD,
 *     colliding alias — resolved to 9091 so the collision assertion below
 *     reports the REAL defect instead of an extraction failure)
 */
function extractNetworkPolicyMetricsPort(src: string): number {
    const literal = src.match(/appMetricsPort\s*=\s*int32\(([0-9][0-9_]*)\)/);
    if (literal) return Number(literal[1].replace(/_/g, ""));
    const alias = src.match(
        /appMetricsPort\s*=\s*int32\(knativenetworking\.UserQueueMetricsPort\)/,
    );
    if (alias) return 9091;
    throw new Error(
        `Could not find the appMetricsPort assignment (appMetricsPort = int32(<N>)) ` +
            `in ${OPERATOR_NETPOL_FILE}. The lockstep guard cannot run — fix the regex or the source.`,
    );
}

/** Shipped PodMonitor endpoint: `targetPort: <N>`. */
function extractPodMonitorTargetPort(src: string): number {
    const m = src.match(/targetPort:\s*([0-9]+)/);
    if (!m) {
        throw new Error(
            `Could not find the PodMonitor targetPort (targetPort: <N>) in ${PODMONITOR_FILE}. ` +
                `The lockstep guard cannot run — fix the regex or the source.`,
        );
    }
    return Number(m[1]);
}

/**
 * bun-exec Dockerfile: `METRICS_PORT=<N>` in the ENV block. This is the ONE
 * image CI actually builds and boots — the round-2 review found it still
 * pinned to 9091 after the platform moved, which made the alpine docker e2e
 * map a host port to a container port nothing binds. The EXPOSE line must
 * carry the same number.
 */
function extractDockerfileMetricsPort(src: string): number {
    const env = src.match(/^\s*(?:ENV\s+.*?)?METRICS_PORT=([0-9]+)/m);
    if (!env) {
        throw new Error(
            `Could not find METRICS_PORT=<N> in ${BUNEXEC_DOCKERFILE}. ` +
                `The lockstep guard cannot run — fix the regex or the source.`,
        );
    }
    const port = Number(env[1]);
    const expose = src.match(/^EXPOSE\s+(.+)$/m);
    if (!expose || !expose[1].split(/\s+/).includes(String(port))) {
        throw new Error(
            `${BUNEXEC_DOCKERFILE}: EXPOSE does not list the METRICS_PORT ${port} — ` +
                `the ENV and EXPOSE lines must move together.`,
        );
    }
    return port;
}

function allSurfaces(): Record<string, number> {
    return {
        "node-server.ts METRICS_PORT default": extractMetricsPortDefault(
            readFileSync(RUNTIME_FILE, "utf8"),
            RUNTIME_FILE,
        ),
        "knext-bun-entry.mjs.hbs METRICS_PORT default":
            extractMetricsPortDefault(
                readFileSync(ENTRY_TEMPLATE_FILE, "utf8"),
                ENTRY_TEMPLATE_FILE,
            ),
        "operator prometheus.io/port annotation": extractOperatorScrapePort(
            readFileSync(OPERATOR_FILE, "utf8"),
        ),
        "operator NetworkPolicy appMetricsPort":
            extractNetworkPolicyMetricsPort(
                readFileSync(OPERATOR_NETPOL_FILE, "utf8"),
            ),
        "PodMonitor targetPort": extractPodMonitorTargetPort(
            readFileSync(PODMONITOR_FILE, "utf8"),
        ),
        // The one image CI builds and boots — ENV + EXPOSE move together.
        "bun-exec Dockerfile METRICS_PORT": extractDockerfileMetricsPort(
            readFileSync(BUNEXEC_DOCKERFILE, "utf8"),
        ),
        // The bun-exec entry is a RECORDED divergence in the copy pin
        // (runtime-entry-copies.mjs), so a hash re-pin could smuggle a port
        // drift past the parity audit without touching the template. Reading
        // its default directly closes that hole (round-2 F4).
        "bun-exec knext-bun-entry.mjs METRICS_PORT default":
            extractMetricsPortDefault(
                readFileSync(BUNEXEC_ENTRY, "utf8"),
                BUNEXEC_ENTRY,
            ),
    };
}

describe("metrics-port lockstep (runtime defaults ↔ operator annotation ↔ NetworkPolicy ↔ PodMonitor)", () => {
    it("locates every value (fails loudly rather than silently no-op'ing)", () => {
        for (const [surface, port] of Object.entries(allSurfaces())) {
            expect(
                Number.isInteger(port),
                `${surface} did not parse to an integer`,
            ).toBe(true);
            expect(
                port,
                `${surface} parsed to a non-positive port`,
            ).toBeGreaterThan(0);
        }
    });

    it("every surface agrees on ONE metrics port (#951 AC2)", () => {
        const surfaces = allSurfaces();
        const ports = new Set(Object.values(surfaces));
        expect(
            ports.size,
            `Metrics-port drift across the platform contract — these must all be the same ` +
                `number or scraping/NetworkPolicy/the entry bind silently disagree:\n` +
                Object.entries(surfaces)
                    .map(([k, v]) => `  ${v}  ${k}`)
                    .join("\n"),
        ).toBe(1);
    });

    it("the shared port is NOT a queue-proxy-owned port (#951 — EADDRINUSE crash-loop on stock Knative)", () => {
        const surfaces = allSurfaces();
        for (const [surface, port] of Object.entries(surfaces)) {
            expect(
                QUEUE_PROXY_OWNED_PORTS.has(port),
                `${surface} is ${port}, which Knative's queue-proxy owns inside the pod. ` +
                    `On a stock serving install (default config-observability) queue-proxy binds ` +
                    `:9091 for its user-metrics server, the app loses the race, exits EADDRINUSE, ` +
                    `and the revision crash-loops (issue #951, S3-V Finding C-2). Pick a port ` +
                    `outside {8012, 8013, 8022, 8112, 9090, 9091}.`,
            ).toBe(false);
        }
    });

    // Self-test of the extraction logic so the guard can't drift into a no-op:
    // proves a hypothetical divergence WOULD be caught.
    it("self-test: detects a divergence in any extracted value", () => {
        expect(
            extractMetricsPortDefault(
                "const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9464);",
                "inline",
            ),
        ).toBe(9464);
        expect(
            extractOperatorScrapePort(
                'annotations["prometheus.io/port"] = "9464"',
            ),
        ).toBe(9464);
        expect(
            extractNetworkPolicyMetricsPort(
                "appMetricsPort        = int32(9464)",
            ),
        ).toBe(9464);
        // The OLD colliding alias resolves to 9091 so the collision assertion
        // fires on it instead of the extractor throwing.
        expect(
            extractNetworkPolicyMetricsPort(
                "appMetricsPort        = int32(knativenetworking.UserQueueMetricsPort)",
            ),
        ).toBe(9091);
        expect(extractPodMonitorTargetPort("    - targetPort: 9464")).toBe(
            9464,
        );
        expect(
            extractDockerfileMetricsPort(
                "ENV PORT=3000 \\\n    METRICS_PORT=9464 \\\n    NODE_ENV=production\n\nEXPOSE 3000 9464\n",
            ),
        ).toBe(9464);
        // An ENV/EXPOSE mismatch is an extraction FAILURE, not a silent pass.
        expect(() =>
            extractDockerfileMetricsPort(
                "ENV METRICS_PORT=9464\nEXPOSE 3000 9091\n",
            ),
        ).toThrow(/EXPOSE does not list/);
        // A drifted operator value would surface as 9464 !== 9099 above.
        const drifted = extractOperatorScrapePort(
            'annotations["prometheus.io/port"] = "9099"',
        );
        expect(drifted).not.toBe(9464);
    });
});

// ── #2432 (S7-8): the FFI package and the function templates ───────────────
//
// Neither surface assigned a metrics port number when this block was written:
// the FFI slow-call counters and load gauge are published on a globalThis seam
// and appended to the app's :9464 exposition, and the Rust/Go function templates
// bind only the serving $PORT (default 8080), which is not a metrics port. So the
// check SCANS rather than enumerating call sites: every line that talks about
// metrics or Prometheus and carries a port-shaped number must carry 9464. A new
// `metrics_port = 9091` in a crate, or a stale `port 9091` in the FFI docs, turns
// this red with no file added to a list.

const FFI_SCAN_ROOTS = [
    resolve(REPO_ROOT, "packages", "ffi"),
    resolve(REPO_ROOT, "templates", "rust"),
    resolve(REPO_ROOT, "templates", "go"),
];
// The user-facing page for the FFI metrics. It lives in apps/docs, outside the
// package roots, so it is named explicitly.
const FFI_DOC_PAGE = resolve(
    REPO_ROOT,
    "apps",
    "docs",
    "content",
    "docs",
    "rust-in-process.mdx",
);
// Build output and dependency trees are not source. `vendor/` is deliberately
// NOT skipped: a vendored crate is scanned like any other file.
const SCAN_SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git"]);

const METRIC_LINE = /metric|prometheus/i;
const PORT_FORMS: RegExp[] = [
    // host:port, e.g. http://127.0.0.1:9464/metrics
    /:(\d{4,5})(?![\d.])/g,
    // port: 9464 · METRICS_PORT=9464 · metrics port `9464` · prometheus.io/port"] = "9464"
    /(?:^|[^a-z])ports?(?![a-z])\D{0,24}?(\d{4,5})(?![\d.])/gi,
];

interface PortOccurrence {
    file: string;
    line: number;
    port: number;
}

/**
 * Every port-shaped number on a metrics or Prometheus line. A line with no
 * metrics word is not a metrics surface, so the serving `$PORT` is ignored.
 */
function metricsPortsIn(text: string, file: string): PortOccurrence[] {
    const out: PortOccurrence[] = [];
    text.split("\n").forEach((line, i) => {
        if (!METRIC_LINE.test(line)) return;
        for (const re of PORT_FORMS) {
            for (const m of line.matchAll(re)) {
                out.push({ file, line: i + 1, port: Number(m[1]) });
            }
        }
    });
    return out;
}

function sourceFilesUnder(root: string): string[] {
    const out: string[] = [];
    for (const ent of readdirSync(root, { withFileTypes: true })) {
        if (SCAN_SKIP_DIRS.has(ent.name)) continue;
        const p = join(root, ent.name);
        if (ent.isDirectory()) out.push(...sourceFilesUnder(p));
        else if (ent.isFile()) out.push(p);
    }
    return out;
}

function ffiSurfaceMetricsPorts(): {
    scanned: number;
    occurrences: PortOccurrence[];
} {
    const files = [...FFI_SCAN_ROOTS.flatMap(sourceFilesUnder), FFI_DOC_PAGE];
    const occurrences: PortOccurrence[] = [];
    let scanned = 0;
    for (const file of files) {
        const buf = readFileSync(file);
        if (buf.includes(0)) continue; // binary: no metrics text to read
        scanned++;
        occurrences.push(...metricsPortsIn(buf.toString("utf8"), file));
    }
    return { scanned, occurrences };
}

describe("metrics-port lockstep — FFI package and function templates (#2432)", () => {
    it("every metrics port the FFI package and the function templates set or document is 9464", () => {
        const { occurrences } = ffiSurfaceMetricsPorts();
        const drift = occurrences
            .filter((o) => o.port !== 9464)
            .map(
                (o) => `${relative(REPO_ROOT, o.file)}:${o.line} -> ${o.port}`,
            );
        expect(
            drift,
            `FFI / function-template metrics port drift — must be 9464 (the app's ` +
                `shared metrics port, locksteped by the tests above):\n  ${drift.join("\n  ")}`,
        ).toEqual([]);
    });

    it("the scan is not vacuous: the FFI package names the metrics port it is locked to", () => {
        const { scanned, occurrences } = ffiSurfaceMetricsPorts();
        expect(scanned, "the FFI scan read no files").toBeGreaterThan(0);
        const ffiRoot = resolve(REPO_ROOT, "packages", "ffi") + sep;
        const inFfi = occurrences.filter((o) => o.file.startsWith(ffiRoot));
        expect(
            inFfi.length,
            "packages/ffi names no metrics port, so the lock above has nothing to bind to. " +
                "Document the port where the FFI metrics are described (packages/ffi/src/EGM.md).",
        ).toBeGreaterThan(0);
    });

    it("self-test: reads each port form, ignores serving ports and non-metrics numbers", () => {
        const ports = (text: string) =>
            metricsPortsIn(text, "inline").map((o) => o.port);
        // The env-default form the runtime entries use.
        expect(
            ports(
                "const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9464);",
            ),
        ).toEqual([9464]);
        // A scrape URL.
        expect(ports("GET http://127.0.0.1:9464/metrics")).toEqual([9464]);
        // A prose port, backticked.
        expect(ports("served on the app's metrics port `9464`")).toEqual([
            9464,
        ]);
        // A drifted value is read, so the lock above would report it.
        expect(ports("metrics port `9091`")).toEqual([9091]);
        // The serving port is not a metrics port: no metrics word, no finding.
        expect(
            ports('PORT=8080 serves the function; listen_port(Some("9090"))'),
        ).toEqual([]);
        // A metrics line with no port form (a year, a count) is not a port.
        expect(
            ports("the metrics exposition since 2026, 1024 entries"),
        ).toEqual([]);
    });
});
