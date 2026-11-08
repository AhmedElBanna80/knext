/**
 * A BackendService that fails the strict dry run is diagnosed against the
 * BackendService schema, not the NextApp one (#2481): the fields named are the
 * ones this CR carries that the installed BackendService CRD lacks.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flattenSchemaPaths } from "../cli/schema/crd-schema";
import {
    type KubectlCapture,
    preflightCRSchema,
    readKnownCRDFields,
    unknownFieldsOfCR,
} from "../cli/schema/preflight";

const obj = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
});
const meta = { type: "object" };

// An older BackendService CRD: no `scaling`, no `wakeAhead`.
const OLD_BACKENDSERVICE = obj({
    apiVersion: { type: "string" },
    kind: { type: "string" },
    metadata: meta,
    spec: obj({
        zone: { type: "string" },
        image: { type: "string" },
        language: { type: "string" },
        port: { type: "integer" },
    }),
});
// A NextApp that knows nothing of BackendService fields.
const NEXTAPP = obj({
    apiVersion: { type: "string" },
    kind: { type: "string" },
    metadata: meta,
    spec: obj({ image: { type: "string" }, zone: { type: "string" } }),
});
const OPENAPI_DOC = {
    components: {
        schemas: {
            "dev.kn-next.apps.v1alpha1.NextApp": NEXTAPP,
            "dev.kn-next.apps.v1alpha1.BackendService": OLD_BACKENDSERVICE,
            "dev.kn-next.apps.v1alpha1.BackendServiceList": obj({}),
        },
    },
};
const crdObject = (schema: unknown) => ({
    spec: {
        versions: [{ name: "v1alpha1", schema: { openAPIV3Schema: schema } }],
    },
});

const CR = {
    apiVersion: "apps.kn-next.dev/v1alpha1",
    kind: "BackendService",
    metadata: { name: "fn", namespace: "z" },
    spec: {
        zone: "z",
        image: `r/fn@sha256:${"a".repeat(64)}`,
        language: "go",
        port: 8080,
        wakeAhead: true,
        scaling: { minScale: 0, maxScale: 3 },
    },
};

function withCR<T>(cr: unknown, fn: (crPath: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "knext-bs-preflight-"));
    try {
        const crPath = join(dir, "cr.json");
        writeFileSync(crPath, JSON.stringify(cr));
        return fn(crPath);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function fakeKubectl(opts: { openapi: boolean; crd: boolean }): {
    kubectl: KubectlCapture;
    calls: string[][];
} {
    const calls: string[][] = [];
    const kubectl: KubectlCapture = (argv) => {
        calls.push([...argv]);
        if (argv[1] === "apply")
            return {
                ok: false,
                stdout: "",
                stderr: 'Error from server: strict decoding error: unknown field "spec.scaling", unknown field "spec.wakeAhead"',
            };
        if (argv[2] === "--raw")
            return opts.openapi
                ? { ok: true, stdout: JSON.stringify(OPENAPI_DOC), stderr: "" }
                : { ok: false, stdout: "", stderr: "forbidden" };
        if (argv[1] === "get" && argv[2] === "crd") {
            if (!opts.crd)
                return { ok: false, stdout: "", stderr: "forbidden" };
            const schema =
                argv[3] === "backendservices.apps.kn-next.dev"
                    ? OLD_BACKENDSERVICE
                    : NEXTAPP;
            return {
                ok: true,
                stdout: JSON.stringify(crdObject(schema)),
                stderr: "",
            };
        }
        return { ok: false, stdout: "", stderr: "unexpected" };
    };
    return { kubectl, calls };
}

describe("#2481 — the BackendService preflight diagnoses against its own CRD", () => {
    it("names the BackendService fields the installed CRD lacks (OpenAPI v3)", () => {
        const { kubectl } = fakeKubectl({ openapi: true, crd: false });
        const out = withCR(CR, (crPath) =>
            preflightCRSchema({ kubectl }, { crPath, namespace: "z" }),
        );
        expect(out.verdict).toBe("skew");
        expect(out.diagnosis).toBe("openapi-v3");
        expect(out.unknownFields).toEqual(["spec.scaling", "spec.wakeAhead"]);
    });

    it("reads the BackendService CRD, not the NextApp one, when OpenAPI is denied", () => {
        const { kubectl, calls } = fakeKubectl({ openapi: false, crd: true });
        const out = withCR(CR, (crPath) =>
            preflightCRSchema({ kubectl }, { crPath, namespace: "z" }),
        );
        expect(out.diagnosis).toBe("crd");
        expect(out.unknownFields).toEqual(["spec.scaling", "spec.wakeAhead"]);
        expect(
            calls.some((c) => c[3] === "backendservices.apps.kn-next.dev"),
        ).toBe(true);
        expect(calls.some((c) => c[3] === "nextapps.apps.kn-next.dev")).toBe(
            false,
        );
    });

    it("names a nested unknown field once, by its shallowest path", () => {
        const newer = obj({
            ...OLD_BACKENDSERVICE.properties,
            spec: obj({
                ...(
                    OLD_BACKENDSERVICE.properties.spec as {
                        properties: Record<string, unknown>;
                    }
                ).properties,
                wakeAhead: { type: "boolean" },
                scaling: obj({ minScale: { type: "integer" } }),
            }),
        });
        const kubectl: KubectlCapture = (argv) =>
            argv[1] === "apply"
                ? {
                      ok: false,
                      stdout: "",
                      // Names no field, so only the schema walk can produce the answer.
                      stderr: "strict decoding error: unknown field",
                  }
                : argv[2] === "--raw"
                  ? {
                        ok: true,
                        stdout: JSON.stringify({
                            components: {
                                schemas: { "x.BackendService": newer },
                            },
                        }),
                        stderr: "",
                    }
                  : { ok: false, stdout: "", stderr: "no" };
        const out = withCR(CR, (crPath) =>
            preflightCRSchema({ kubectl }, { crPath, namespace: "z" }),
        );
        expect(out.unknownFields).toEqual(["spec.scaling.maxScale"]);
    });

    it("a NextApp CR still reads the NextApp schema", () => {
        const { kubectl } = fakeKubectl({ openapi: true, crd: false });
        const read = readKnownCRDFields(kubectl);
        expect(read.source).toBe("openapi-v3");
        expect(read.known?.has("spec.image")).toBe(true);
        expect(read.known?.has("spec.language")).toBe(false);
    });

    it("falls back to the apiserver message when neither BackendService schema can be read", () => {
        const { kubectl } = fakeKubectl({ openapi: false, crd: false });
        const out = withCR(CR, (crPath) =>
            preflightCRSchema({ kubectl }, { crPath, namespace: "z" }),
        );
        expect(out.diagnosis).toBe("apiserver-message");
        expect(out.diagnosisDetail).toMatch(/BackendService/);
        expect(out.unknownFields).toEqual(["spec.scaling", "spec.wakeAhead"]);
    });
    it("reads map keys and array items as `*`, skips opaque nodes, and reports an unknown parent once", () => {
        const known = flattenSchemaPaths(
            obj({
                metadata: meta,
                spec: obj({
                    env: {
                        type: "object",
                        additionalProperties: { type: "string" },
                    },
                    ports: {
                        type: "array",
                        items: obj({ port: { type: "integer" } }),
                    },
                    blob: {
                        type: "object",
                        "x-kubernetes-preserve-unknown-fields": true,
                    },
                }),
            }),
        );
        const cr = {
            metadata: { name: "fn", labels: { a: "b" } },
            spec: {
                env: { FOO: "1", BAR: "2" },
                ports: [{ port: 1 }, { port: 2, name: "x" }],
                blob: { anything: { deep: 1 } },
                extra: { a: 1, b: { c: 2 } },
            },
        };
        expect(unknownFieldsOfCR(cr, known)).toEqual([
            "spec.extra",
            "spec.ports.*.name",
        ]);
    });

    it("a kind knext does not apply reads no schema, so the apiserver names the fields", () => {
        for (const kind of ["Widget", "constructor", "__proto__"]) {
            const { kubectl, calls } = fakeKubectl({
                openapi: true,
                crd: true,
            });
            const out = withCR({ ...CR, kind }, (crPath) =>
                preflightCRSchema({ kubectl }, { crPath, namespace: "z" }),
            );
            expect(out.diagnosis).toBe("apiserver-message");
            expect(calls.some((c) => c[1] === "get")).toBe(false);
        }
    });
});
