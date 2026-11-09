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
 * `KNEXT_WARM_PATHS` (comma-separated absolute paths, default `/`) chooses the
 * routes; an empty value turns the step off. Each request carries
 * `x-knext-warm: 1` so an app can recognise it. It is a plain GET, so a route
 * with side effects on GET runs them once per cold start. It never throws, never
 * follows a redirect, and gives up on a route after `timeoutMs`.
 */

export const SELF_WARM_HEADER = "x-knext-warm";
export const DEFAULT_WARM_TIMEOUT_MS = 5000;
const MAX_WARM_PATHS = 8;

/** The paths to warm, from `KNEXT_WARM_PATHS`; `/` when unset, none when empty. */
export function parseWarmPaths(
    env: Record<string, string | undefined>,
): string[] {
    const raw = env.KNEXT_WARM_PATHS;
    if (raw === undefined) return ["/"];
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

/** Request each path on `127.0.0.1:port`, one after another. Never throws. */
export async function selfWarm(options: {
    port: number;
    paths: string[];
    log: SelfWarmLog;
    timeoutMs?: number;
}): Promise<SelfWarmResult[]> {
    const results: SelfWarmResult[] = [];
    for (const path of options.paths) {
        const ac = new AbortController();
        const timer = setTimeout(
            () => ac.abort(),
            options.timeoutMs ?? DEFAULT_WARM_TIMEOUT_MS,
        );
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
                "self-warm request done",
            );
        } catch (err) {
            const error = err instanceof Error ? err.name : String(err);
            results.push({ path, error });
            options.log.warn(
                { path, error },
                "self-warm request failed (non-fatal)",
            );
        } finally {
            clearTimeout(timer);
        }
    }
    return results;
}
