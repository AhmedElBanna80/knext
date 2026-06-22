import { describe, expect, it } from "vitest";
import { parseLiveBuildIds, selectBuildsToDelete } from "../utils/asset-gc";

/**
 * Unit tests for the build-id retention GC (#93 — skew protection).
 *
 * `selectBuildsToDelete` is the SOLE build-id-pruning authority (ADR-0011). It is
 * a pure function: given the remote build-ids, their timestamps, the live set
 * (sourced READ-ONLY from `NextApp.Status.CurrentTraffic`, #92), and a retention
 * count, it returns ONLY the build-ids safe to delete. The deploy-time pruner
 * deletes exactly that set under `<app>/_next/static/<buildId>/` — never the bare
 * `<app>/` prefix (that is teardown-only, ADR-0008).
 *
 * Hard rules under test:
 *   - keep the newest `retain` build-ids (the skew window),
 *   - ALWAYS keep any build-id in `liveBuildIds` (a #92 pinned/canary/rolled-back
 *     revision must never be reaped, even if older than the window),
 *   - never return the only/last build,
 *   - never propose deleting "nothing-scoped" (empty build-id).
 */
describe("selectBuildsToDelete", () => {
    /** Newest-last ordering helper: timestamps ascending with the id order. */
    function tsFor(ids: string[]): Record<string, number> {
        const out: Record<string, number> = {};
        ids.forEach((id, i) => {
            out[id] = 1000 + i; // A=1000, B=1001, ... → later = newer
        });
        return out;
    }

    it("keeps the newest N builds and reaps the rest (no live pins)", () => {
        const ids = ["A", "B", "C", "D"]; // D newest
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(ids),
            liveBuildIds: [],
            retain: 2,
        });
        // retain=2 → keep C,D (newest two); delete A,B.
        expect(new Set(del)).toEqual(new Set(["A", "B"]));
    });

    it("never reaps a live (pinned/canary/rolled-back) build even if it is older than the window", () => {
        const ids = ["A", "B", "C", "D"]; // D newest
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(ids),
            liveBuildIds: ["A"], // A is older than the retain window but LIVE
            retain: 2,
        });
        // Keep A (live) + C,D (window) → only B is deletable.
        expect(new Set(del)).toEqual(new Set(["B"]));
    });

    it("returns nothing when the remote set fits inside the retain window", () => {
        const ids = ["A", "B"];
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(ids),
            liveBuildIds: [],
            retain: 3,
        });
        expect(del).toEqual([]);
    });

    it("never deletes the only/last build (single remaining build is sacred)", () => {
        const del = selectBuildsToDelete({
            remoteBuildIds: ["A"],
            timestamps: tsFor(["A"]),
            liveBuildIds: [],
            retain: 0, // even with retain 0, the only build must survive
        });
        expect(del).toEqual([]);
    });

    it("clamps a zero/negative retain to keep at least the newest build", () => {
        const ids = ["A", "B", "C"];
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(ids),
            liveBuildIds: [],
            retain: 0,
        });
        // C (newest) is always kept; A,B reaped.
        expect(del).not.toContain("C");
        expect(new Set(del)).toEqual(new Set(["A", "B"]));
    });

    it("ignores empty / falsy build-ids — never proposes an unscoped delete", () => {
        const del = selectBuildsToDelete({
            remoteBuildIds: ["", "A", "B"],
            timestamps: { A: 1001, B: 1002 },
            liveBuildIds: [],
            retain: 1,
        });
        // "" is dropped entirely; B newest kept; only A reaped.
        expect(del).toEqual(["A"]);
        expect(del).not.toContain("");
    });

    it("orders deletes oldest-first (deterministic) and de-dupes input", () => {
        const ids = ["A", "B", "C", "D", "A"]; // duplicate A
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(["A", "B", "C", "D"]),
            liveBuildIds: [],
            retain: 1,
        });
        // keep D; delete A,B,C oldest-first.
        expect(del).toEqual(["A", "B", "C"]);
    });
});

/**
 * `parseLiveBuildIds` extracts build-ids from the operator's traffic status JSON
 * (`kubectl get nextapp <n> -o jsonpath={.status.currentTraffic}`). Knative
 * revision names embed the build-id as the trailing config-generation segment in
 * knext's scheme (`<app>-<buildId>-<NNNNN>`); but because the operator does not
 * yet stamp the build-id into the revision name, the conservative contract is:
 * treat the WHOLE revisionName as an opaque live token. The GC's `liveBuildIds`
 * must therefore be matched against remote build-ids by membership, and any
 * remote build-id that is a SUBSTRING-of / equals a live revision name is kept.
 * Here we only assert the parse surface (revision names extracted, nil-safe).
 */
describe("parseLiveBuildIds", () => {
    it("extracts revisionNames from a CurrentTraffic JSON array", () => {
        const json = JSON.stringify([
            { revisionName: "shop-abc123-00007", percent: 80 },
            { revisionName: "shop-def456-00008", percent: 20 },
        ]);
        expect(parseLiveBuildIds(json)).toEqual([
            "shop-abc123-00007",
            "shop-def456-00008",
        ]);
    });

    it("is nil-safe on empty / malformed input", () => {
        expect(parseLiveBuildIds("")).toEqual([]);
        expect(parseLiveBuildIds("not json")).toEqual([]);
        expect(parseLiveBuildIds("null")).toEqual([]);
        expect(parseLiveBuildIds("[]")).toEqual([]);
    });

    it("drops entries with no revisionName", () => {
        const json = JSON.stringify([
            { percent: 100, latestRevision: true },
            { revisionName: "shop-xyz-00001", percent: 0 },
        ]);
        expect(parseLiveBuildIds(json)).toEqual(["shop-xyz-00001"]);
    });
});
