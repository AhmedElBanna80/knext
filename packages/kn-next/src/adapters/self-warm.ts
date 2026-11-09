/**
 * self-warm.ts — render the app's first route while the pod waits to be routable.
 *
 * On a cold start the child is listening ~150 ms after its first log line, but
 * Knative cannot send it traffic until kubelet reports the pod's IP and
 * readiness, about half a second later (measured on OKE, 2026-11-09). The first
 * real request then pays for loading and rendering its route. This step spends
 * that idle window instead: once the child is serving, the supervisor requests
 * the configured path(s) on loopback, so the route's modules are loaded and its
 * first render is done before any user arrives.
 *
 * Measured on OKE (Bun standalone, n=30 per arm, interleaved): ready -> first
 * byte went from a 94 ms median to 16 ms (paired difference -69 ms, 95% CI
 * [-85, -54]). The total cold start moved by the same amount, which that sample
 * could not separate from platform noise.
 *
 * Opt-in, on ADR-0042's existing surface: it runs only when `KNEXT_WARM_PATH` is
 * set (comma-separated absolute paths), and `KNEXT_EAGER_WARM=0` turns it off.
 * ADR-0042 keeps `/` out of the defaults: the warm request carries no cookies or
 * auth and its render writes the shared page cache. Each request carries
 * `x-knext-warm: 1` and logs a `WARMED:<path> status=<n> ms=<n>` line, as the
 * vinext entry does. It is a plain GET, so a route with side effects on GET runs
 * them on every pod start. It never throws, never follows a redirect, skips the
 * warm-up if the server is not listening, and gives up after `timeoutMs` for the
 * whole warm-up.
 */

import { connect } from "node:net";

export const SELF_WARM_HEADER = "x-knext-warm";
export const DEFAULT_WARM_TIMEOUT_MS = 5000;
const MAX_WARM_PATHS = 8;

/**
 * The paths to warm at boot: none unless `KNEXT_WARM_PATH` is set, none when
 * `KNEXT_EAGER_WARM=0`.
 */
export function parseWarmPaths(
    env: Record<string, string | undefined>,
): string[] {
    if (env.KNEXT_EAGER_WARM === "0") return [];
    const raw = env.KNEXT_WARM_PATH;
    if (raw === undefined) return [];
    return (
        raw
            .split(",")
            .map((s) => s.trim())
            // Absolute paths only: a scheme-relative `//host/x` would leave loopback.
            .filter((s) => s.startsWith("/") && !s.startsWith("//"))
            .slice(0, MAX_WARM_PATHS)
    );
}

export interface SelfWarmResult {
    path: string;
    status?: number;
    error?: string;
}

interface SelfWarmLog {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
}

/** Whether something accepts TCP on `127.0.0.1:port` within `timeoutMs`. */
export function isListening(port: number, timeoutMs = 300): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = connect({ host: "127.0.0.1", port });
        const done = (ok: boolean) => {
            clearTimeout(timer);
            sock.destroy();
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
    });
}

/**
 * Request each path on `127.0.0.1:port`, one after another. Never throws.
 *
 * Skips everything when the child is not listening yet (the supervisor runs this
 * step on a probe deadline, or straight after the spawn when deferral is off).
 * The whole warm-up shares one `timeoutMs` budget, so a hung route cannot hold
 * the steps behind it, and it stops as soon as `shouldStop()` says so (shutdown).
 */
export async function selfWarm(options: {
    port: number;
    paths: string[];
    log: SelfWarmLog;
    timeoutMs?: number;
    shouldStop?: () => boolean;
}): Promise<SelfWarmResult[]> {
    const results: SelfWarmResult[] = [];
    if (options.paths.length === 0) return results;
    if (!(await isListening(options.port))) {
        options.log.info(
            { port: options.port },
            "self-warm skipped: the server is not listening yet",
        );
        return results;
    }
    const deadline =
        Date.now() + (options.timeoutMs ?? DEFAULT_WARM_TIMEOUT_MS);
    for (const path of options.paths) {
        const left = deadline - Date.now();
        if (left <= 0 || options.shouldStop?.()) break;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), left);
        const t0 = Date.now();
        try {
            const res = await fetch(`http://127.0.0.1:${options.port}${path}`, {
                headers: { [SELF_WARM_HEADER]: "1" },
                redirect: "manual",
                signal: ac.signal,
            });
            await res.arrayBuffer();
            results.push({ path, status: res.status });
            options.log.info(
                { path, status: res.status },
                `WARMED:${path} status=${res.status} ms=${Date.now() - t0}`,
            );
        } catch (err) {
            const cause = (err as { cause?: { code?: string } })?.cause?.code;
            const error =
                cause ?? (err instanceof Error ? err.name : String(err));
            results.push({ path, error });
            options.log.warn(
                { path, error },
                `WARMED:${path} status=error ms=${Date.now() - t0} (${error})`,
            );
        } finally {
            clearTimeout(timer);
        }
    }
    return results;
}
