/**
 * `knext doctor` — Kubernetes server floor check.
 *
 * The 1.30 floor (ValidatingAdmissionPolicy GA) must be reported even before
 * the operator is installed. When the operator IS installed the write-policy
 * row owns the floor warning, so this row must not repeat it.
 */

import { describe, expect, it } from "bun:test";
import { type CheckResult, type KubectlFn, runDoctor } from "../cli/doctor";

async function rows(
    versionStdout: string,
    operator = false,
): Promise<{ floor?: CheckResult; all: CheckResult[] }> {
    const kubectl: KubectlFn = (args) => {
        const key = args.join(" ");
        if (key === "kubectl get --raw /version")
            return { ok: true, stdout: versionStdout, stderr: "" };
        if (operator && key.startsWith("kubectl get deployments -n"))
            return {
                ok: true,
                stdout: JSON.stringify({
                    items: [
                        {
                            metadata: {
                                name: "kn-next-operator-controller-manager",
                            },
                            spec: {
                                template: {
                                    spec: {
                                        containers: [
                                            { name: "manager", image: "x" },
                                        ],
                                    },
                                },
                            },
                        },
                    ],
                }),
                stderr: "",
            };
        return { ok: false, stdout: "", stderr: "no stub" };
    };
    const report = await runDoctor({ kubectl, probeImage: async () => "ok" });
    return {
        floor: report.checks.find((c) => c.id === "k8s-floor"),
        all: report.checks,
    };
}

describe("doctor k8s-floor check", () => {
    it("WARN naming 1.30 on v1.29 with no operator installed", async () => {
        const { floor } = await rows(
            '{"major":"1","minor":"29","gitVersion":"v1.29.4"}',
        );
        expect(floor?.status).toBe("warn");
        expect(floor?.detail).toContain("1.30");
        expect(floor?.detail).toContain("1.29");
    });

    it("PASS on v1.30", async () => {
        const { floor } = await rows(
            '{"major":"1","minor":"30","gitVersion":"v1.30.0"}',
        );
        expect(floor?.status).toBe("pass");
    });

    it("handles a provider suffix like v1.29.5-gke.1", async () => {
        const { floor } = await rows(
            '{"major":"1","minor":"29+","gitVersion":"v1.29.5-gke.1"}',
        );
        expect(floor?.status).toBe("warn");
        expect(floor?.detail).toContain("1.29");
    });

    it("unparseable version: honest skip, no crash", async () => {
        const { floor } = await rows("not json");
        expect(floor?.status).toBe("skip");
        expect(floor?.detail).toContain("1.30");
    });

    it("does not double-warn when the operator exists (write-policy owns it)", async () => {
        const { floor, all } = await rows(
            '{"major":"1","minor":"29","gitVersion":"v1.29.4"}',
            true,
        );
        expect(floor?.status).not.toBe("warn");
        expect(all.find((c) => c.id === "write-policy")?.status).toBe("warn");
    });
});
