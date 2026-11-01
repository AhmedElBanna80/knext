/**
 * Zone functions the operator cannot verify the Secrets of.
 *
 * A BackendService whose referenced Secret the operator cannot read sits in
 * SovereigntyCompliant=Unknown / SecretsUnverified: its rollouts are held, and a
 * running function is left as it is. A transient apiserver error is held without
 * limit; a DENIED read (Forbidden, almost always RBAC drift on the operator's
 * Secret grant) is held for 10 minutes and then the function is refused and
 * removed. Neither says anything on its own, so this row lists them with the
 * `can-i` probe that finds the missing grant.
 *
 * Contributes NO row when nothing is unverified, the cluster is unreachable, or
 * the list cannot be read, which keeps every other report's row set unchanged.
 * Read-only: one `get backendservices`, status only. KEEP the reason and the
 * hold in lockstep with the operator (backendservice_verdict.go:
 * ReasonSecretsUnverified, secretsDeniedHold).
 */

import { safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { OPERATOR_NAMESPACE } from "../types";

const ID = "unverified-secrets";
const TITLE = "Function Secrets verified";

interface BackendServiceItem {
    metadata?: { name?: string; namespace?: string };
    status?: {
        secretsDeniedSince?: string;
        conditions?: {
            type?: string;
            status?: string;
            reason?: string;
            message?: string;
        }[];
    };
}

export function unverifiedSecretsCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) return [];
    const res = ctx.kubectl([
        "kubectl",
        "get",
        "backendservices",
        "--all-namespaces",
        "-o",
        "json",
    ]);
    if (!res.ok) return [];
    const items =
        safeJson<{ items?: BackendServiceItem[] }>(res.stdout)?.items ?? [];

    const rows: string[] = [];
    const namespaces = new Set<string>();
    for (const item of items) {
        const cond = item.status?.conditions?.find(
            (c) => c.type === "SovereigntyCompliant",
        );
        if (cond?.status !== "Unknown" || cond.reason !== "SecretsUnverified")
            continue;
        const ns = item.metadata?.namespace ?? "default";
        const fn = `${ns}/${item.metadata?.name ?? "?"}`;
        namespaces.add(ns);
        // The condition message names the Secrets: "could not read the metadata
        // of Secret "x"; retrying ...". Keep the part before the first ";".
        const which = (cond.message ?? "").split(";")[0].trim();
        const named = which ? `: ${which}` : "";
        rows.push(
            item.status?.secretsDeniedSince
                ? `${fn} (denied since ${item.status.secretsDeniedSince}, refused and removed once the denial lasts 10 minutes${named})`
                : `${fn} (transient read errors, held without limit${named})`,
        );
    }
    if (rows.length === 0) return [];

    const opNs = ctx.operatorManager?.metadata?.namespace;
    const sa = ctx.operatorManager?.spec?.template?.spec?.serviceAccountName;
    const subject = ctx.operatorManager
        ? `system:serviceaccount:${opNs ?? OPERATOR_NAMESPACE}:${sa ?? "default"}`
        : "system:serviceaccount:<operator-namespace>:<operator-serviceaccount>";
    const probes = [...namespaces]
        .map((ns) => `kubectl auth can-i get secrets -n ${ns} --as=${subject}`)
        .join("; ");
    return [
        mk(
            ID,
            TITLE,
            "warn",
            `the operator cannot read the Secrets of ${rows.length} function${rows.length === 1 ? "" : "s"}, so their rollouts are held: ${rows.join("; ")}.`,
            `check the operator can read Secrets: ${probes} (expect "yes"); the function's SovereigntyCompliant condition names the Secret`,
        ),
    ];
}
