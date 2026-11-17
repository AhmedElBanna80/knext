/**
 * (cluster) Is the Kubernetes server at or above the supported floor?
 *
 * The floor is the write-policy one (ValidatingAdmissionPolicy GA, 1.30) and is
 * REUSED from write-policy.ts, never restated. Ownership: when an operator
 * Deployment exists, the write-policy row already warns about the floor with the
 * consequence for the operator, so this row stays silent rather than repeat it.
 * With no operator installed yet, write-policy skips, so this row is the only
 * place a user on an older server hears about it.
 */

import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { FLOOR, serverVersion } from "./write-policy";

const ID = "k8s-floor";
const TITLE = "Kubernetes version";
const FLOOR_TEXT = `${FLOOR.major}.${FLOOR.minor}`;

export function k8sFloorCheck(ctx: CheckContext): CheckResult[] {
    // Unreachable: the cluster row already says so; no extra row.
    if (ctx.skipAll) return [];
    // write-policy owns the floor warning once an operator exists.
    if (ctx.operatorManager) return [];

    const version = serverVersion(
        ctx.kubectl(["kubectl", "get", "--raw", "/version"]).stdout,
    );
    if (!version) {
        return [
            mk(
                ID,
                TITLE,
                "skip",
                `could not read the server version, so it was not compared with the ${FLOOR_TEXT} floor`,
            ),
        ];
    }
    const below =
        version.major < FLOOR.major ||
        (version.major === FLOOR.major && version.minor < FLOOR.minor);
    if (below) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `the server is Kubernetes ${version.major}.${version.minor}, older than the ${FLOOR_TEXT} floor: ValidatingAdmissionPolicy is not available, so the operator's Secret and ConfigMap writes cannot be limited`,
                `upgrade the cluster to Kubernetes ${FLOOR_TEXT} or newer before installing the operator`,
            ),
        ];
    }
    return [
        mk(
            ID,
            TITLE,
            "pass",
            `Kubernetes ${version.major}.${version.minor} (floor ${FLOOR_TEXT})`,
        ),
    ];
}
