/**
 * Build-id retention GC — skew protection (#93, ADR-0011).
 *
 * Version skew happens when a browser running build A requests
 * `_next/static/<A>/...` chunks after the server has rolled forward to build B.
 * knext serves those chunks from the durable object store, so as long as build
 * A's prefix survives, the old client keeps working. The risk is unbounded
 * storage growth if old build prefixes are NEVER reaped.
 *
 * This module decides — PURELY, with no I/O — which build-ids are safe to delete.
 * It is the SOLE build-id-pruning authority. Deletes are scoped to
 * `<app>/_next/static/<buildId>/`; the bare `<app>/` deletion remains
 * TEARDOWN-ONLY (operator finalizer, ADR-0008) and must NEVER be used as a
 * deploy-time prune.
 *
 * Two keep rules, OR'd together (retain-window OR live ⇒ keep):
 *   1. Retain window — keep the newest `retain` build-ids (the skew window).
 *   2. Live set — keep any build-id observed serving traffic
 *      (`NextApp.Status.CurrentTraffic`, #92). This protects a pinned / canary /
 *      rolled-back revision even when it is OLDER than the retain window, so the
 *      GC never reaps the build a #92 rollback is actively serving.
 *
 * The only/last build is always kept, and an empty build-id is never proposed
 * for deletion (it would scope to the bare `<app>/` prefix — forbidden).
 */

/** Default number of recent build-ids to retain (the skew window). */
export const DEFAULT_RETAIN = 3;

export interface SelectBuildsInput {
    /** Build-ids currently present in the object store, under `<app>/_next/static/`. */
    readonly remoteBuildIds: readonly string[];
    /**
     * Map of build-id → a monotonic ordering key (e.g. upload time, ms epoch).
     * Larger = newer. Build-ids missing a timestamp sort oldest (treated as 0).
     */
    readonly timestamps: Readonly<Record<string, number>>;
    /**
     * Build-ids (or revision-name tokens) that are LIVE — sourced READ-ONLY from
     * `NextApp.Status.CurrentTraffic`. A remote build-id is considered live if it
     * equals, or is a substring of, any live token (revision names embed the
     * build-id). Never reaped regardless of the retain window.
     */
    readonly liveBuildIds: readonly string[];
    /** How many newest build-ids to retain. Clamped to >= 1. */
    readonly retain: number;
}

/** True if `buildId` is referenced by any live revision token. */
function isLive(buildId: string, liveTokens: readonly string[]): boolean {
    return liveTokens.some(
        (token) => token === buildId || token.includes(buildId),
    );
}

/**
 * Returns the build-ids that are safe to delete, oldest-first. Pure: no I/O.
 *
 * Guarantees:
 *   - keeps the newest `max(retain, 1)` build-ids,
 *   - keeps any build-id in {@link SelectBuildsInput.liveBuildIds},
 *   - never returns the only/last build,
 *   - drops empty/falsy build-ids (never proposes an unscoped delete),
 *   - de-dupes the input and orders the result deterministically (oldest-first).
 */
export function selectBuildsToDelete(input: SelectBuildsInput): string[] {
    const { remoteBuildIds, timestamps, liveBuildIds } = input;
    const retain = Math.max(1, input.retain | 0);

    // De-dupe and drop empties (an empty id would scope to the bare `<app>/`).
    const unique = Array.from(
        new Set(remoteBuildIds.filter((id) => typeof id === "string" && id)),
    );

    // Newest-first ordering by timestamp (missing → 0 → oldest). Stable on ties.
    const byNewest = [...unique].sort(
        (a, b) => (timestamps[b] ?? 0) - (timestamps[a] ?? 0),
    );

    // Defensive: never delete the only remaining build.
    if (byNewest.length <= 1) {
        return [];
    }

    const windowKept = new Set(byNewest.slice(0, retain));

    const deletable = byNewest.filter(
        (id) => !windowKept.has(id) && !isLive(id, liveBuildIds),
    );

    // Return oldest-first for deterministic, low-surprise deletion order.
    return deletable.reverse();
}

/**
 * Parses revision-name tokens out of the operator's traffic status JSON, as read
 * READ-ONLY via `kubectl get nextapp <n> -o jsonpath={.status.currentTraffic}`
 * (ADR-0001: the CLI never mutates the cluster). Returns the `revisionName` of
 * every traffic target. Nil-safe: returns `[]` on empty/malformed/non-array
 * input so a parse failure can only ever make the GC MORE conservative (it never
 * fabricates a live set, and an empty live set just falls back to the retain
 * window — it never causes an over-delete because the window still protects the
 * newest builds).
 */
export function parseLiveBuildIds(currentTrafficJson: string): string[] {
    const raw = currentTrafficJson?.trim();
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const entry of parsed) {
        if (
            entry &&
            typeof entry === "object" &&
            "revisionName" in entry &&
            typeof (entry as { revisionName?: unknown }).revisionName ===
                "string"
        ) {
            const name = (entry as { revisionName: string }).revisionName;
            if (name) out.push(name);
        }
    }
    return out;
}
