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
import { join, relative, resolve } from "node:path";
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
// Neither surface owns a metrics port, and that is the invariant this block
// binds to code (not to prose):
//
//   * packages/ffi opens NO listener. Its slow-call counters and load gauge are
//     published on a globalThis seam (`Symbol.for('knext.ffi.renderMetrics')`);
//     the app runtime's metrics listener reads that seam and appends it to the
//     exposition it serves on :9464. So the FFI metrics are on 9464 BY
//     CONSTRUCTION: there is no FFI port to drift.
//   * the Go and Rust function templates bind only the serving $PORT (Knative
//     sets it; default 8080). A literal metrics port in either — `:9091`, a
//     `metrics_port: u16 = 9091` — would race queue-proxy exactly as #951 did.
//
// Scanning, not enumerating: whole files are read (multi-line safe) and every
// listener construct found is checked, so a new one in any file turns this red.

const FFI_SRC = resolve(REPO_ROOT, "packages", "ffi", "src");
const FFI_RENDER = resolve(FFI_SRC, "render.ts");
const RUNTIME_CONTRACT = resolve(
    REPO_ROOT,
    "packages",
    "kn-next",
    "templates",
    "app",
    "runtime-contract.mjs.hbs",
);
const FFI_SEAM_KEY = "knext.ffi.renderMetrics";
const FUNCTION_TEMPLATE_ROOTS = [
    resolve(REPO_ROOT, "templates", "go"),
    resolve(REPO_ROOT, "templates", "rust"),
];
// Build output and dependency trees are not source. `vendor/` and generated
// `gen/` code are third-party / protoc output, not the function's own binds.
const SCAN_SKIP_DIRS = new Set([
    "node_modules",
    "target",
    "dist",
    ".git",
    "vendor",
    "gen",
]);

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

const isTestPath = (p: string): boolean =>
    /(^|[\\/])(__tests__|e2e|conformance)[\\/]/.test(p) ||
    /\.test\.[cm]?[jt]s$/.test(p) ||
    /_test\.go$/.test(p) ||
    /(^|[\\/])(testkit|testutil|testvectors)\.rs$/.test(p);

/** Drop block and line comments (a `//` inside a URL string is kept). */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1");
}

/** The balanced `( ... )` argument text starting at `open` (an index of `(`). */
function balancedArgs(text: string, open: number): string {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) {
            return text.slice(open + 1, i);
        }
    }
    return text.slice(open + 1);
}

/** Every call matching `head` (a regex ending at the opening paren), with its full args, across lines. */
function callsMatching(
    text: string,
    head: RegExp,
): { call: string; args: string }[] {
    const out: { call: string; args: string }[] = [];
    const re = new RegExp(head.source, `${head.flags.replace("g", "")}g`);
    for (const m of text.matchAll(re)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        out.push({ call: m[0], args: balancedArgs(text, open) });
    }
    return out;
}

