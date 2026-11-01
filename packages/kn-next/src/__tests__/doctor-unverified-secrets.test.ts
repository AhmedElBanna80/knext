import { describe, expect, it } from "bun:test";
import { runDoctor } from "../cli/doctor";
import { unverifiedSecretsCheck } from "../cli/doctor/checks/unverified-secrets";
import type { CheckContext, KubectlFn } from "../cli/doctor/types";

/**
 * `knext doctor` lists zone functions held as SovereigntyCompliant=Unknown /
 * SecretsUnverified: the operator cannot read a Secret they reference. A denied
 * read is refused and removed after 10 minutes, so the row names the RBAC probe
 * that finds the missing grant. Read-only, from the BackendService conditions.
 */

type Fn = {
    name: string;
    namespace?: string;
    sov?: { status: string; reason: string; since?: string; message?: string };
    deniedSince?: string;
};

function ctxWith(
    fns: Fn[] | "fail" | { fail: string },
    manager = true,
): CheckContext {
    const kubectl: KubectlFn = (args) => {
        if (
            args.join(" ") !==
            "kubectl get backendservices --all-namespaces -o json"
        )
            return { ok: false, stdout: "", stderr: "unexpected" };
        if (fns === "fail")
            return {
                ok: false,
                stdout: "",
                stderr: 'error: the server doesn\'t have a resource type "backendservices"',
            };
        if ("fail" in fns) return { ok: false, stdout: "", stderr: fns.fail };
        return {
            ok: true,
            stderr: "",
            stdout: JSON.stringify({
                items: fns.map((f) => ({
                    metadata: {
                        name: f.name,
                        namespace: f.namespace ?? "default",
                    },
                    status: {
                        secretsDeniedSince: f.deniedSince,
                        conditions: f.sov
                            ? [
                                  {
                                      type: "SovereigntyCompliant",
                                      status: f.sov.status,
                                      reason: f.sov.reason,
                                      lastTransitionTime: f.sov.since,
                                      message: f.sov.message,
                                  },
                              ]
                            : [],
                    },
                })),
            }),
        };
    };
    return {
        // biome-ignore lint/suspicious/noExplicitAny: only kubectl is read
        deps: {} as any,
        kubectl,
        skipAll: false,
        ...(manager
            ? {
                  operatorManager: {
                      metadata: { namespace: "ops" },
                      spec: {
                          template: { spec: { serviceAccountName: "opsa" } },
                      },
                      // biome-ignore lint/suspicious/noExplicitAny: partial Deployment
                  } as any,
              }
            : {}),
    };
}

const unverified = (since = "2026-11-01T12:00:00Z") => ({
    status: "Unknown",
    reason: "SecretsUnverified",
    since,
    message: 'could not read the metadata of Secret "stripe-key"',
});

describe("doctor: unverified function Secrets", () => {
    it("contributes NO row when nothing is unverified, the CRD is not installed, or the check is skipped", () => {
        expect(unverifiedSecretsCheck(ctxWith([]))).toEqual([]);
        expect(
            unverifiedSecretsCheck(
                ctxWith([
                    { name: "a", sov: { status: "True", reason: "Compliant" } },
                    {
                        name: "b",
                        sov: { status: "False", reason: "SecretNotAllowed" },
                    },
                    { name: "c" },
                ]),
            ),
        ).toEqual([]);
        expect(unverifiedSecretsCheck(ctxWith("fail"))).toEqual([]);
        expect(
            unverifiedSecretsCheck({ ...ctxWith([]), skipAll: true }),
        ).toEqual([]);
    });

    it("WARNS that the check could not run, and why, when the list fails for a real reason (RBAC denied)", () => {
        const [row] = unverifiedSecretsCheck(
            ctxWith({
                fail: 'Error from server (Forbidden): backendservices.apps.kn-next.dev is forbidden: User "dev" cannot list resource "backendservices" in API group "apps.kn-next.dev" at the cluster scope',
            }),
        );
        expect(row?.id).toBe("unverified-secrets");
        expect(row?.status).toBe("warn");
        expect(row?.detail).toMatch(/could not (be )?(run|check|list)/i);
        expect(row?.detail).toContain("rbac");
        expect(row?.hint).toContain("backendservices");
    });

    it("WARNS with the cause for an unclassified failure too, never a silent green", () => {
        const [row] = unverifiedSecretsCheck(
            ctxWith({ fail: "error: something odd happened" }),
        );
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("something odd happened");
    });

    it("WARN: names each unverified function, its Secret, and the RBAC probe with the operator's namespace and ServiceAccount", () => {
        const [row] = unverifiedSecretsCheck(
            ctxWith([
                { name: "pricing", namespace: "shop", sov: unverified() },
                { name: "ok", sov: { status: "True", reason: "Compliant" } },
            ]),
        );
        expect(row?.id).toBe("unverified-secrets");
        expect(row?.status).toBe("warn");
        expect(row?.detail).toContain("shop/pricing");
        expect(row?.detail).not.toContain("default/ok");
        expect(row?.detail).toContain("stripe-key");
        expect(row?.hint).toContain(
            "kubectl auth can-i get secrets -n shop --as=system:serviceaccount:ops:opsa",
        );
    });

    it("distinguishes a denied read (teardown pending) from a transient one", () => {
        const [row] = unverifiedSecretsCheck(
            ctxWith([
                {
                    name: "denied",
                    sov: unverified(),
                    deniedSince: "2026-11-01T12:00:00Z",
                },
                { name: "flaky", sov: unverified() },
            ]),
        );
        expect(row?.detail).toMatch(/default\/denied[^;]*denied/i);
        expect(row?.detail).toContain("10 minutes");
        expect(row?.detail).toMatch(/default\/flaky[^;]*transient/i);
    });

    it("without an operator Deployment the hint keeps placeholders instead of guessing", () => {
        const [row] = unverifiedSecretsCheck(
            ctxWith([{ name: "pricing", sov: unverified() }], false),
        );
        expect(row?.hint).toContain(
            "kubectl auth can-i get secrets -n default --as=system:serviceaccount:<operator-namespace>:<operator-serviceaccount>",
        );
    });

    it("is wired into runDoctor", async () => {
        const base = ctxWith([{ name: "pricing", sov: unverified() }]);
        const report = await runDoctor({
            kubectl: (args) =>
                args.join(" ") === "kubectl get --raw /version"
                    ? { ok: true, stdout: "{}", stderr: "" }
                    : base.kubectl(args),
            probeImage: async () => "ok",
        });
        expect(report.checks.some((c) => c.id === "unverified-secrets")).toBe(
            true,
        );
    });
});