// packages/ffi (TypeScript / Bun): anything that opens a network listener.
const TS_LISTENER_HEADS: RegExp[] = [
    /\bcreateServer\s*\(/,
    /\.listen\s*\(/,
    /\bBun\.(?:serve|listen|udpSocket)\s*\(/,
    /\bDeno\.(?:serve|listen)\s*\(/,
    /\bserve\s*\(/,
    /\bnew\s+(?:\w+\.)?(?:Server|WebSocketServer)\s*\(/,
];
// A port number handed to a bind: `port: 9091`, `{ port: 9091 }`.
const TS_PORT_LITERAL = /\bport\s*:\s*\d{2,5}\b/;

function tsListeners(text: string): string[] {
    const code = stripComments(text);
    const found = TS_LISTENER_HEADS.flatMap((h) =>
        callsMatching(code, h).map((c) => c.call.trim()),
    );
    for (const m of code.matchAll(new RegExp(TS_PORT_LITERAL.source, "g"))) {
        found.push(m[0]);
    }
    return found;
}

// Go and Rust listener constructs.
const GO_LISTENER_HEADS: RegExp[] = [
    /\bnet\.Listen(?:Config)?\s*\(/,
    /\b(?:ListenAndServe(?:TLS)?|ListenPacket|ListenTCP|ListenUDP)\s*\(/,
    /\.Listen\s*\(/,
];
const RUST_LISTENER_HEADS: RegExp[] = [
    /\b(?:TcpListener|UdpSocket|UnixListener|Server|HttpServer)::bind\s*\(/,
    /\baxum::serve\s*\(/,
    /\.bind\s*\(/,
];
// A port number inside a bind's own arguments: `":9091"`, `, 9091)`, `([0,0,0,0], 9091)`.
// `127.0.0.1:0` (ephemeral, test-only) is not port-shaped here.
const ARG_PORT_LITERAL = /(?::|,\s*)(\d{2,5})(?![\d.])/g;
// A metrics port ASSIGNED in the template source: `metrics_port: u16 = 9091`,
// `METRICS_PORT = 9091`, `prometheus_addr = ":9091"`.
const METRICS_PORT_ASSIGN =
    /\b(?:metrics?|prometheus)\w*\s*(?::\s*[\w<>:]+)?\s*[:=]\s*"?:?(\d{4,5})\b/gi;
// The only port literal a function template may carry: the serving default.
const SERVING_DEFAULT = 8080;
// Port-shaped literals outside a bind (the PORT-unset default): Go `":8080"`,
// Rust `unwrap_or(8080)`.
const DEFAULT_PORT_LITERALS = [
    /"\s*:(\d{4,5})\s*"/g,
    /unwrap_or\s*\(\s*(\d{4,5})\s*\)/g,
];

interface Finding {
    file: string;
    what: string;
}

interface TemplateScan {
    listeners: { file: string; call: string; production: boolean }[];
    findings: Finding[];
    readsPortEnv: boolean;
}

function scanTemplateText(
    text: string,
    file: string,
    lang: "go" | "rust",
    production: boolean,
): { listeners: string[]; findings: Finding[]; readsPortEnv: boolean } {
    const code = stripComments(text);
    const heads = lang === "go" ? GO_LISTENER_HEADS : RUST_LISTENER_HEADS;
    const findings: Finding[] = [];
    const listeners: string[] = [];
    const seen = new Set<string>();
    for (const h of heads) {
        for (const { call, args } of callsMatching(code, h)) {
            if (seen.has(args)) continue; // two heads matched the same call
            seen.add(args);
            listeners.push(call.trim());
            for (const m of args.matchAll(ARG_PORT_LITERAL)) {
                findings.push({
                    file,
                    what: `${call.trim()} binds a literal port ${m[1]}, not $PORT`,
                });
            }
        }
    }
    for (const m of code.matchAll(METRICS_PORT_ASSIGN)) {
        findings.push({
            file,
            what: `a metrics port is assigned (${m[0].trim()}); function templates open none`,
        });
    }
    if (production) {
        for (const re of DEFAULT_PORT_LITERALS) {
            for (const m of code.matchAll(re)) {
                if (Number(m[1]) !== SERVING_DEFAULT) {
                    findings.push({
                        file,
                        what: `port literal ${m[1]} (the only allowed default is ${SERVING_DEFAULT})`,
                    });
                }
            }
        }
    }
    const readsPortEnv =
        lang === "go"
            ? /\b(?:getenv|Getenv|LookupEnv)\s*\(\s*"PORT"\s*\)/.test(code)
            : /\bvar\s*\(\s*"PORT"\s*\)/.test(code);
    return { listeners, findings, readsPortEnv };
}

function scanFunctionTemplates(): {
    go: TemplateScan;
    rust: TemplateScan;
} {
    const run = (root: string, ext: string, lang: "go" | "rust") => {
        const scan: TemplateScan = {
            listeners: [],
            findings: [],
            readsPortEnv: false,
        };
        for (const file of sourceFilesUnder(root)) {
            if (!file.endsWith(ext)) continue;
            const production = !isTestPath(file);
            const r = scanTemplateText(
                readFileSync(file, "utf8"),
                relative(REPO_ROOT, file),
                lang,
                production,
            );
            for (const call of r.listeners) {
                scan.listeners.push({
                    file: relative(REPO_ROOT, file),
                    call,
                    production,
                });
            }
            scan.findings.push(...r.findings);
            if (production && r.readsPortEnv) scan.readsPortEnv = true;
        }
        return scan;
    };
    return {
        go: run(FUNCTION_TEMPLATE_ROOTS[0], ".go", "go"),
        rust: run(FUNCTION_TEMPLATE_ROOTS[1], ".rs", "rust"),
    };
}

describe("metrics-port lockstep — FFI package (#2432)", () => {
    it("packages/ffi opens no network listener of its own", () => {
        const files = sourceFilesUnder(FFI_SRC).filter(
            (f) => /\.[cm]?[jt]s$/.test(f) && !isTestPath(f),
        );
        expect(
            files.length,
            "the FFI source scan read no files",
        ).toBeGreaterThan(0);
        const hits = files.flatMap((f) =>
            tsListeners(readFileSync(f, "utf8")).map(
                (h) => `${relative(REPO_ROOT, f)}: ${h}`,
            ),
        );
        expect(
            hits,
            "packages/ffi must open no listener: its metrics ride the globalThis seam into the " +
                `app's registry on :9464. Found:\n  ${hits.join("\n  ")}`,
        ).toEqual([]);
    });

    it("FFI metrics are registered through the seam the app's :9464 listener reads", () => {
        const render = stripComments(readFileSync(FFI_RENDER, "utf8"));
        // Producer: the generated module publishes $renderMetrics on the seam key.
        expect(
            render,
            "render.ts no longer assigns $renderMetrics to globalThis[Symbol.for('" +
                `${FFI_SEAM_KEY}')] — the FFI metrics would reach no port`,
        ).toMatch(
            new RegExp(
                `globalThis[^;]*\\[\\s*Symbol\\.for\\(\\s*'${FFI_SEAM_KEY.replaceAll(".", "\\.")}'\\s*\\)\\s*\\]\\s*=\\s*\\$renderMetrics\\b`,
            ),
        );
        // ...and $renderMetrics really emits the two families (not an empty stub).
        expect(render).toMatch(/function\s+\$renderMetrics\s*\(/);
        expect(render).toContain("knext_ffi_slow_calls_total");
        expect(render).toContain("knext_ffi_load_seconds");

        // Consumer: the app runtime reads the SAME key and appends it to the
        // scrape body it serves on the shared metrics port.
        const runtime = stripComments(readFileSync(RUNTIME_CONTRACT, "utf8"));
        expect(runtime).toMatch(
            new RegExp(
                `FFI_METRICS_SEAM\\s*=\\s*Symbol\\.for\\(\\s*'${FFI_SEAM_KEY.replaceAll(".", "\\.")}'\\s*\\)`,
            ),
        );
        expect(runtime).toMatch(/globalThis\[\s*FFI_METRICS_SEAM\s*\]/);
        const scrape = runtime.slice(
            runtime.indexOf("export async function renderScrape"),
        );
        expect(
            scrape.slice(0, scrape.indexOf("\n}\n")),
            "renderScrape no longer appends readFfiMetrics() to the :9464 body",
        ).toMatch(/appendExposition\([\s\S]*readFfiMetrics\(\)/);
    });
});

describe("metrics-port lockstep — Go and Rust function templates (#2432)", () => {
    const scans = scanFunctionTemplates();

    for (const lang of ["go", "rust"] as const) {
        it(`the ${lang} template binds only the serving $PORT, never a literal port`, () => {
            const scan = scans[lang];
            const prod = scan.listeners.filter((l) => l.production);
            expect(
                prod.length,
                `the ${lang} template scan found no production listener — the scan is blind`,
            ).toBeGreaterThan(0);
            expect(
                scan.readsPortEnv,
                `the ${lang} template never reads the PORT env, so its bind is not the serving port`,
            ).toBe(true);
            const msgs = scan.findings.map((f) => `${f.file}: ${f.what}`);
            expect(msgs, `\n  ${msgs.join("\n  ")}`).toEqual([]);
        });
    }

    it("self-test: multi-line binds, typed metrics ports and the 'symmetric' trap", () => {
        const rust = (t: string) => scanTemplateText(t, "x.rs", "rust", true);
        const go = (t: string) => scanTemplateText(t, "x.go", "go", true);
        // Multi-line Rust bind with a literal port.
        expect(
            rust(
                "let l = TcpListener::bind(\n  SocketAddr::from((\n    Ipv4Addr::UNSPECIFIED,\n    9091,\n  )),\n).await?;",
            ).findings.length,
        ).toBe(1);
        // Typed metrics-port assignment.
        expect(
            rust("const X: () = (); let metrics_port: u16 = 9091;").findings
                .length,
        ).toBe(1);
        // Multi-line Go listener with a literal.
        expect(
            go('ln, err := net.Listen(\n\t"tcp",\n\t":9091",\n)').findings
                .length,
        ).toBeGreaterThanOrEqual(1);
        // PORT-derived binds are clean, and the serving default is allowed.
        expect(
            rust(
                'let p = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080); TcpListener::bind(SocketAddr::from((a, p)))',
            ).findings,
        ).toEqual([]);
        expect(
            go(
                'func a(g func(string) string) string { if p := g("PORT"); p != "" { return ":" + p }; return ":8080" }\nln, _ := net.Listen("tcp", fn.HTTP.Addr)',
            ).findings,
        ).toEqual([]);
        // A non-serving default port is a finding.
        expect(go('return ":9091"').findings.length).toBe(1);
        // "symmetric" is not a metrics word: no finding.
        expect(
            rust("let symmetric_port: u16 = 4242; // symmetric key").findings,
        ).toEqual([]);
        // Comments mentioning a port are not code.
        expect(go('// net.Listen("tcp", ":9091")\nx := 1').listeners).toEqual(
            [],
        );
    });

    it("self-test: the FFI scanner reads Bun.serve, multi-line listen and a literal port", () => {
        expect(
            tsListeners("Bun.serve({ port: 9091, fetch() {} })").length,
        ).toBeGreaterThanOrEqual(2);
        expect(tsListeners("srv\n  .listen(\n    9091,\n  )").length).toBe(1);
        expect(tsListeners("// Bun.serve({port: 1})\nconst a = 1;")).toEqual(
            [],
        );
        expect(
            tsListeners("const r = process.getBuiltinModule.bind(p);"),
        ).toEqual([]);
    });
});

// Secondary: the prose agrees. This is NOT what makes the guard non-vacuous —
// the structural checks above do — it only catches a doc that names a stale
// port next to the word metrics/Prometheus.
describe("metrics-port lockstep — FFI docs agree (#2432, secondary)", () => {
    it("FFI docs that name the metrics port name 9464", () => {
        const pages = [
            resolve(REPO_ROOT, "packages", "ffi", "src", "EGM.md"),
            resolve(
                REPO_ROOT,
                "apps",
                "docs",
                "content",
                "docs",
                "rust-in-process.mdx",
            ),
        ];
        const drift: string[] = [];
        for (const page of pages) {
            readFileSync(page, "utf8")
                .split("\n")
                .forEach((line, i) => {
                    if (!/\b(?:metrics?|prometheus)\b/i.test(line)) return;
                    for (const m of line.matchAll(
                        /(?:^|[^a-z])ports?(?![a-z])\D{0,24}?(\d{4,5})(?![\d.])|:(\d{4,5})(?![\d.])/gi,
                    )) {
                        const port = Number(m[1] ?? m[2]);
                        if (port !== 9464)
                            drift.push(
                                `${relative(REPO_ROOT, page)}:${i + 1} -> ${port}`,
                            );
                    }
                });
        }
        expect(drift).toEqual([]);
    });
});
